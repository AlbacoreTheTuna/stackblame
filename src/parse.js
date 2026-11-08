/**
 * Stack trace parsing for many languages.
 *
 * Every parser produces normalized frames:
 *   { file, line, column, func, lang, raw }
 *
 * `parseTrace()` returns frames ordered innermost-first (index 0 is the frame
 * closest to the crash), regardless of how the language prints them.
 */

const JS_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;

// Languages that print the innermost frame LAST (Python-style).
const INNERMOST_LAST = new Set(['python']);

/** @typedef {{file:string,line:number,column:number|null,func:string|null,lang:string,raw:string}} Frame */

const PARSERS = [
  // ---- Python -------------------------------------------------------------
  //   File "/app/orders/process.py", line 42, in charge
  {
    lang: 'python',
    re: /^\s*File "(.+?)", line (\d+)(?:, in (.+?))?\s*$/,
    map: (m) => ({ file: m[1], line: +m[2], column: null, func: m[3] ?? null }),
  },

  // ---- Java / Kotlin / Scala / Groovy -------------------------------------
  //   at com.example.orders.OrderService.charge(OrderService.java:42)
  //   at com.example.Foo$Bar.baz(Foo.kt:12)
  {
    lang: 'java',
    re: /^\s*at\s+([\w$.<>\[\]/]+)\(([\w$.\-]+\.(?:java|kt|kts|scala|groovy|clj)):(\d+)\)\s*$/,
    map: (m) => {
      // Turn the fully-qualified method into a package path hint so the
      // resolver can find src/main/java/com/example/orders/OrderService.java.
      const fq = m[1].replace(/^[\w.]+\//, ''); // drop JPMS module prefix (java.base/)
      const parts = fq.split('.');
      // Drop method name, then any inner-class / lambda suffixes on the class.
      parts.pop();
      let cls = parts.pop() ?? '';
      cls = cls.split('$')[0];
      const pkgPath = parts.length ? parts.join('/') + '/' : '';
      return { file: pkgPath + m[2], line: +m[3], column: null, func: fq, hint: { basename: m[2], cls } };
    },
  },

  // ---- C# / .NET ----------------------------------------------------------
  //   at Acme.Orders.OrderService.Charge(Order order) in /src/Orders/OrderService.cs:line 42
  {
    lang: 'csharp',
    re: /^\s*at\s+(.+?)\s+in\s+(.+?):line\s+(\d+)\s*$/,
    map: (m) => ({ file: m[2], line: +m[3], column: null, func: m[1] }),
  },

  // ---- Rust ---------------------------------------------------------------
  //   thread 'main' panicked at src/orders.rs:42:9:
  //      1: myapp::orders::charge
  //              at ./src/orders.rs:42:9
  {
    lang: 'rust',
    re: /panicked at\s+(\S+?\.rs):(\d+)(?::(\d+))?/,
    map: (m) => ({ file: m[1], line: +m[2], column: m[3] ? +m[3] : null, func: null }),
  },
  {
    lang: 'rust',
    re: /^\s*at\s+(\S+?\.rs):(\d+)(?::(\d+))?\s*$/,
    map: (m, prev) => ({ file: m[1], line: +m[2], column: m[3] ? +m[3] : null, func: rustFunc(prev) }),
  },

  // ---- Node / V8 ----------------------------------------------------------
  //   at charge (/app/src/orders/process.js:42:15)
  //   at async Object.<anonymous> (file:///app/src/index.mjs:9:3)
  //   at /app/src/orders/process.js:42:15
  {
    lang: 'javascript',
    re: /^\s*at\s+(?:(?:async\s+|new\s+)?(.+?)\s+\()?((?:file:\/\/|https?:\/\/|webpack(?:-internal)?:\/\/\/?|node:)?[^()\s][^()]*?):(\d+):(\d+)\)?\s*$/,
    map: (m) => ({ file: stripFileUrl(m[2]), line: +m[3], column: +m[4], func: m[1] ?? null }),
  },

  // ---- Firefox / Safari ---------------------------------------------------
  //   charge@http://localhost:3000/static/js/main.js:42:15
  //   @file:///app/src/x.js:1:2
  {
    lang: 'javascript',
    re: /^\s*(?:([^@\s]*)@)?((?:file:\/\/|https?:\/\/)?[^\s@]+?):(\d+):(\d+)\s*$/,
    guard: (l) => l.includes('@') && !/^\s*at\s/.test(l),
    map: (m) => ({ file: stripFileUrl(m[2]), line: +m[3], column: +m[4], func: m[1] || null }),
  },

  // ---- Ruby ---------------------------------------------------------------
  //   /app/lib/orders.rb:42:in `charge'
  //   from /app/lib/orders.rb:42:in 'Orders#charge'   (Ruby 3.4 quoting)
  {
    lang: 'ruby',
    re: /^\s*(?:from\s+)?(\S+?\.(?:rb|rake|erb|haml|slim)):(\d+)(?::in\s+[`'](.+?)')?(?:\s*$|:\s)/,
    map: (m) => ({ file: m[1], line: +m[2], column: null, func: m[3] ?? null }),
  },

  // ---- PHP ----------------------------------------------------------------
  //   #0 /app/src/Orders.php(42): Orders->charge()
  //   PHP Fatal error:  Uncaught RuntimeException: boom in /app/src/Orders.php:42
  //   thrown in /app/src/Orders.php on line 42
  {
    lang: 'php',
    re: /^#\d+\s+(\S+?\.(?:php|phtml))\((\d+)\):\s*(.+?)\s*$/,
    map: (m) => ({ file: m[1], line: +m[2], column: null, func: m[3] }),
  },
  {
    lang: 'php',
    re: /\bin\s+(\S+?\.(?:php|phtml))(?::(\d+)|\s+on\s+line\s+(\d+))\b/,
    map: (m) => ({ file: m[1], line: +(m[2] ?? m[3]), column: null, func: null }),
  },

  // ---- Go -----------------------------------------------------------------
  //   main.charge(0xc000010250)
  //   	/app/internal/orders/process.go:42 +0x1d
  {
    lang: 'go',
    re: /^\s*(\S+?\.go):(\d+)(?:\s+\+0x[0-9a-fA-F]+)?\s*$/,
    map: (m, prev) => ({ file: m[1], line: +m[2], column: null, func: goFunc(prev) }),
  },

  // ---- gdb / lldb (C, C++) ------------------------------------------------
  //   #3  0x000055555555513d in charge (o=0x0) at src/orders.c:42
  {
    lang: 'c',
    re: /^#\d+\s+(?:0x[0-9a-fA-F]+\s+in\s+)?(\S+)\s+\(.*?\)\s+at\s+(\S+?):(\d+)\s*$/,
    map: (m) => ({ file: m[2], line: +m[3], column: null, func: m[1] }),
  },

  // ---- Dart / Flutter -----------------------------------------------------
  //   #0      charge (package:myapp/orders.dart:42:5)
  //   #1      main (file:///app/bin/main.dart:9:3)
  {
    lang: 'dart',
    re: /^#\d+\s+(\S+)\s+\((?:package:[\w-]+\/|file:\/\/)?(\S+?\.dart):(\d+)(?::(\d+))?\)\s*$/,
    map: (m) => ({ file: m[2], line: +m[3], column: m[4] ? +m[4] : null, func: m[1] }),
  },

  // ---- Elixir / Erlang ----------------------------------------------------
  //   (my_app 0.1.0) lib/my_app/orders.ex:42: MyApp.Orders.charge/1
  {
    lang: 'elixir',
    re: /^\s*(?:\([\w.-]+(?:\s+[\d.]+\S*)?\)\s+)?(\S+?\.(?:ex|exs|erl)):(\d+):\s*(.+?)\s*$/,
    map: (m) => ({ file: m[1], line: +m[2], column: null, func: m[3] }),
  },

  // ---- Generic fallback ---------------------------------------------------
  // Anything that looks like path.ext:line[:col]. Catches Swift, Zig, Lua,
  // Perl ("at script.pl line 12" handled below), compiler output, etc.
  {
    lang: 'generic',
    re: /((?:[A-Za-z]:)?[\w@.\-\\/]+\.[A-Za-z0-9]{1,10}):(\d+)(?::(\d+))?(?![\d:])/,
    guard: (l) => !/^(?:[+-]{3}|@@)/.test(l) && !/^[+-](?![->])/.test(l) && !/https?:\/\//.test(l),
    map: (m) => ({ file: m[1], line: +m[2], column: m[3] ? +m[3] : null, func: null }),
  },
  // Perl:  at /app/orders.pl line 42.
  {
    lang: 'perl',
    re: /\bat\s+(\S+?\.(?:pl|pm|t))\s+line\s+(\d+)\b/,
    map: (m) => ({ file: m[1], line: +m[2], column: null, func: null }),
  },
];

function stripFileUrl(p) {
  if (p.startsWith('file://')) {
    p = p.slice(7);
    // file:///C:/x  → C:/x
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  }
  p = p.replace(/^webpack(?:-internal)?:\/\/\/?(?:\.\/)?/, '');
  return p;
}

function goFunc(prev) {
  if (!prev) return null;
  const m = prev.match(/^\s*(\S+)\(.*\)\s*$/);
  return m ? m[1] : null;
}

function rustFunc(prev) {
  if (!prev) return null;
  const m = prev.match(/^\s*\d+:\s+(?:0x[0-9a-f]+\s+-\s+)?(.+?)\s*$/);
  return m ? m[1] : null;
}

const PY_SECTION = /^Traceback \(most recent call last\):/;

/**
 * Parse raw trace text into frames (innermost first).
 * @param {string} text
 * @returns {{frames: Frame[], lang: string}}
 */
export function parseTrace(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {Array<Frame & {section:number}>} */
  const frames = [];
  const langVotes = new Map();
  let section = 0;
  let prev = '';

  for (const raw of lines) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, ''); // strip ANSI
    if (PY_SECTION.test(line)) section++;
    if (!line.trim()) { prev = line; continue; }

    for (const p of PARSERS) {
      if (p.guard && !p.guard(line)) continue;
      const m = line.match(p.re);
      if (!m) continue;
      const f = p.map(m, prev);
      if (!f || !f.file || !Number.isFinite(f.line) || f.line <= 0) continue;
      f.file = cleanPath(f.file);
      if (!f.file) continue;
      frames.push({ ...f, lang: p.lang, raw: line.trim(), section });
      if (p.lang !== 'generic') langVotes.set(p.lang, (langVotes.get(p.lang) ?? 0) + 1);
      break;
    }
    prev = line;
  }

  let lang = 'generic';
  let best = 0;
  for (const [l, n] of langVotes) if (n > best) { best = n; lang = l; }

  // Prefer frames tagged with the winning language if the generic parser also
  // matched other lines (e.g. a URL in the error message).
  let out = frames;
  if (lang !== 'generic') {
    const specific = frames.filter((f) => f.lang === lang);
    if (specific.length) out = specific;
  }

  // Normalize ordering to innermost-first.
  if (INNERMOST_LAST.has(lang)) {
    const sections = new Map();
    for (const f of out) {
      if (!sections.has(f.section)) sections.set(f.section, []);
      sections.get(f.section).push(f);
    }
    // Last section is the exception that propagated; its last frame is innermost.
    out = [...sections.keys()].sort((a, b) => b - a).flatMap((k) => sections.get(k).reverse());
  }

  // Deduplicate identical file:line (recursion) while preserving order.
  const seen = new Map();
  const deduped = [];
  for (const f of out) {
    const key = `${f.file}:${f.line}`;
    const { section: _s, hint: _h, ...rest } = f;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.func && rest.func) existing.func = rest.func;
      if (existing.column === null && rest.column !== null) existing.column = rest.column;
      continue;
    }
    seen.set(key, rest);
    deduped.push(rest);
  }

  return { frames: deduped, lang };
}

function cleanPath(p) {
  p = p.trim().replace(/^['"<(\[]+|['">)\]]+$/g, '');
  p = p.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  // Drop query strings / hashes from bundler URLs.
  p = p.replace(/[?#].*$/, '');
  return p;
}

/** Heuristic: frames in vendored / runtime code we never try to blame. */
export function isVendorPath(file) {
  return /(?:^|\/)(?:node_modules|site-packages|dist-packages|vendor\/bundle|gems|\.cargo\/registry|\.cargo\/git|go\/pkg\/mod|\.gradle\/caches|\.m2\/repository|\.nuget\/packages|__pycache__)\//.test(file)
    || /^(?:node:|internal\/|<anonymous>|<frozen|native|\[native code\]|\/rustc\/|\/usr\/lib\/|\/usr\/local\/lib\/python|\/usr\/local\/go\/|\/opt\/homebrew\/|\/usr\/share\/)/.test(file)
    || /^(?:java|javax|jdk|sun|kotlin|kotlinx|scala|org\/springframework|org\/junit|org\/apache|com\/google|io\/netty|reactor)\//.test(file)
    || /^(?:System|Microsoft)\//.test(file)
    || /^(?:std|core|alloc|tokio|hyper)::/.test(file);
}

export { JS_EXT };
