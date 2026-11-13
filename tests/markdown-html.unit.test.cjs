'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { markdownToHtml } = require('../lib/markdown-html');

test('markdown views: a table keeps a pipe inside code, its alignment, figures set apart, short columns on one line', () => {
  const html = markdownToHtml('| run | `grep a|b` | loss | notes |\n|---|:-:|---|---|\n| held-out | yes | 0.41 | a sentence long enough to wrap in its cell |\n| tuned | no | 0.37 | — |');
  assert.match(html, /^<table><thead><tr><th class="nw">run<\/th><th class="nw" style="text-align:center"><code>grep a\|b<\/code><\/th><th class="num nw">loss<\/th><th class="wrap">notes<\/th>/);
  assert.match(html, /<td class="nw">held-out<\/td>/);
  assert.match(html, /<td class="num nw">0\.37<\/td><td class="wrap">—<\/td><\/tr><\/tbody><\/table>$/);
});

test('markdown views: nested and numbered lists, task boxes, code in a list', () => {
  const html = markdownToHtml('2. second\n  - a\n  - b\n3. third\n   ```\n   make test\n   ```\n\n- [x] trained\n- [ ] evaluated');
  assert.equal(html, [
    '<ol start="2"><li><p>second</p>\n<ul><li>a</li><li>b</li></ul></li><li><p>third</p>\n<pre class="code"><code>make test</code></pre></li></ol>',
    '<ul><li class="task"><input type="checkbox" disabled checked> trained</li><li class="task"><input type="checkbox" disabled> evaluated</li></ul>'
  ].join('\n'));
});

test('markdown views: nothing in the markdown becomes markup or a script link', () => {
  const html = markdownToHtml('<script>x()</script> [a](javascript:alert(1)) [b](data.csv) ![c](javascript:x) ![d](plot.png)\n\n> quoted **bold**');
  assert.ok(!/<script/.test(html));
  assert.match(html, /&lt;script&gt;x\(\)&lt;\/script&gt;/);
  assert.ok(!/javascript:/.test(html), html);
  assert.match(html, / a <a href="data.csv">b<\/a> c <img alt="d" src="plot.png">/);
  assert.match(html, /<blockquote><p>quoted <strong>bold<\/strong><\/p><\/blockquote>/);
});

test('lib/markdown.js is generated from the web parser and up to date', () => {
  const lib = fs.readFileSync(path.join(__dirname, '../lib/markdown.js'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, '../hay/apps/web/src/utils/markdown.ts'), 'utf8');
  const hash = crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
  assert.equal((/source-sha256: ([0-9a-f]+)/.exec(lib) || [])[1], hash,
    'hay/apps/web/src/utils/markdown.ts changed: run `node scripts/gen-markdown-lib.mjs`');
});
