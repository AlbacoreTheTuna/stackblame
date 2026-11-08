import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteToWeb, commitUrl, prUrl, prFromSubject } from '../src/git.js';
import { normalizeSince } from '../src/index.js';

test('remoteToWeb handles ssh, https and .git suffixes', () => {
  assert.equal(remoteToWeb('git@github.com:acme/shop.git'), 'https://github.com/acme/shop');
  assert.equal(remoteToWeb('ssh://git@gitlab.com/acme/group/shop.git'), 'https://gitlab.com/acme/group/shop');
  assert.equal(remoteToWeb('https://github.com/acme/shop'), 'https://github.com/acme/shop');
  assert.equal(remoteToWeb('https://user@bitbucket.org/acme/shop.git'), 'https://bitbucket.org/acme/shop');
  assert.equal(remoteToWeb('/local/path'), null);
});

test('commit and PR URLs per host', () => {
  assert.equal(commitUrl('https://github.com/a/b', 'abc'), 'https://github.com/a/b/commit/abc');
  assert.equal(commitUrl('https://gitlab.com/a/b', 'abc'), 'https://gitlab.com/a/b/-/commit/abc');
  assert.equal(commitUrl('https://bitbucket.org/a/b', 'abc'), 'https://bitbucket.org/a/b/commits/abc');
  assert.equal(prUrl('https://github.com/a/b', 12), 'https://github.com/a/b/pull/12');
  assert.equal(prUrl('https://gitlab.com/a/b', 12), 'https://gitlab.com/a/b/-/merge_requests/12');
  assert.equal(prUrl(null, 12), null);
  assert.equal(prUrl('https://github.com/a/b', null), null);
});

test('PR number extraction from common subject styles', () => {
  assert.equal(prFromSubject('Retry charge on timeout (#412)'), 412);
  assert.equal(prFromSubject('Merge pull request #77 from acme/fix'), 77);
  assert.equal(prFromSubject('Fix thing (!9)'), 9);
  assert.equal(prFromSubject("Merge branch 'fix' into 'main'\n\nSee merge request acme/shop!31"), 31);
  assert.equal(prFromSubject('No pr here'), null);
  assert.equal(prFromSubject(''), null);
});

test('normalizeSince shorthand', () => {
  assert.equal(normalizeSince('7d'), '7 days ago');
  assert.equal(normalizeSince('2w'), '2 weeks ago');
  assert.equal(normalizeSince('3m'), '3 months ago');
  assert.equal(normalizeSince('12h'), '12 hours ago');
  assert.equal(normalizeSince('2026-01-01'), '2026-01-01');
  assert.equal(normalizeSince(undefined), undefined);
});
