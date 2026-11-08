import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTrace, isVendorPath } from '../src/parse.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const loc = (f) => `${f.file}:${f.line}`;

test('Node/V8 trace: functions, async frames, file:// URLs, bare paths', () => {
  const { frames, lang } = parseTrace(fx('node.txt'));
  assert.equal(lang, 'javascript');
  assert.deepEqual(frames.map(loc), [
    '/usr/src/app/dist/orders/process.js:42',
    '/usr/src/app/dist/api/routes.js:88',
    '/usr/src/app/node_modules/express/lib/router/layer.js:95',
    'node:internal/process/task_queues:95',
    '/usr/src/app/dist/index.mjs:9',
    '/usr/src/app/dist/boot.js:12',
  ]);
  assert.equal(frames[0].func, 'charge');
  assert.equal(frames[0].column, 31);
  assert.equal(frames[1].func, 'createOrder'); // "async " prefix stripped
  assert.equal(frames[5].func, null);
});

test('Firefox/Safari trace: fn@url:line:col', () => {
  const { frames, lang } = parseTrace(fx('browser.txt'));
  assert.equal(lang, 'javascript');
  assert.equal(frames.length, 3);
  assert.equal(frames[0].func, 'charge');
  assert.equal(frames[0].line, 1423);
  assert.equal(frames[2].func, null);
});

test('Python traceback is reordered innermost-first', () => {
  const { frames, lang } = parseTrace(fx('python.txt'));
  assert.equal(lang, 'python');
  assert.deepEqual(frames.map(loc), [
    '/app/app/orders/process.py:42',
    '/app/app/api/routes.py:88',
    '/usr/local/lib/python3.12/site-packages/flask/app.py:1511',
  ]);
  assert.equal(frames[0].func, 'charge');
});

test('Python chained exceptions: propagated traceback first, then the cause', () => {
  const { frames } = parseTrace(fx('python-chained.txt'));
  assert.deepEqual(frames.map(loc), [
    '/app/app/db.py:12',
    '/app/app/main.py:21',
    '/app/app/main.py:30',
    '/app/app/db.py:10',
  ]);
});

test('Go panic: function names with receivers, stdlib frames kept', () => {
  const { frames, lang } = parseTrace(fx('go.txt'));
  assert.equal(lang, 'go');
  assert.equal(frames[0].file, '/go/src/github.com/acme/shop/internal/orders/process.go');
  assert.equal(frames[0].line, 42);
  assert.equal(frames[0].func, 'github.com/acme/shop/internal/orders.(*Service).Charge');
  assert.equal(frames[3].func, 'main.main');
});

test('Java/Kotlin: package path reconstructed, inner classes and modules handled', () => {
  const { frames, lang } = parseTrace(fx('java.txt'));
  assert.equal(lang, 'java');
  assert.equal(frames[0].file, 'com/acme/shop/orders/OrderService.java');
  assert.equal(frames[1].file, 'com/acme/shop/orders/OrderService.java'); // OrderService$Retry
  assert.equal(frames[1].line, 71);
  assert.equal(frames[2].file, 'com/acme/shop/api/OrderController.kt');
  assert.equal(frames[4].file, 'java/lang/Thread.java'); // java.base/ module prefix dropped
  assert.equal(frames[5].file, 'com/acme/shop/orders/Money.java'); // Caused by:
});

test('Ruby: first line and "from" lines, both quoting styles', () => {
  const { frames, lang } = parseTrace(fx('ruby.txt'));
  assert.equal(lang, 'ruby');
  assert.equal(frames[0].file, '/app/lib/orders/process.rb');
  assert.equal(frames[0].func, 'charge');
  assert.equal(frames[1].func, 'create');
  assert.equal(frames[2].func, 'ActionController::BasicImplicitRender#send_action');
});

test('Rust: panic location is frame 0 and merges with the backtrace frame', () => {
  const { frames, lang } = parseTrace(fx('rust.txt'));
  assert.equal(lang, 'rust');
  assert.equal(loc(frames[0]), 'src/orders/process.rs:42');
  assert.equal(frames[0].column, 9);
  assert.equal(frames[0].func, 'shop::orders::process::charge');
  assert.equal(frames.at(-1).func, 'shop::main');
});

