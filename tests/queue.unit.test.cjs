const test = require('node:test');
const assert = require('node:assert/strict');
const composer = require('../lib/composer');
const checkbacks = require('../lib/checkbacks');

// Messages for an agent that is busy are held by hop (`queued`) and typed
// only into an EMPTY input box; ⌘⌥⏎ moves what is typed in Claude's box into
// that queue. Both rest on reading the box off the screen.

const COLS = 80, ROWS = 24;
async function screen(lines, cursor) {
  const T = composer.loadHeadlessTerminal();
  if (!T) return null;
  const term = new T({ cols: COLS, rows: ROWS, allowProposedApi: true });
  await new Promise((r) => term.write(lines.join('\r\n'), r));
  if (cursor) await new Promise((r) => term.write(`\x1b[${cursor[0]};${cursor[1]}H`, r));
  return term;
}
const rule = '─'.repeat(78);

test('an empty Claude box is empty, even showing its dim placeholder', async (t) => {
  const term = await screen(['● Done.', '', rule, '❯ \x1b[2mTry "fix the tests"\x1b[0m', rule, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'], [4, 3]);
  if (!term) return t.skip('xterm-headless unavailable');
  const s = composer.readComposer(term.buffer.active, ROWS, COLS);
  assert.equal(s.found, true);
  assert.equal(s.isEmpty, true);
  const full = composer.readComposerText(term.buffer.active, ROWS, COLS);
  assert.equal(full.text, '');
});

test("what is typed in Claude's box is read whole: lines kept, the app's wrapping joined", async (t) => {
  const long = 'please rerun the evaluation on the held-out split and compare with the matched baseline';
  const wrapped = [long.slice(0, 74), long.slice(74)];
  const term = await screen(['● Working…', '', rule, '❯ first line', '  ' + wrapped[0], '  ' + wrapped[1], rule, '  ⏵⏵ bypass permissions on'], [6, 3 + wrapped[1].length]);
  if (!term) return t.skip('xterm-headless unavailable');
  const s = composer.readComposer(term.buffer.active, ROWS, COLS);
  assert.equal(s.found, true);
  assert.equal(s.isEmpty, false);
  const full = composer.readComposerText(term.buffer.active, ROWS, COLS);
  assert.equal(full.text, 'first line\n' + wrapped[0] + ' ' + wrapped[1]);
  assert.equal(full.collapsed, false);
});

test('a collapsed paste cannot be read off the screen, and says so', async (t) => {
  const term = await screen([rule, '❯ [Pasted text #1 +42 lines] ', rule], [2, 31]);
  if (!term) return t.skip('xterm-headless unavailable');
  const full = composer.readComposerText(term.buffer.active, ROWS, COLS);
  assert.equal(full.collapsed, true);
});

test('a Codex box (› prompt) is found, and its text read', async (t) => {
  const term = await screen(['• Ran tests', '', '› send the report', '', '  ⏎ send   ⌃J newline'], [3, 18]);
  if (!term) return t.skip('xterm-headless unavailable');
  const s = composer.readComposer(term.buffer.active, ROWS, COLS);
  assert.equal(s.found, true);
  assert.equal(s.text, 'send the report');
  assert.equal(composer.readComposerText(term.buffer.active, ROWS, COLS).text, 'send the report');
});

test('a serialized screen replays into the same reading', async (t) => {
  if (!composer.loadHeadlessTerminal()) return t.skip('xterm-headless unavailable');
  const data = ['● Done.', '', rule, '❯ hello there', rule].join('\r\n') + '\x1b[4;14H';
  const r = await composer.readComposerFromSerialized(data, COLS, ROWS);
  assert.equal(r.state.found, true);
  assert.equal(r.full.text, 'hello there');
});

test('a queued message waits for idle, says whose it is, and is not a plain check-back', () => {
  const now = 1_000_000;
  const cb = checkbacks.normalizeCheckback({ session: 's_x', message: 'status?', idle: true, queued: true, from: 'ceo' }, now);
  assert.equal(cb.queued, true);
  assert.equal(cb.from, 'ceo');
  assert.deepEqual(cb.trigger, { kind: 'idle', afterMs: 0, armedAt: now });
  assert.equal(checkbacks.mayDeliver(cb, { phase: 'working' }), false);
  assert.equal(checkbacks.mayDeliver(cb, { phase: 'done' }), true);
  assert.equal(checkbacks.triggerFired(cb, { phase: 'done', idleSince: now - 5 }, now), true);
  assert.match(checkbacks.describe(cb, now), /queued from ceo, sends when the turn ends/);
  assert.throws(() => checkbacks.normalizeCheckback({ session: 's_x', message: 'x', in: '5m', queued: true }, now), /waits for idle/);
  const plain = checkbacks.normalizeCheckback({ session: 's_x', message: 'x', idle: true }, now);
  assert.equal(plain.queued, undefined);
});

test('a long path the app wrapped after a "/" reads back without a space in it', async (t) => {
  const row1 = "Continue from /Users/me/Code/project/a_long_directory_name_for_run_2026/";
  const row2 = 'junction_dynamic_loop/state.json. Keep the rest paused.';
  const term = await screen(['• Done', '', '› ' + row1, '  ' + row2, '', '  model · ~'], [4, 3 + row2.length]);
  if (!term) return t.skip('xterm-headless unavailable');
  const full = composer.readComposerText(term.buffer.active, ROWS, COLS);
  assert.equal(full.text, row1 + row2);
});
