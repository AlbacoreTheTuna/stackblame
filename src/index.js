/**
 * Public API: analyze a stack trace against a git repository.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseTrace } from './parse.js';
import { Resolver } from './resolve.js';
import { rankSuspects } from './rank.js';
import {
  repoRoot, listFiles, blameLine, lineRangeHistory, fileHistory, isAncestor,
  remoteWebUrl, commitUrl, prUrl, prFromSubject, headSha, commitWithin, git, GitError,
} from './git.js';

export { parseTrace } from './parse.js';
export { Resolver } from './resolve.js';
export { rankSuspects } from './rank.js';
export { GitError } from './git.js';

/**
 * @param {string} text        raw stack trace
 * @param {object} [opts]
 * @param {string} [opts.cwd]        directory inside the repo (default: process.cwd())
 * @param {string} [opts.since]      only consider commits newer than this (git --since syntax or 7d/2w/3m)
 * @param {string} [opts.base]       only consider commits NOT reachable from this ref (e.g. "main")
 * @param {string} [opts.rev]        blame the code as of this revision (the deployed SHA)
 * @param {string[]} [opts.strip]    path prefixes to strip from trace paths (e.g. "/app")
 * @param {number} [opts.top]        number of suspects to return (default 5)
 * @param {number} [opts.context]    lines of code context around each frame (default 1)
 * @param {number} [opts.maxFrames]  frames to analyze (default 25)
 */
export async function analyze(text, opts = {}) {
  const {
    cwd = process.cwd(), since, base, rev, strip = [], top = 5, context = 1, maxFrames = 25,
  } = opts;

  const root = await repoRoot(cwd);
  if (!root) throw new GitError(`not a git repository: ${cwd}`);

  const { frames: parsed, lang } = parseTrace(text);
  const sinceGit = normalizeSince(since);

  const [files, web, head, names] = await Promise.all([listFiles(root), remoteWebUrl(root), headSha(root), projectNames(root)]);
  const resolver = new Resolver(files, { strip, names });

  const frames = parsed.slice(0, maxFrames).map((f, i) => {
    const r = resolver.resolve(f.file);
    return {
      depth: i,
      raw: f.raw,
      func: f.func,
      file: f.file,
      line: f.line,
      column: f.column,
      path: r.path,
      status: r.status,
      note: r.note ?? null,
      candidates: r.candidates ?? null,
      blame: null,
      context: null,
      evidence: [],
    };
  });

  await Promise.all(frames.filter((f) => f.path).map((f) => enrichFrame(root, f, { sinceGit, rev, context })));

  // --base: drop evidence that's already on the base branch (e.g. main).
  if (base) {
    const shas = new Set();
    for (const f of frames) for (const e of f.evidence) shas.add(e.commit.sha);
    const onBase = new Map(await Promise.all([...shas].map(async (s) => [s, await isAncestor(root, s, base)])));
    for (const f of frames) f.evidence = f.evidence.filter((e) => !onBase.get(e.commit.sha));
  }

  const suspects = rankSuspects(frames, { top }).map((s) => decorate(s, web));
  for (const f of frames) {
    if (f.blame?.sha) {
      f.blame.url = commitUrl(web, f.blame.sha);
      f.blame.pr = prFromSubject(f.blame.summary);
      f.blame.prUrl = prUrl(web, f.blame.pr);
    }
    delete f.evidence;
  }

  return {
    lang,
    repo: { root, web, head, rev: rev ?? null },
    options: { since: since ?? null, base: base ?? null, strip },
    frames,
    suspects,
    stats: {
      parsed: parsed.length,
      analyzed: frames.length,
      resolved: frames.filter((f) => f.path).length,
      vendor: frames.filter((f) => f.status === 'vendor').length,
      unresolved: frames.filter((f) => f.status === 'unresolved').length,
    },
  };
}

const NEAR = 3; // lines above/below the crash line that count as "nearby"

