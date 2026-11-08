import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo, shouldColor, makeStyle, reasonText, render } from '../src/report.js';

test('timeAgo', () => {
  const now = 1_800_000_000;
  assert.equal(timeAgo(now - 10, now), 'just now');
  assert.equal(timeAgo(now - 60, now), '1 minute ago');
  assert.equal(timeAgo(now - 3 * 3600, now), '3 hours ago');
  assert.equal(timeAgo(now - 86400, now), '1 day ago');
  assert.equal(timeAgo(now - 8 * 86400, now), '1 week ago');
  assert.equal(timeAgo(now - 65 * 86400, now), '2 months ago');
  assert.equal(timeAgo(now - 800 * 86400, now), '2 years ago');
  assert.equal(timeAgo(undefined, now), 'unknown');
});

test('shouldColor honours flags and env', () => {
  assert.equal(shouldColor({ color: true, env: { NO_COLOR: '1' } }), true);
  assert.equal(shouldColor({ color: false, env: { FORCE_COLOR: '1' } }), false);
  assert.equal(shouldColor({ env: { NO_COLOR: '1' }, stream: { isTTY: true } }), false);
  assert.equal(shouldColor({ env: { FORCE_COLOR: '1' }, stream: { isTTY: false } }), true);
  assert.equal(shouldColor({ env: {}, stream: { isTTY: true } }), true);
  assert.equal(shouldColor({ env: { TERM: 'dumb' }, stream: { isTTY: true } }), false);
  assert.equal(shouldColor({ env: {}, stream: { isTTY: false } }), false);
});

test('makeStyle is a no-op when disabled', () => {
  assert.equal(makeStyle(false).red('x'), 'x');
  assert.equal(makeStyle(true).red('x'), '\x1b[31mx\x1b[39m');
});

test('reasonText variants', () => {
  assert.equal(reasonText({ kind: 'blame', file: 'a.py', line: 5, depth: 0 }), 'last touched a.py:5 (crash site)');
  assert.equal(reasonText({ kind: 'line', file: 'a.py', line: 5, depth: 2 }), 'previously changed a.py:5');
  assert.equal(reasonText({ kind: 'near', file: 'a.py', line: 5, depth: 0, distance: 2, changedLines: [3, 7] }), 'changed code 2 lines away from a.py:5 (crash site) (lines 3, 7)');
  assert.equal(reasonText({ kind: 'file', file: 'a.py', line: 5, depth: 1 }), 'changed the file of a.py:5');
});

test('render handles an empty result', () => {
  const text = render({ lang: 'generic', repo: {}, options: {}, frames: [], suspects: [], stats: { parsed: 0, resolved: 0 } });
  assert.match(text, /No stack frames recognized/);
});
