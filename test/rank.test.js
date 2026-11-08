import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankSuspects, recencyWeight, depthWeight, distanceWeight } from '../src/rank.js';

const NOW = 1_800_000_000;
const DAY = 86400;
const commit = (sha, daysAgo, subject = sha) => ({ sha: sha.padEnd(40, '0'), author: 'a', email: 'a@x', time: NOW - daysAgo * DAY, subject });

test('weights are monotonic and bounded', () => {
  assert.ok(recencyWeight(0) > recencyWeight(30));
  assert.ok(recencyWeight(30) > recencyWeight(3000));
  assert.ok(recencyWeight(100000) >= 0.3);
  assert.equal(depthWeight(0), 1);
  assert.ok(depthWeight(0) > depthWeight(1) && depthWeight(1) > depthWeight(5));
  assert.ok(distanceWeight(0) > distanceWeight(1) && distanceWeight(1) > distanceWeight(3));
});

test('blame of the crash line outranks a file-level touch, even if older', () => {
  const frames = [
    { depth: 0, path: 'a.py', line: 5, evidence: [
      { kind: 'blame', commit: commit('aaa', 20) },
      { kind: 'file', commit: commit('bbb', 1) },
    ] },
  ];
  const s = rankSuspects(frames, { now: NOW });
  assert.equal(s[0].commit.sha.slice(0, 3), 'aaa');
  assert.equal(s[0].confidence, 100);
  assert.ok(s[1].confidence < 50);
});

test('a recent nearby edit beats an ancient blame', () => {
  const frames = [
    { depth: 0, path: 'a.py', line: 5, evidence: [
      { kind: 'blame', commit: commit('old', 900) },
      { kind: 'near', commit: commit('new', 1), distance: 1, changedLines: [4] },
    ] },
  ];
  const s = rankSuspects(frames, { now: NOW });
  assert.equal(s[0].commit.sha.slice(0, 3), 'new');
});

test('evidence across multiple frames accumulates', () => {
  const frames = [
    { depth: 0, path: 'a.py', line: 5, evidence: [{ kind: 'blame', commit: commit('x', 10) }, { kind: 'line', commit: commit('y', 10) }] },
    { depth: 1, path: 'b.py', line: 9, evidence: [{ kind: 'blame', commit: commit('y', 10) }] },
    { depth: 2, path: 'c.py', line: 1, evidence: [{ kind: 'blame', commit: commit('y', 10) }] },
  ];
  const s = rankSuspects(frames, { now: NOW });
  assert.equal(s[0].commit.sha.slice(0, 1), 'y');
  assert.equal(s[0].reasons.length, 3);
  assert.equal(s[0].reasons[0].kind, 'blame'); // strongest reason first
  assert.equal(s[0].reasons[0].file, 'b.py');
});

test('top limits results; reasons use the resolved path', () => {
  const frames = [{ depth: 0, file: '/app/a.py', path: 'a.py', line: 5, evidence: [1, 2, 3, 4, 5, 6].map((i) => ({ kind: 'file', commit: commit('c' + i, i) })) }];
  const s = rankSuspects(frames, { now: NOW, top: 2 });
  assert.equal(s.length, 2);
  assert.equal(s[0].reasons[0].file, 'a.py');
});

test('empty evidence yields no suspects', () => {
  assert.deepEqual(rankSuspects([{ depth: 0, path: 'a', line: 1, evidence: [] }]), []);
  assert.deepEqual(rankSuspects([]), []);
});
