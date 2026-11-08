# Changelog

## 0.1.0

Initial release. Published on npm as `git-stackblame` (the bare name is blocked by npm's similarity check against `stackframe`); exposes both `stackblame` and `git-stackblame` binaries.

- Parse Node/browser JS, Python (incl. chained exceptions), Go, Java/Kotlin/Scala, Ruby, Rust, PHP, C#, C/C++ (gdb), Dart, Elixir, Perl, and generic `path:line` traces.
- Resolve container / build-output / Java-package paths to repo files by longest-unique-suffix match; map `dist/*.js` to `src/*.ts`.
- Blame each frame, collect nearby-line and file-level history, rank suspect commits with reasons.
- `--since`, `--base`, `--rev`, `--strip`, `--json`, color handling, exit codes.
