/**
 * Terminal rendering of an analysis result.
 */

export function makeStyle(enabled) {
  const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
    gray: wrap(90, 39),
    underline: wrap(4, 24),
  };
}

export function shouldColor({ color, stream = process.stdout, env = process.env } = {}) {
  if (color === true) return true;
  if (color === false) return false;
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

export function timeAgo(epochSec, now = Date.now() / 1000) {
  if (!epochSec) return 'unknown';
  const s = Math.max(0, now - epochSec);
  const units = [
    ['year', 365 * 86400], ['month', 30 * 86400], ['week', 7 * 86400],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [name, secs] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function bar(pct, width = 10) {
  const full = Math.round((pct / 100) * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

export function reasonText(r, c = makeStyle(false)) {
  const site = r.depth === 0 ? c.red(' (crash site)') : '';
  const loc = `${r.file}:${r.line}`;
  switch (r.kind) {
    case 'blame': return `last touched ${loc}${site}`;
    case 'line': return `previously changed ${loc}${site}`;
    case 'near': {
      const d = r.distance;
      const where = d === null ? 'nearby' : `${d} line${d === 1 ? '' : 's'} away`;
      const which = r.changedLines?.length ? ` (line${r.changedLines.length === 1 ? '' : 's'} ${r.changedLines.slice(0, 4).join(', ')}${r.changedLines.length > 4 ? '…' : ''})` : '';
      return `changed code ${where} from ${loc}${site}${c.dim(which)}`;
    }
    default: return `changed the file of ${loc}${site}`;
  }
}

/**
 * @param {object} result  from analyze()
 * @param {{color?:boolean, now?:number, width?:number}} opts
 */
export function render(result, { color = false, now = Date.now() / 1000, width = 100 } = {}) {
  const c = makeStyle(color);
  const out = [];
  const { frames, suspects, stats, lang, repo } = result;

  const where = repo.rev ? ` at ${c.cyan(repo.rev)}` : '';
  out.push(`${c.bold('stackblame')} ${c.dim('—')} ${stats.parsed} frame${stats.parsed === 1 ? '' : 's'} (${lang}), ${stats.resolved} in this repo${where}`);
  if (result.options.since) out.push(c.dim(`  window: commits since ${result.options.since}`));
  if (result.options.base) out.push(c.dim(`  only commits not on ${result.options.base}`));
  out.push('');

  if (!frames.length) {
    out.push(c.yellow('No stack frames recognized in the input.'));
    out.push(c.dim('Supported: Node/browser JS, Python, Go, Java/Kotlin, Ruby, Rust, PHP, C#, C/C++ (gdb), Dart, Elixir, Perl, and generic path:line.'));
    return out.join('\n');
  }

  for (const f of frames) {
    const n = c.dim(`#${f.depth}`.padStart(3));
    const fn = f.func ? c.dim(` in ${truncate(f.func, 50)}`) : '';
    if (!f.path) {
      const why = f.status === 'vendor' ? 'vendor/runtime' : 'not in repo';
      out.push(`${n}  ${c.gray(truncate(f.file, 70))}${c.gray(':' + f.line)}  ${c.dim(`(${why}, skipped)`)}`);
      continue;
    }
    const loc = `${c.bold(f.path)}${c.dim(':' + f.line)}`;
    out.push(`${n}  ${loc}${fn}`);
    if (f.note) out.push(`      ${c.yellow('⚠ ' + f.note)}`);

    const b = f.blame;
    if (!b || b.error) {
      out.push(`      ${c.yellow('blame unavailable' + (b?.error ? `: ${b.error}` : ''))}`);
    } else if (b.uncommitted) {
      out.push(`      ${c.magenta('uncommitted change')}  ${c.dim('this line is modified in the working tree')}`);
    } else {
      const old = b.outsideWindow ? c.dim('  (older than window)') : '';
      out.push(`      ${c.yellow(b.sha.slice(0, 7))}  ${pad(timeAgo(b.time, now), 14)} ${pad(truncate(b.author, 20), 20)} ${truncate(b.summary, 60)}${old}`);
    }
    if (Array.isArray(f.context)) {
      const w = String(f.context[f.context.length - 1].n).length;
      for (const l of f.context) {
        const num = String(l.n).padStart(w);
        const code = truncate(l.code.replace(/\t/g, '    '), width - 12);
        out.push(l.hit ? `      ${c.red('›')} ${c.bold(num)} ${c.dim('│')} ${code}` : `        ${c.dim(num)} ${c.dim('│')} ${c.dim(code)}`);
      }
    } else if (f.context?.outOfRange) {
      out.push(`      ${c.yellow(`⚠ line ${f.line} is beyond end of file (${f.context.total} lines) — trace may be from a different revision; try --rev <sha>`)}`);
    }
  }

  out.push('');
  out.push(c.bold('Suspects'));
  if (!suspects.length) {
    out.push(c.dim('  none — no commits matched the frames in this repo' + (result.options.since || result.options.base ? ' within the given window' : '')));
    return out.join('\n');
  }
  suspects.forEach((s, i) => {
    out.push(`  ${c.bold(String(i + 1) + '.')} ${c.yellow(s.short)}  ${bar(s.confidence)} ${String(s.confidence).padStart(3)}%  ${pad(timeAgo(s.time, now), 14)} ${pad(truncate(s.author, 20), 20)} ${truncate(s.subject, 60)}`);
    for (const r of s.reasons.slice(0, 3)) {
      out.push(`       ${c.dim('→')} ${reasonText(r, c)}`);
    }
    if (s.reasons.length > 3) out.push(`       ${c.dim(`→ … and ${s.reasons.length - 3} more`)}`);
    const link = s.prUrl ?? s.url;
    if (link) out.push(`       ${c.dim(c.underline(link))}`);
  });
  return out.join('\n');
}
