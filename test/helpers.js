import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Build a small git repo with a realistic history:
 *   c1 (Feb 2026, Omer)  adds app/orders/process.py + app/api/routes.py + src/orders.ts
 *   c2 (3 days ago, Dana) changes the `if` line above the raise      (#412)
 *   c3 (18h ago, Yossi)   changes the `return` line below the raise  (#418)
 * Returns { root, shas: {c1,c2,c3}, now }.
 */
export function makeRepo({ remote = 'git@github.com:acme/shop.git' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'stackblame-'));
  const g = (args, env = {}) => execFileSync('git', args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commit = (msg, name, email, iso) => {
    const env = {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: iso,
    };
    g(['add', '-A']);
    g(['commit', '-q', '-m', msg], env);
    return g(['rev-parse', 'HEAD']);
  };
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  g(['init', '-q', '-b', 'main']);
  g(['config', 'commit.gpgsign', 'false']);
  if (remote) g(['remote', 'add', 'origin', remote]);

  mkdirSync(path.join(root, 'app/orders'), { recursive: true });
  mkdirSync(path.join(root, 'app/api'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'app/orders/process.py'), [
    'MAX_RETRIES = 3',
    '',
    'def charge(order, attempt=0):',
    '    if attempt > MAX_RETRIES:',
    '        raise ChargeError(order.id)',
    '    return gateway.charge(order.total)',
    '',
  ].join('\n'));
  writeFileSync(path.join(root, 'app/api/routes.py'), [
    'from app.orders.process import charge',
    '',
    'def create_order(req):',
    '    order = Order.from_request(req)',
    '    return charge(order)',
    '',
  ].join('\n'));
  writeFileSync(path.join(root, 'src/orders.ts'), 'export function charge(o: Order) {\n  return o.total;\n}\n');
  const c1 = commit('Add orders endpoint', 'Omer Cohen', 'omer@acme.io', '2026-02-10T10:00:00Z');

  writeFileSync(path.join(root, 'app/orders/process.py'), [
    'MAX_RETRIES = 3',
    '',
    'def charge(order, attempt=0):',
    '    if attempt >= MAX_RETRIES:',
    '        raise ChargeError(order.id)',
    '    return gateway.charge(order.total)',
    '',
  ].join('\n'));
  const c2 = commit('Retry charge on timeout (#412)', 'Dana Levi', 'dana@acme.io', iso(3 * 86400e3));

  writeFileSync(path.join(root, 'app/orders/process.py'), [
    'MAX_RETRIES = 3',
    '',
    'def charge(order, attempt=0):',
    '    if attempt >= MAX_RETRIES:',
    '        raise ChargeError(order.id)',
    '    return gateway.charge(order.total, currency=order.currency)',
    '',
  ].join('\n'));
  const c3 = commit('Pass currency to gateway (#418)', 'Yossi Ben', 'yossi@acme.io', iso(18 * 3600e3));

  return { root, shas: { c1, c2, c3 }, git: g };
}

export const PY_TRACE = `Traceback (most recent call last):
  File "/usr/local/lib/python3.12/site-packages/flask/app.py", line 1511, in wsgi_app
    response = self.full_dispatch_request()
  File "/app/app/api/routes.py", line 5, in create_order
    return charge(order)
  File "/app/app/orders/process.py", line 5, in charge
    raise ChargeError(order.id)
app.orders.errors.ChargeError: ord_8842
`;
