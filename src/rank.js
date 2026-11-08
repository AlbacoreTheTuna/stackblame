/**
 * Suspect ranking.
 *
 * Every commit that touched a crashing line (or its neighbourhood) collects
 * evidence. Evidence is weighted by:
 *   - frame depth   (innermost frames matter most)
 *   - evidence kind (blame of the crash line > earlier edit of that line >
 *                    edit of a nearby line > touched the file at all)
 *   - distance      (for nearby edits: closer lines count more)
 *   - recency       (a change from yesterday is more suspicious than one from 2019)
 *
 * Scores are relative: the top suspect is 100%, others are scaled to it.
 */

const KIND_WEIGHT = { blame: 1.0, line: 0.7, near: 0.55, file: 0.15 };
const KIND_ORDER = { blame: 0, line: 1, near: 2, file: 3 };

export function depthWeight(depth) {
  return 1 / Math.pow(depth + 1, 0.6);
}

export function recencyWeight(ageDays) {
  if (!Number.isFinite(ageDays)) return 0.4;
  // 1.0 today → ~0.55 at 45d → 0.3 floor for ancient commits
  return 0.3 + 0.7 * Math.exp(-Math.max(0, ageDays) / 45);
}

export function distanceWeight(distance) {
  if (distance === null || distance === undefined) return 0.6;
  return 1 / (1 + 0.5 * distance); // d=1 → 0.67, d=3 → 0.4
}

/**
 * @param {Array<{depth:number, file:string, path?:string, line:number, evidence:Array<{kind:'blame'|'line'|'near'|'file', commit:object, distance?:number|null, changedLines?:number[]}>}>} frames
 * @param {{now?:number, top?:number}} opts
 */
export function rankSuspects(frames, { now = Date.now() / 1000, top = 5 } = {}) {
  const suspects = new Map();

  for (const f of frames) {
    const file = f.path ?? f.file;
    for (const ev of f.evidence ?? []) {
      const c = ev.commit;
      if (!c?.sha) continue;
      const ageDays = c.time ? (now - c.time) / 86400 : NaN;
      let score = depthWeight(f.depth) * KIND_WEIGHT[ev.kind] * recencyWeight(ageDays);
      if (ev.kind === 'near') score *= distanceWeight(ev.distance);
      let s = suspects.get(c.sha);
      if (!s) {
        s = { commit: c, score: 0, ageDays, reasons: [] };
        suspects.set(c.sha, s);
      }
      s.score += score;
      s.reasons.push({ kind: ev.kind, file, line: f.line, depth: f.depth, distance: ev.distance ?? null, changedLines: ev.changedLines ?? null });
    }
  }

  const ranked = [...suspects.values()].sort((a, b) => b.score - a.score || a.ageDays - b.ageDays);
  const max = ranked[0]?.score || 1;
  for (const s of ranked) {
    s.confidence = Math.round((s.score / max) * 100);
    s.reasons.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.depth - b.depth);
    const seen = new Set();
    s.reasons = s.reasons.filter((r) => {
      const k = `${r.file}:${r.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return ranked.slice(0, top);
}
