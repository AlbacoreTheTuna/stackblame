/**
 * Thin, dependency-free wrappers around the git CLI.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const US = '\x1f'; // unit separator
const RS = '\x1e'; // record separator

export class GitError extends Error {}

/**
 * Run git in `cwd`. Resolves with stdout; rejects with GitError.
 */
export async function git(cwd, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    return stdout;
  } catch (err) {
    if (allowFail) return '';
    const msg = (err.stderr || err.message || '').toString().trim();
    throw new GitError(msg || `git ${args[0]} failed`);
  }
}

export async function repoRoot(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
}

/** All tracked files (plus untracked-but-not-ignored), as repo-relative paths. */
export async function listFiles(root) {
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return out.split('\0').filter(Boolean);
}

/** Parse `git blame --porcelain` for a single line. */
export async function blameLine(root, file, line, rev) {
  const args = ['blame', '--porcelain', '-L', `${line},${line}`];
  if (rev) args.push(rev);
  args.push('--', file);
  let out;
  try {
    out = await git(root, args);
  } catch (err) {
    return { error: err.message };
  }
  const lines = out.split('\n');
  const head = lines[0]?.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
  if (!head) return { error: 'unparseable blame output' };
  const info = { sha: head[1], origLine: +head[2] };
  for (const l of lines.slice(1)) {
    if (l.startsWith('\t')) { info.code = l.slice(1); break; }
    const sp = l.indexOf(' ');
    const k = sp === -1 ? l : l.slice(0, sp);
    const v = sp === -1 ? '' : l.slice(sp + 1);
    if (k === 'author') info.author = v;
    else if (k === 'author-mail') info.email = v.replace(/^<|>$/g, '');
    else if (k === 'author-time') info.time = +v;
    else if (k === 'summary') info.summary = v;
    else if (k === 'filename') info.origFile = v;
    else if (k === 'boundary') info.boundary = true;
  }
  info.uncommitted = /^0{40}$/.test(info.sha);
  return info;
}

/**
 * Commits that changed the content of `line` in `file`, newest first
 * (git follows the line across edits).
 */
export async function lineHistory(root, file, line, { since, max = 20, rev } = {}) {
  const args = ['log', `-L${line},${line}:${file}`, '--no-patch', `--format=%H${US}%an${US}%ae${US}%at${US}%s${RS}`, `-n${max}`];
  if (since) args.push(`--since=${since}`);
  if (rev) args.push(rev);
  const out = await git(root, args, { allowFail: true });
  return parseCommits(out);
}

/**
 * Commits that changed anything in lines [from, to] of `file`, newest first,
 * each with the (new-side) line numbers it touched inside the tracked range.
 * `rangeStart` is where git placed the tracked range in that commit's version
 * of the file, so callers can translate a HEAD line into that commit's numbering.
 */
export async function lineRangeHistory(root, file, from, to, { since, max = 20, rev } = {}) {
  const args = ['log', `-L${from},${to}:${file}`, `--format=${RS}%H${US}%an${US}%ae${US}%at${US}%s`, `-n${max}`];
  if (since) args.push(`--since=${since}`);
  if (rev) args.push(rev);
  const out = await git(root, args, { allowFail: true });
  const records = out.split(RS).filter((r) => r.trim());
  const commits = [];
  for (const rec of records) {
    const nl = rec.indexOf('\n');
    const header = nl === -1 ? rec : rec.slice(0, nl);
    const body = nl === -1 ? '' : rec.slice(nl + 1);
    const [sha, author, email, time, subject] = header.split(US);
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) continue;
    const changed = new Set();
    let rangeStart = null;
    let cur = null;
    for (const l of body.split('\n')) {
      const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (h) { cur = +h[1]; if (rangeStart === null) rangeStart = cur; continue; }
      if (cur === null) continue;
      if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) continue;
      if (l.startsWith('+')) { changed.add(cur); cur++; }
      else if (l.startsWith('-')) { changed.add(cur); }
      else if (l.startsWith(' ') || l === '') { cur++; }
    }
    commits.push({ sha, author, email, time: +time, subject: (subject ?? '').trim(), changed: [...changed].sort((a, b) => a - b), rangeStart });
  }
  return commits;
}

/** Commits touching `file` at all (weaker signal), newest first. */
export async function fileHistory(root, file, { since, max = 30, rev } = {}) {
  const args = ['log', `--format=%H${US}%an${US}%ae${US}%at${US}%s${RS}`, `-n${max}`];
  if (since) args.push(`--since=${since}`);
  if (rev) args.push(rev);
  args.push('--', file);
  const out = await git(root, args, { allowFail: true });
  return parseCommits(out);
}

export async function commitInfo(root, sha) {
  const out = await git(root, ['show', '-s', `--format=%H${US}%an${US}%ae${US}%at${US}%s${RS}`, sha], { allowFail: true });
  return parseCommits(out)[0] ?? null;
}

/** Is `sha` already contained in `base` (e.g. main)? */
export async function isAncestor(root, sha, base) {
  try {
    await git(root, ['merge-base', '--is-ancestor', sha, base]);
    return true;
  } catch {
    return false;
  }
}

/** Is commit `sha` newer than `since` (git --since syntax)? */
export async function commitWithin(root, sha, since) {
  if (!since) return true;
  const out = await git(root, ['log', '-1', `--since=${since}`, '--format=%H', sha], { allowFail: true });
  return out.trim() === sha;
}

export async function headSha(root) {
  return (await git(root, ['rev-parse', 'HEAD'], { allowFail: true })).trim() || null;
}

/** Best-effort web URL base for commits, from `origin`. */
export async function remoteWebUrl(root) {
  const raw = (await git(root, ['remote', 'get-url', 'origin'], { allowFail: true })).trim();
  if (!raw) return null;
  return remoteToWeb(raw);
}

export function remoteToWeb(raw) {
  let m = raw.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = raw.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

/** Build a commit URL for GitHub / GitLab / Bitbucket style hosts. */
export function commitUrl(webBase, sha) {
  if (!webBase) return null;
  if (/bitbucket\.org/.test(webBase)) return `${webBase}/commits/${sha}`;
  if (/gitlab/.test(webBase)) return `${webBase}/-/commit/${sha}`;
  return `${webBase}/commit/${sha}`;
}

export function prUrl(webBase, pr) {
  if (!webBase || !pr) return null;
  if (/gitlab/.test(webBase)) return `${webBase}/-/merge_requests/${pr}`;
  if (/bitbucket\.org/.test(webBase)) return `${webBase}/pull-requests/${pr}`;
  return `${webBase}/pull/${pr}`;
}

/** Extract a PR / MR number from a commit subject (squash + merge styles). */
export function prFromSubject(subject) {
  if (!subject) return null;
  const m = subject.match(/\(#(\d+)\)\s*$/) || subject.match(/^Merge pull request #(\d+)/)
    || subject.match(/^Merge branch .* into .*!(\d+)/) || subject.match(/See merge request .*!(\d+)/)
    || subject.match(/\(!(\d+)\)\s*$/);
  return m ? +m[1] : null;
}

function parseCommits(out) {
  return out
    .split(RS)
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, author, email, time, subject] = r.split(US);
      return { sha, author, email, time: +time, subject: (subject ?? '').trim() };
    })
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha));
}
