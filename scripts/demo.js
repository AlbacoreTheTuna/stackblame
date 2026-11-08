#!/usr/bin/env node
/**
 * Builds a throwaway repo with realistic history, runs stackblame on a crash,
 * and writes docs/demo.svg (a faithful rendering of the terminal output).
 *
 *   node scripts/demo.js            # writes docs/demo.svg
 *   node scripts/demo.js --print    # prints the colored output instead
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeRepo } from '../test/helpers.js';
import { analyze } from '../src/index.js';
import { render } from '../src/report.js';

const TRACE = `Traceback (most recent call last):
  File "/usr/local/lib/python3.12/site-packages/flask/app.py", line 1511, in wsgi_app
    response = self.full_dispatch_request()
  File "/app/app/api/routes.py", line 5, in create_order
    return charge(order)
  File "/app/app/orders/process.py", line 6, in charge
    return gateway.charge(order.total, currency=order.currency)
AttributeError: 'Order' object has no attribute 'currency'
`;

const { root } = makeRepo();
const result = await analyze(TRACE, { cwd: root, since: '90d' });
const prompt = '$ kubectl logs api-7f9c4 | stackblame --since 90d';
const text = render(result, { color: true, width: 90 });

if (process.argv.includes('--print')) {
  console.log(text);
} else {
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/demo.svg', ansiToSvg(`\x1b[2m${prompt}\x1b[22m\n${text}`));
  console.log('wrote docs/demo.svg');
}

// ---------------------------------------------------------------------------
// Minimal ANSI → SVG renderer (only what report.js emits).
function ansiToSvg(str) {
  const COLORS = { 31: '#ff6b6b', 32: '#8ce99a', 33: '#ffd43b', 34: '#74c0fc', 35: '#da77f2', 36: '#66d9e8', 90: '#868e96' };
  const FG = '#e9ecef';
  const DIM = '#868e96';
  const lines = str.split('\n');
  const lineH = 20;
  const charW = 8.43;
  const pad = 20;
  const maxCols = Math.max(...lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length));
  const width = Math.ceil(maxCols * charW + pad * 2);
  const height = lines.length * lineH + pad * 2 + 24;

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, ' ');
  let out = '';
  lines.forEach((line, i) => {
    let bold = false, dim = false, underline = false, color = null;
    let tspans = '';
    const re = /\x1b\[([0-9;]*)m/g;
    let last = 0, m;
    const flush = (txt) => {
      if (!txt) return;
      const fill = color ?? (dim ? DIM : FG);
      const style = `${bold ? 'font-weight:700;' : ''}${underline ? 'text-decoration:underline;' : ''}`;
      tspans += `<tspan fill="${fill}"${style ? ` style="${style}"` : ''}>${esc(txt)}</tspan>`;
    };
    while ((m = re.exec(line))) {
      flush(line.slice(last, m.index));
      last = re.lastIndex;
      for (const code of m[1].split(';').map(Number)) {
        if (code === 1) bold = true; else if (code === 22) { bold = false; dim = false; }
        else if (code === 2) dim = true; else if (code === 4) underline = true; else if (code === 24) underline = false;
        else if (code === 39) color = null; else if (COLORS[code]) color = COLORS[code]; else if (code === 0) { bold = dim = underline = false; color = null; }
      }
    }
    flush(line.slice(last));
    out += `<text x="${pad}" y="${pad + 24 + (i + 1) * lineH - 5}" xml:space="preserve">${tspans}</text>\n`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">
<rect width="100%" height="100%" rx="10" fill="#1b1f24"/>
<circle cx="${pad + 6}" cy="${pad - 2}" r="6" fill="#ff5f57"/><circle cx="${pad + 26}" cy="${pad - 2}" r="6" fill="#febc2e"/><circle cx="${pad + 46}" cy="${pad - 2}" r="6" fill="#28c840"/>
${out}</svg>
`;
}
