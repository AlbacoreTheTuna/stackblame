# Contributing

Thanks for helping. The project is intentionally small and dependency-free; please keep it that way.

## Setup

```sh
git clone https://github.com/AlbacoreTheTuna/stackblame
cd stackblame
npm test
```

Tests use Node's built-in runner. The end-to-end tests build a real git repository under your temp directory, so `git` must be on your PATH.

## Adding a trace format

This is the most common contribution.

1. Drop a real-world sample into `test/fixtures/<language>.txt`. Scrub anything private; keep the shape intact (indentation, tabs, `Caused by:` blocks, etc.).
2. Add a parser entry to the `PARSERS` array in `src/parse.js`:
   - `lang`: a short identifier.
   - `re`: the regex. Capture the file, line and (optionally) column and function.
   - `map(match, previousLine)`: return `{ file, line, column, func }`. Some formats (Go, Rust) put the function on the line *above*; that's what `previousLine` is for.
   - `guard(line)` (optional): a cheap pre-check if the regex is expensive or could collide with another language.
   - Order matters: more specific patterns go first, the generic `path:line` fallback stays last.
3. If the language prints the innermost frame last (like Python), add it to `INNERMOST_LAST`.
4. If the runtime has well-known vendor paths, extend `isVendorPath()` so they're skipped rather than reported as "not in repo".
5. Add a test in `test/parse.test.js` asserting the files, lines and functions, and the detected language.

## Project layout

```
bin/stackblame.js   CLI: argument parsing, I/O, exit codes
src/parse.js        trace → frames
src/resolve.js      frame paths → repo paths
src/git.js          git plumbing (blame, log -L, remotes)
src/rank.js         evidence → ranked suspects
src/report.js       terminal rendering
src/index.js        analyze(): ties it together; the public API
scripts/demo.js     regenerates docs/demo.svg
```

## Guidelines

- No runtime dependencies. Dev dependencies only if they pull serious weight.
- Every behaviour change comes with a test.
- Keep output deterministic: same repo + same trace → same result. Ranking weights live in one place (`src/rank.js`) and are documented in the README; if you tune them, update both.
- Run `npm run lint && npm test` before opening a PR.
