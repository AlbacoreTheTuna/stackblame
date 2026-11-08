import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { analyze } from '../src/index.js';
import { render } from '../src/report.js';
import { makeRepo, PY_TRACE } from './helpers.js';

const BIN = new URL('../bin/stackblame.js', import.meta.url).pathname;

/** Run the CLI; resolves {stdout, stderr, code}. Rejects (with the same shape) on non-zero exit. */
function run(args, { cwd, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [BIN, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => (code === 0 ? resolve : reject)({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

test('analyze(): frames resolve, blame is correct, suspects ranked with reasons', async () => {
  const { root, shas } = makeRepo();
  const r = await analyze(PY_TRACE, { cwd: root });

  assert.equal(r.lang, 'python');
  assert.equal(r.repo.web, 'https://github.com/acme/shop');
  assert.equal(r.stats.parsed, 3);
  assert.equal(r.stats.resolved, 2);
  assert.equal(r.stats.vendor, 1);

  const [f0, f1, f2] = r.frames;
  assert.equal(f0.path, 'app/orders/process.py');
  assert.equal(f0.status, 'suffix');
  assert.equal(f0.blame.sha, shas.c1);
  assert.equal(f0.blame.author, 'Omer Cohen');
  assert.equal(f0.blame.code, '        raise ChargeError(order.id)');
  assert.equal(f0.blame.url, `https://github.com/acme/shop/commit/${shas.c1}`);
  assert.equal(f0.context.length, 3);
  assert.ok(f0.context[1].hit);
  assert.equal(f1.path, 'app/api/routes.py');
  assert.equal(f2.status, 'vendor');
  assert.equal(f2.blame, null);

  // c1 blamed on both frames → top. c2 and c3 each changed a line adjacent to the raise.
  const bySha = Object.fromEntries(r.suspects.map((s) => [s.sha, s]));
  assert.equal(r.suspects[0].sha, shas.c1);
  assert.equal(r.suspects[0].confidence, 100);
  assert.ok(bySha[shas.c2], 'Dana\'s commit is a suspect');
  assert.ok(bySha[shas.c3], 'Yossi\'s commit is a suspect');
  assert.equal(bySha[shas.c2].pr, 412);
  assert.equal(bySha[shas.c2].prUrl, 'https://github.com/acme/shop/pull/412');
  const near = bySha[shas.c2].reasons.find((x) => x.kind === 'near');
  assert.ok(near);
  assert.equal(near.distance, 1);
  assert.deepEqual(near.changedLines, [4]);
  assert.deepEqual(bySha[shas.c3].reasons.find((x) => x.kind === 'near').changedLines, [6]);
});

test('--since excludes old commits from suspects but keeps blame for reference', async () => {
  const { root, shas } = makeRepo();
  const r = await analyze(PY_TRACE, { cwd: root, since: '7d' });
  assert.ok(!r.suspects.some((s) => s.sha === shas.c1));
  assert.equal(r.suspects.length, 2);
  assert.equal(r.frames[0].blame.sha, shas.c1);
  assert.equal(r.frames[0].blame.outsideWindow, true);
});

test('--base drops commits already on the base branch', async () => {
  const { root, shas, git } = makeRepo();
  // main is at c3. Create a branch, add a commit that touches the crash line.
  git(['checkout', '-q', '-b', 'feature']);
  writeFileSync(path.join(root, 'app/orders/process.py'), [
    'MAX_RETRIES = 3',
    '',
    'def charge(order, attempt=0):',
    '    if attempt >= MAX_RETRIES:',
    '        raise ChargeError(order.id, attempt)',
    '    return gateway.charge(order.total, currency=order.currency)',
    '',
  ].join('\n'));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Include attempt in error'], {
    GIT_AUTHOR_NAME: 'Me', GIT_AUTHOR_EMAIL: 'me@acme.io', GIT_COMMITTER_NAME: 'Me', GIT_COMMITTER_EMAIL: 'me@acme.io',
  });
  const r = await analyze(PY_TRACE, { cwd: root, base: 'main' });
  assert.equal(r.suspects.length, 1);
  assert.equal(r.suspects[0].author, 'Me');
  assert.ok(!r.suspects.some((s) => [shas.c1, shas.c2, shas.c3].includes(s.sha)));
});

test('--rev blames the file as of an older revision', async () => {
  const { root, shas } = makeRepo();
  // At c1, line 4 was authored by Omer (c2 changed it later).
  const trace = 'Traceback (most recent call last):\n  File "/app/app/orders/process.py", line 4, in charge\n    if attempt > MAX_RETRIES:\nTypeError: x\n';
  const head = await analyze(trace, { cwd: root });
  assert.equal(head.frames[0].blame.sha, shas.c2);
  const old = await analyze(trace, { cwd: root, rev: shas.c1 });
  assert.equal(old.frames[0].blame.sha, shas.c1);
  assert.equal(old.frames[0].context[1].code, '    if attempt > MAX_RETRIES:');
  assert.equal(old.repo.rev, shas.c1);
});

test('uncommitted working-tree changes are flagged', async () => {
  const { root } = makeRepo();
  writeFileSync(path.join(root, 'app/orders/process.py'), 'x = 1\ny = 2\nz = 3\nw = 4\nraise Boom()\n');
  const r = await analyze(PY_TRACE, { cwd: root });
  assert.equal(r.frames[0].blame.uncommitted, true);
  assert.ok(!r.suspects.some((s) => /^0+$/.test(s.sha)));
});

test('line beyond end of file is reported, not crashed on', async () => {
  const { root } = makeRepo();
  const trace = '  File "/app/app/orders/process.py", line 999, in charge\n';
  const r = await analyze(trace, { cwd: root });
  assert.equal(r.frames[0].context.outOfRange, true);
  assert.ok(r.frames[0].blame.error);
  const text = render(r);
  assert.match(text, /beyond end of file/);
});

test('compiled JS frames map to TS source', async () => {
  const { root } = makeRepo();
  const trace = 'TypeError: boom\n    at charge (/usr/src/app/dist/orders.js:2:10)\n';
  const r = await analyze(trace, { cwd: root });
  assert.equal(r.frames[0].path, 'src/orders.ts');
  assert.equal(r.frames[0].status, 'compiled');
});

test('not a git repo → GitError', async () => {
  await assert.rejects(analyze(PY_TRACE, { cwd: '/' }), /not a git repository/);
});

test('render() produces readable plain-text output', async () => {
  const { root } = makeRepo();
  const r = await analyze(PY_TRACE, { cwd: root });
  const text = render(r, { color: false });
  assert.match(text, /^stackblame — 3 frames \(python\), 2 in this repo/);
  assert.match(text, /#0  app\/orders\/process\.py:5 in charge/);
  assert.match(text, /Omer Cohen\s+Add orders endpoint/);
  assert.match(text, /› 5 │         raise ChargeError\(order\.id\)/);
  assert.match(text, /\(vendor\/runtime, skipped\)/);
  assert.match(text, /Suspects\n  1\. [0-9a-f]{7}  ██████████ 100%/);
  assert.match(text, /changed code 1 line away from app\/orders\/process\.py:5 \(crash site\) \(line 4\)/);
  assert.match(text, /https:\/\/github\.com\/acme\/shop\/pull\/412/);
  assert.doesNotMatch(text, /\x1b\[/);
});

test('CLI: stdin, file, --json, exit codes', async () => {
  const { root } = makeRepo();
  const tracePath = path.join(root, 'trace.txt');
  writeFileSync(tracePath, PY_TRACE);

  const a = await run([tracePath], { cwd: root });
  assert.match(a.stdout, /Suspects/);
  assert.doesNotMatch(a.stdout, /\x1b\[/);

  const b = await run(['--json', '-C', root], { cwd: '/', input: PY_TRACE });
  const json = JSON.parse(b.stdout);
  assert.equal(json.stats.resolved, 2);
  assert.equal(json.suspects.length, 3);

  const c = await run(['--version']);
  assert.match(c.stdout, /^\d+\.\d+\.\d+/);

  const h = await run(['--help']);
  assert.match(h.stdout, /Usage/);

  await assert.rejects(run(['--bogus']), (e) => e.code === 2 && /unknown option/.test(e.stderr));
  await assert.rejects(run(['--top']), (e) => e.code === 2 && /missing value/.test(e.stderr));
  await assert.rejects(run(['-C', '/'], { input: PY_TRACE }), (e) => e.code === 1 && /not a git repository/.test(e.stderr));

  const empty = await run(['-C', root], { input: '' });
  assert.match(empty.stdout, /No stack frames recognized/);

  // Trace that parses but matches nothing in the repo → exit 3.
  await assert.rejects(run(['-C', root], { input: '  File "/elsewhere/nope.py", line 1, in x\n' }), (e) => e.code === 3);
});

test('projectNames() picks up package.json, pyproject, Cargo and go.mod', async () => {
  const { projectNames } = await import('../src/index.js');
  const { root } = makeRepo();
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/shop-api' }));
  writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "shop-core"\n');
  writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "shop_rs"\n');
  writeFileSync(path.join(root, 'go.mod'), 'module github.com/acme/shopgo\n\ngo 1.22\n');
  const names = await projectNames(root);
  for (const n of ['@acme/shop-api', 'shop-api', 'shop-core', 'shop_core', 'shop_rs', 'shopgo', path.basename(root)]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});
