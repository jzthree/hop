// Files from a session: what its agent wrote or named, from its own record —
// the Views shelf. Which paths count, which are kept out, how they resolve.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathsInText, patchedFiles, refsFromRecord, refsFromLines, resolveRef, allowedPath, collect } = require('../lib/session-files');

const HOME = '/Users/x';

test('paths in prose: the kinds a person looks at, without the punctuation around them', () => {
  assert.deepEqual(pathsInText('Saved the plot to results/loss.png and the report at **/Users/x/Code/p/report.html**.'), ['results/loss.png', '/Users/x/Code/p/report.html']);
  assert.deepEqual(pathsInText('See `figs/roc.pdf`, fig_2.svg; and ~/Code/p/notes.md.'), ['figs/roc.pdf', 'fig_2.svg', '~/Code/p/notes.md']);
  assert.deepEqual(pathsInText('[the table](out/table.csv) and ../up/one.ipynb!'), ['out/table.csv', '../up/one.ipynb']);
  // URLs are not files here, except file:// ones.
  assert.deepEqual(pathsInText('https://example.com/a.png and file:///Users/x/Code/p/b.pdf'), ['/Users/x/Code/p/b.pdf']);
  // Code, data and odd endings are not shown.
  assert.deepEqual(pathsInText('main.py, data.json, image.png.bak, foo.pngx, .md'), []);
});

test("Codex's patches: added, updated and moved-to files, in either escaping", () => {
  assert.deepEqual(patchedFiles('text(await tools.apply_patch("*** Begin Patch\\n*** Add File: /a/b/c.md\\n+hi\\n*** Update File: rel/d.png\\n*** Move to: rel/e.png\\n*** End Patch"))'), ['/a/b/c.md', 'rel/d.png', 'rel/e.png']);
  assert.deepEqual(patchedFiles('*** Begin Patch\n*** Add File: x.html\n+<p>\n*** End Patch'), ['x.html']);
  assert.deepEqual(patchedFiles('ls -la'), []);
});

test('Claude: written files from Write/Edit/NotebookEdit, named ones from its replies, never from tool output', () => {
  const state = {};
  const line = (o) => refsFromRecord(o, 'claude', state);
  const at = '2026-11-10T12:00:00.000Z';
  assert.deepEqual(line({ type: 'user', cwd: '/Users/x/Code/p', message: { content: [{ type: 'tool_result', content: 'found a.png b.png' }] } }), []);
  assert.equal(state.cwd, '/Users/x/Code/p');
  const refs = line({ type: 'assistant', cwd: '/Users/x/Code/p', timestamp: at, message: { content: [
    { type: 'tool_use', name: 'Write', input: { file_path: '/Users/x/Code/p/report.md' } },
    { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: 'nb/fit.ipynb' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'open out.png' } },
    { type: 'text', text: 'The figure is at figs/roc.png.' }
  ] } });
  assert.deepEqual(refs.map((r) => [r.raw, r.how, r.cwd]), [
    ['/Users/x/Code/p/report.md', 'wrote', '/Users/x/Code/p'],
    ['nb/fit.ipynb', 'wrote', '/Users/x/Code/p'],
    ['figs/roc.png', 'mentioned', '/Users/x/Code/p']
  ]);
  assert.equal(refs[0].at, Date.parse(at));
});

test('Codex: its turn says where it works; patches are writes, its messages name files', () => {
  const state = {};
  const lines = [
    { type: 'turn_context', payload: { cwd: '/Users/x/Code/q' } },
    { type: 'response_item', timestamp: '2026-11-10T12:00:00Z', payload: { type: 'custom_tool_call', name: 'exec', input: 'tools.apply_patch("*** Begin Patch\\n*** Add File: plots/a.svg\\n+<svg/>\\n*** End Patch")' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'see b.png' } },
    { type: 'response_item', timestamp: '2026-11-10T12:01:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Wrote `plots/a.svg` and summary.md.' }] } }
  ].map((o) => JSON.stringify(o));
  const refs = refsFromLines(lines, 'codex', state);
  assert.deepEqual(refs.map((r) => [r.raw, r.how, r.cwd]), [
    ['plots/a.svg', 'wrote', '/Users/x/Code/q'],
    ['plots/a.svg', 'mentioned', '/Users/x/Code/q'],
    ['summary.md', 'mentioned', '/Users/x/Code/q']
  ]);
});

test('Antigravity: write_to_file and friends, and its replies', () => {
  const state = { cwd: '/Users/x/Code/r' };
  const refs = refsFromRecord({ type: 'PLANNER_RESPONSE', created_at: '2026-11-10T12:00:00Z', content: 'Done: see out/chart.png',
    tool_calls: [{ name: 'write_to_file', args: { TargetFile: '/Users/x/Code/r/index.html' } }, { name: 'replace_file_content', args: JSON.stringify({ TargetFile: 'docs/a.md' }) }, { name: 'run_command', args: { CommandLine: 'ls x.png' } }] }, 'antigravity', state);
  assert.deepEqual(refs.map((r) => [r.raw, r.how]).sort(), [['/Users/x/Code/r/index.html', 'wrote'], ['docs/a.md', 'wrote'], ['out/chart.png', 'mentioned']].sort());
});

test('resolving: ~, relative to the cwd then, absolute as is; nothing without a cwd', () => {
  assert.equal(resolveRef('~/a/b.png', '/x', HOME), '/Users/x/a/b.png');
  assert.equal(resolveRef('../b.png', '/Users/x/Code/p/sub', HOME), '/Users/x/Code/p/b.png');
  assert.equal(resolveRef('/abs/c.pdf', null, HOME), '/abs/c.pdf');
  assert.equal(resolveRef('rel.png', null, HOME), null);
});

test('kept out: hidden folders, dependencies, the system, ~/Library, and kinds hop does not show', () => {
  assert.equal(allowedPath('/Users/x/Code/p/fig.png', HOME), true);
  assert.equal(allowedPath('/private/tmp/run/fig.png', HOME), true);
  assert.equal(allowedPath('/Users/x/.ssh/notes.md', HOME), false);
  assert.equal(allowedPath('/Users/x/Code/p/.git/x.md', HOME), false);
  assert.equal(allowedPath('/Users/x/Code/p/node_modules/a/README.md', HOME), false);
  assert.equal(allowedPath('/usr/share/doc/a.html', HOME), false);
  assert.equal(allowedPath('/Users/x/Library/Caches/a.pdf', HOME), false);
  assert.equal(allowedPath('/Users/x/Code/p/main.py', HOME), false);
  assert.equal(allowedPath('relative.png', HOME), false);
});

test('collected once per file: a write outranks a mention, the latest moment wins', () => {
  const m = collect([
    { raw: 'a.png', how: 'mentioned', at: 1, cwd: '/Users/x/p' },
    { raw: '/Users/x/p/a.png', how: 'wrote', at: 3, cwd: '/' },
    { raw: 'a.png', how: 'mentioned', at: 2, cwd: '/Users/x/p' },
    { raw: '/Users/x/.env.md', how: 'wrote', at: 4, cwd: '/' }
  ], { home: HOME });
  assert.deepEqual([...m.values()], [{ path: '/Users/x/p/a.png', how: 'wrote', at: 3 }]);
});
