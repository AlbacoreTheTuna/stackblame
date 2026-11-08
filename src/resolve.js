/**
 * Map file paths from a stack trace (which may be absolute, from a container,
 * from a build output directory, or just a bare Java class file name) onto
 * files that actually exist in the repository.
 */
import { isVendorPath } from './parse.js';

const BUILD_DIRS = ['dist', 'build', 'lib', 'out', 'esm', 'cjs', '.next/server', 'target/classes', 'bin'];
const SOURCE_DIRS = ['src', 'lib', 'app', ''];
const COMPILED_SWAPS = {
  js: ['ts', 'tsx', 'jsx', 'mts', 'cts', 'coffee', 'svelte', 'vue'],
  mjs: ['mts', 'ts'],
  cjs: ['cts', 'ts'],
};

export class Resolver {
  /**
   * @param {string[]} files repo-relative paths
   * @param {{strip?: string[]}} opts
   */
  constructor(files, { strip = [], names = [] } = {}) {
    this.files = files;
    this.set = new Set(files);
    this.strip = strip.map((s) => s.replace(/\\/g, '/').replace(/\/+$/, ''));
    /** project names (package.json name, repo dir, …) used to spot vendored copies of *this* project */
    this.names = new Set(names.filter(Boolean).map((n) => n.toLowerCase()));
    /** basename -> paths */
    this.byBase = new Map();
    for (const f of files) {
      const b = f.slice(f.lastIndexOf('/') + 1);
      if (!this.byBase.has(b)) this.byBase.set(b, []);
      this.byBase.get(b).push(f);
    }
  }

  /**
   * @returns {{path:string|null, status:'exact'|'suffix'|'compiled'|'vendor'|'unresolved', candidates?:string[], note?:string}}
   */
  resolve(frameFile) {
    let p = frameFile.replace(/\\/g, '/');

    // Apply --strip prefixes first (e.g. /app/, /usr/src/service/).
    for (const s of this.strip) {
      if (s && p.startsWith(s + '/')) p = p.slice(s.length + 1);
      else if (s && p.startsWith(s)) p = p.slice(s.length).replace(/^\/+/, '');
    }

    if (this.set.has(p)) return { path: p, status: 'exact' };

    const segs = p.split('/').filter(Boolean);

    if (isVendorPath(p)) {
      // A trace from a *consumer* of this project points into
      // node_modules/<name>/… or site-packages/<name>/…. If <name> is us,
      // resolve the remainder; otherwise it's genuinely third-party.
      const self = this._vendoredSelf(segs);
      if (self) return self;
      return { path: null, status: 'vendor' };
    }

    const bySuffix = this._suffixMatch(segs, 1);
    if (bySuffix) return bySuffix;

    // Compiled output → source (dist/orders.js → src/orders.ts).
    const compiled = this._compiledToSource(segs);
    if (compiled) return compiled;

    return { path: null, status: 'unresolved' };
  }

  /** Try progressively shorter suffixes: a/b/c/d.js → b/c/d.js → c/d.js → d.js */
  _suffixMatch(segs, from) {
    for (let i = from; i < segs.length; i++) {
      const suffix = segs.slice(i).join('/');
      const matches = this._endingWith(suffix);
      if (matches.length === 1) return { path: matches[0], status: 'suffix' };
      if (matches.length > 1) {
        // Ambiguous: prefer the shortest path (closest to repo root), but report.
        const sorted = [...matches].sort((a, b) => a.length - b.length);
        return { path: sorted[0], status: 'suffix', candidates: sorted, note: `ambiguous: ${sorted.length} files match ${suffix}` };
      }
    }
    return null;
  }

  _vendoredSelf(segs) {
    if (!this.names.size) return null;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!this.names.has(segs[i].toLowerCase())) continue;
      // node_modules/<name>/lib/x.js → lib/x.js ; site-packages/<name>/app.py → <name>/app.py
      for (const rest of [segs.slice(i + 1), segs.slice(i)]) {
        const joined = rest.join('/');
        if (this.set.has(joined)) return { path: joined, status: 'suffix', note: 'vendored copy of this project' };
        const m = rest.length >= 2 ? this._suffixMatch(rest, 0) : null;
        if (m && !m.candidates) return { ...m, note: 'vendored copy of this project' };
      }
    }
    return null;
  }

  _endingWith(suffix) {
    const base = suffix.slice(suffix.lastIndexOf('/') + 1);
    const cands = this.byBase.get(base);
    if (!cands) return [];
    return cands.filter((f) => f === suffix || f.endsWith('/' + suffix));
  }

  _compiledToSource(segs) {
    const base = segs[segs.length - 1];
    const dot = base.lastIndexOf('.');
    if (dot === -1) return null;
    const stem = base.slice(0, dot);
    const ext = base.slice(dot + 1).toLowerCase();
    const swaps = COMPILED_SWAPS[ext];
    if (!swaps) return null;

    // Path inside the build dir, if we can spot one.
    let rel = null;
    for (let i = 0; i < segs.length - 1; i++) {
      if (BUILD_DIRS.includes(segs[i]) || BUILD_DIRS.includes(segs.slice(i, i + 2).join('/'))) {
        rel = segs.slice(i + 1, -1);
        break;
      }
    }
    const relDirs = rel ?? segs.slice(0, -1);

    for (const sext of swaps) {
      const cands = this.byBase.get(`${stem}.${sext}`);
      if (!cands?.length) continue;
      // Prefer a candidate whose directory suffix matches the compiled one.
      for (let i = 0; i <= relDirs.length; i++) {
        const suffix = [...relDirs.slice(i), `${stem}.${sext}`].join('/');
        const m = cands.filter((f) => f === suffix || f.endsWith('/' + suffix));
        if (m.length) {
          const sorted = m.sort((a, b) => a.length - b.length);
          return { path: sorted[0], status: 'compiled', candidates: sorted, note: 'compiled output mapped to source; line numbers are approximate' };
        }
      }
    }
    void SOURCE_DIRS;
    return null;
  }
}
