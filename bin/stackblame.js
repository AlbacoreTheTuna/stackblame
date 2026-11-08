#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { analyze } from '../src/index.js';
import { render, shouldColor } from '../src/report.js';

const { version } = createRequire(import.meta.url)('../package.json');

const HELP = `stackblame ${version} — git blame for stack traces

Usage
  stackblame [trace-file] [options]
  <command-that-crashes> 2>&1 | stackblame
  pbpaste | stackblame            # macOS clipboard
  xclip -o | stackblame           # Linux clipboard

Options
  --since <when>     only consider commits newer than this: 7d, 2w, 3m, 2026-01-01, "last monday"
  --base <ref>       only consider commits NOT already on <ref> (what did my branch change?)
  --rev <sha|tag>    blame the code as it was at this revision (the deployed build)
  --strip <prefix>   strip a path prefix from trace paths, e.g. --strip /app  (repeatable)
  --top <n>          number of suspects to show (default 5)
  --context <n>      lines of source context around each frame (default 1, 0 to hide)
  --max-frames <n>   frames to analyze (default 25)
  -C, --repo <dir>   run against this repository (default: current directory)
  --json             machine-readable output
  --color/--no-color force colors on/off (also respects NO_COLOR / FORCE_COLOR)
  -v, --version      print version
  -h, --help         this help

Examples
  stackblame crash.txt --since 7d
  kubectl logs api-7f9c | stackblame --strip /usr/src/app --rev v2.41.0
  npm test 2>&1 | stackblame --base main
`;

function parseArgs(argv) {
  const o = { strip: [], top: 5, context: 1, maxFrames: 25, color: undefined, json: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '--json') o.json = true;
    else if (a === '--color') o.color = true;
    else if (a === '--no-color') o.color = false;
    else if (a === '--since') o.since = next();
    else if (a.startsWith('--since=')) o.since = a.slice(8);
    else if (a === '--base') o.base = next();
    else if (a.startsWith('--base=')) o.base = a.slice(7);
    else if (a === '--rev' || a === '--at') o.rev = next();
    else if (a.startsWith('--rev=')) o.rev = a.slice(6);
    else if (a === '--strip') o.strip.push(next());
    else if (a.startsWith('--strip=')) o.strip.push(a.slice(8));
    else if (a === '--top') o.top = int(next(), a);
    else if (a.startsWith('--top=')) o.top = int(a.slice(6), a);
    else if (a === '--context') o.context = int(next(), a);
    else if (a.startsWith('--context=')) o.context = int(a.slice(10), a);
    else if (a === '--max-frames') o.maxFrames = int(next(), a);
    else if (a.startsWith('--max-frames=')) o.maxFrames = int(a.slice(13), a);
    else if (a === '-C' || a === '--repo') o.cwd = next();
    else if (a === '-') o.files.push('-');
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else o.files.push(a);
  }
  return o;
}

function int(v, flag) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid number for ${flag}: ${v}`);
  return n;
}

async function readInput(files) {
  if (files.length && files[0] !== '-') {
    const parts = await Promise.all(files.map((f) => readFile(f, 'utf8')));
    return parts.join('\n');
  }
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`stackblame: ${err.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (opts.help) { process.stdout.write(HELP); return; }
  if (opts.version) { process.stdout.write(version + '\n'); return; }

  const text = await readInput(opts.files);
  if (text === null) {
    process.stderr.write('stackblame: no input. Pipe a stack trace in, or pass a file.\n\n' + HELP);
    process.exit(2);
  }

  let result;
  try {
    result = await analyze(text, opts);
  } catch (err) {
    process.stderr.write(`stackblame: ${err.message}\n`);
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(render(result, { color: shouldColor({ color: opts.color }) }) + '\n');
  }
  // Exit 0 if we found suspects, 3 if the trace parsed but nothing matched the repo.
  if (result.frames.length && !result.stats.resolved) process.exit(3);
}

main();