test('PHP: throw site first, then #n frames', () => {
  const { frames, lang } = parseTrace(fx('php.txt'));
  assert.equal(lang, 'php');
  assert.equal(loc(frames[0]), '/var/www/html/src/Orders/Process.php:42');
  assert.equal(loc(frames[1]), '/var/www/html/src/Api/Routes.php:88');
  assert.equal(frames[1].func, 'Acme\\Orders\\Process->charge(Object(Acme\\Orders\\Order))');
  assert.equal(frames.length, 4); // "thrown in ... on line 42" deduped with frame 0
});

test('C#: "in file:line N" frames', () => {
  const { frames, lang } = parseTrace(fx('csharp.txt'));
  assert.equal(lang, 'csharp');
  assert.equal(loc(frames[0]), '/src/Shop/Orders/OrderService.cs:42');
  assert.equal(frames[0].func, 'Acme.Shop.Orders.OrderService.Charge(Order order)');
  assert.equal(frames.length, 3); // framework frame without file is skipped
});

test('gdb backtrace', () => {
  const { frames, lang } = parseTrace(fx('gdb.txt'));
  assert.equal(lang, 'c');
  assert.deepEqual(frames.map(loc), ['src/orders/process.c:42', 'src/api/routes.c:88', 'src/main.c:17']);
  assert.equal(frames[1].func, 'create_order');
});

test('Dart: package: and file:// URIs', () => {
  const { frames, lang } = parseTrace(fx('dart.txt'));
  assert.equal(lang, 'dart');
  assert.equal(loc(frames[0]), 'orders/process.dart:42');
  assert.equal(loc(frames[2]), '/app/bin/main.dart:17');
});

test('Elixir', () => {
  const { frames, lang } = parseTrace(fx('elixir.txt'));
  assert.equal(lang, 'elixir');
  assert.equal(loc(frames[0]), 'lib/shop/orders/process.ex:42');
  assert.equal(frames[0].func, 'Shop.Orders.Process.charge/1');
});

test('generic path:line:col fallback ignores URLs', () => {
  const { frames, lang } = parseTrace(fx('generic.txt'));
  assert.equal(lang, 'generic');
  assert.deepEqual(frames.map(loc), ['src/orders/process.swift:42', 'src/api/routes.swift:88']);
});

test('ANSI escape codes and CRLF are tolerated', () => {
  const text = '\x1b[31mError\x1b[0m\r\n    at \x1b[1mcharge\x1b[22m (/app/src/x.js:4:2)\r\n';
  const { frames } = parseTrace(text);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].func, 'charge');
  assert.equal(frames[0].file, '/app/src/x.js');
});

test('Windows paths and webpack URLs are normalized', () => {
  const { frames } = parseTrace([
    '    at charge (C:\\work\\shop\\src\\orders.ts:12:3)',
    '    at run (webpack-internal:///./src/api/routes.ts:88:5)',
    '    at boot (file:///C:/work/shop/src/boot.ts:1:1)',
  ].join('\n'));
  assert.equal(frames[0].file, 'C:/work/shop/src/orders.ts');
  assert.equal(frames[1].file, 'src/api/routes.ts');
  assert.equal(frames[2].file, 'C:/work/shop/src/boot.ts');
});

test('empty and garbage input', () => {
  assert.deepEqual(parseTrace('').frames, []);
  assert.deepEqual(parseTrace('hello world\nnothing here').frames, []);
  assert.deepEqual(parseTrace(null).frames, []);
});

test('isVendorPath', () => {
  assert.ok(isVendorPath('/usr/src/app/node_modules/express/lib/router/layer.js'));
  assert.ok(isVendorPath('/usr/local/lib/python3.12/site-packages/flask/app.py'));
  assert.ok(isVendorPath('node:internal/process/task_queues'));
  assert.ok(isVendorPath('/usr/local/go/src/net/http/server.go'));
  assert.ok(isVendorPath('/rustc/abc/library/std/src/panicking.rs'));
  assert.ok(isVendorPath('java/lang/Thread.java'));
  assert.ok(isVendorPath('org/springframework/web/Foo.java'));
  assert.ok(!isVendorPath('src/orders/process.go'));
  assert.ok(!isVendorPath('com/acme/shop/OrderService.java'));
});
