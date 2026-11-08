import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resolver } from '../src/resolve.js';

const files = [
  'src/orders/process.ts',
  'src/api/routes.ts',
  'src/index.ts',
  'packages/web/src/utils/format.ts',
  'packages/api/src/utils/format.ts',
  'app/orders/process.py',
  'app/api/routes.py',
  'services/billing/src/main/java/com/acme/shop/orders/OrderService.java',
  'services/billing/src/main/kotlin/com/acme/shop/api/OrderController.kt',
  'lib/orders/process.dart',
  'README.md',
];

test('exact repo-relative path', () => {
  const r = new Resolver(files);
  assert.deepEqual(r.resolve('src/orders/process.ts'), { path: 'src/orders/process.ts', status: 'exact' });
});

test('absolute container path resolves by longest unique suffix', () => {
  const r = new Resolver(files);
  assert.equal(r.resolve('/app/app/orders/process.py').path, 'app/orders/process.py');
  assert.equal(r.resolve('/usr/src/service/src/api/routes.ts').path, 'src/api/routes.ts');
});

test('--strip prefix is applied before matching', () => {
  const r = new Resolver(files, { strip: ['/app'] });
  assert.equal(r.resolve('/app/app/orders/process.py').status, 'exact');
});

test('Java package path finds the file deep inside a Maven layout', () => {
  const r = new Resolver(files);
  const res = r.resolve('com/acme/shop/orders/OrderService.java');
  assert.equal(res.path, 'services/billing/src/main/java/com/acme/shop/orders/OrderService.java');
  assert.equal(r.resolve('com/acme/shop/api/OrderController.kt').path, 'services/billing/src/main/kotlin/com/acme/shop/api/OrderController.kt');
});

test('ambiguous basename in a monorepo is reported, not guessed silently', () => {
  const r = new Resolver(files);
  const res = r.resolve('/build/utils/format.ts');
  assert.equal(res.status, 'suffix');
  assert.equal(res.candidates.length, 2);
  assert.match(res.note, /ambiguous/);
  // A more specific suffix disambiguates.
  assert.equal(r.resolve('/build/web/src/utils/format.ts').path, 'packages/web/src/utils/format.ts');
  assert.equal(r.resolve('/build/web/src/utils/format.ts').candidates, undefined);
});

test('compiled dist/*.js maps back to src/*.ts with a warning', () => {
  const r = new Resolver(files);
  const res = r.resolve('/usr/src/app/dist/orders/process.js');
  assert.equal(res.path, 'src/orders/process.ts');
  assert.equal(res.status, 'compiled');
  assert.match(res.note, /approximate/);
  assert.equal(r.resolve('/usr/src/app/dist/index.mjs').path, 'src/index.ts');
});

test('vendor and runtime paths are classified, not searched', () => {
  const r = new Resolver(files);
  assert.equal(r.resolve('/usr/src/app/node_modules/express/lib/router/layer.js').status, 'vendor');
  assert.equal(r.resolve('node:internal/process/task_queues').status, 'vendor');
});

test('unknown files are unresolved', () => {
  const r = new Resolver(files);
  assert.deepEqual(r.resolve('/somewhere/else.rb'), { path: null, status: 'unresolved' });
  assert.equal(r.resolve('http://localhost:3000/static/js/main.chunk.js').status, 'unresolved');
});

test('Dart package: paths resolve into lib/', () => {
  const r = new Resolver(files);
  assert.equal(r.resolve('orders/process.dart').path, 'lib/orders/process.dart');
});

test('a vendored copy of *this* project resolves when the package name matches', () => {
  const r = new Resolver(['lib/application.js', 'lib/router/index.js', 'package.json'], { names: ['express'] });
  const a = r.resolve('/usr/src/app/node_modules/express/lib/application.js');
  assert.equal(a.path, 'lib/application.js');
  assert.match(a.note, /vendored copy/);
  // pnpm layout
  assert.equal(r.resolve('/usr/src/app/node_modules/.pnpm/express@5.1.0/node_modules/express/lib/router/index.js').path, 'lib/router/index.js');
  // a different package stays vendor
  assert.equal(r.resolve('/usr/src/app/node_modules/koa/lib/application.js').status, 'vendor');
  // without names nothing changes
  assert.equal(new Resolver(['lib/application.js']).resolve('/x/node_modules/express/lib/application.js').status, 'vendor');
});

test('Python site-packages copy of this project resolves including the package dir', () => {
  const r = new Resolver(['src/flask/app.py', 'src/flask/json/__init__.py'], { names: ['flask'] });
  assert.equal(r.resolve('/usr/local/lib/python3.12/site-packages/flask/app.py').path, 'src/flask/app.py');
  assert.equal(r.resolve('/usr/local/lib/python3.12/site-packages/werkzeug/serving.py').status, 'vendor');
});