async function enrichFrame(root, f, { sinceGit, rev, context }) {
  const from = Math.max(1, f.line - NEAR);
  const to = f.line + NEAR;
  const [blame, rangeHist, fileHist, ctx] = await Promise.all([
    blameLine(root, f.path, f.line, rev),
    lineRangeHistory(root, f.path, from, to, { since: sinceGit, max: 15, rev }),
    fileHistory(root, f.path, { since: sinceGit, max: 10, rev }),
    readContext(root, f.path, f.line, context, rev),
  ]);

  f.blame = blame.error ? { error: blame.error } : blame;
  f.context = ctx;

  const seen = new Set();
  if (blame.sha && !blame.uncommitted) {
    seen.add(blame.sha);
    if (await commitWithin(root, blame.sha, sinceGit)) {
      f.evidence.push({
        kind: 'blame',
        commit: { sha: blame.sha, author: blame.author, email: blame.email, time: blame.time, subject: blame.summary },
      });
    } else {
      f.blame.outsideWindow = true;
    }
  }
  const offset = f.line - from; // crash line's offset inside the tracked window
  for (const c of rangeHist) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    const { changed, rangeStart, ...commit } = c;
    const crashAt = rangeStart === null ? null : rangeStart + offset;
    let distance = null;
    if (crashAt !== null && changed.length) {
      distance = Math.min(...changed.map((n) => Math.abs(n - crashAt)));
    }
    const kind = distance === 0 ? 'line' : 'near';
    f.evidence.push({ kind, commit, distance, changedLines: changed });
  }
  for (const c of fileHist) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    f.evidence.push({ kind: 'file', commit: c });
  }
}

async function readContext(root, file, line, n, rev) {
  if (n < 0) return null;
  let src;
  try {
    src = rev ? await git(root, ['show', `${rev}:${file}`]) : await readFile(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
  const lines = src.split('\n');
  if (line > lines.length) return { outOfRange: true, total: lines.length };
  const start = Math.max(1, line - n);
  const end = Math.min(lines.length, line + n);
  const out = [];
  for (let i = start; i <= end; i++) out.push({ n: i, code: lines[i - 1], hit: i === line });
  return out;
}

function decorate(s, web) {
  const c = s.commit;
  const pr = prFromSubject(c.subject);
  return {
    sha: c.sha,
    short: c.sha.slice(0, 7),
    author: c.author,
    email: c.email,
    time: c.time,
    ageDays: Number.isFinite(s.ageDays) ? Math.round(s.ageDays * 10) / 10 : null,
    subject: c.subject,
    pr,
    url: commitUrl(web, c.sha),
    prUrl: prUrl(web, pr),
    score: Math.round(s.score * 1000) / 1000,
    confidence: s.confidence,
    reasons: s.reasons,
  };
}

/**
 * Names this project might appear under inside a consumer's dependency tree:
 * the repo directory, package.json name (without scope), pyproject / Cargo /
 * go.mod names. Used to recognise node_modules/<name>/… frames as our own.
 */
export async function projectNames(root) {
  const names = new Set([path.basename(root)]);
  const read = async (f) => { try { return await readFile(path.join(root, f), 'utf8'); } catch { return ''; } };
  try {
    const pkg = JSON.parse(await read('package.json') || '{}');
    if (typeof pkg.name === 'string') {
      names.add(pkg.name);
      names.add(pkg.name.replace(/^@[^/]+\//, ''));
    }
  } catch { /* not JSON */ }
  const py = await read('pyproject.toml');
  for (const m of py.matchAll(/^\s*name\s*=\s*["']([^"']+)["']/gm)) { names.add(m[1]); names.add(m[1].replace(/-/g, '_')); }
  const cargo = await read('Cargo.toml');
  const cm = cargo.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  if (cm) { names.add(cm[1]); names.add(cm[1].replace(/-/g, '_')); }
  const gomod = await read('go.mod');
  const gm = gomod.match(/^module\s+(\S+)/m);
  if (gm) names.add(gm[1].split('/').pop());
  return [...names];
}

/** 7d / 2w / 3m / 1y → git --since syntax; anything else passes through. */
export function normalizeSince(s) {
  if (!s) return undefined;
  const m = String(s).trim().match(/^(\d+)\s*([hdwmy])$/i);
  if (!m) return s;
  const unit = { h: 'hours', d: 'days', w: 'weeks', m: 'months', y: 'years' }[m[2].toLowerCase()];
  return `${m[1]} ${unit} ago`;
}
