const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalStreamManager } = require('../mcp/hop-mcp.js');

// Regression tests for getComposerState's cursor-anchored bare-prompt fallback.
//
// Modern Claude Code draws its composer as a bare `❯ ` line (no box frame) with
// a `⏵⏵ bypass permissions on (shift+tab to cycle)` status line BELOW it. `⏵`
// is itself a recognized prompt glyph, so a naive "first prompt glyph up from
// the bottom" scan reads that status line as the composer and reports it as
// found-but-never-empty. The fix anchors to the CURSOR row first, and the
// bottom-up last resort explicitly skips the bypass-permissions line.

const COLS = 80;
const ROWS = 24;

function writeScreen(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

// Build a manager with one seeded stream whose virtual screen shows `lines`
// (top-aligned), then park the cursor at 1-based (cursorRow, cursorCol).
async function makeManager(lines, cursorRow, cursorCol) {
  const manager = new TerminalStreamManager();
  const virtualScreen = manager.createVirtualScreen(COLS, ROWS);
  if (!virtualScreen) return { manager: null, reason: 'xterm-headless unavailable' };
  await writeScreen(virtualScreen, lines.join('\r\n'));
  await writeScreen(virtualScreen, `\x1b[${cursorRow};${cursorCol}H`);
  manager.streams.set('t1', {
    terminalId: 't1',
    cols: COLS,
    rows: ROWS,
    virtualScreen,
    screenRevision: 1,
    alternateScreen: false,
    cursorHidden: false
  });
  return { manager };
}

const CLAUDE_SCREEN = [
  '● Some transcript output from the agent',
  '',
  '❯ ',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
];

test('empty bare-prompt composer with bypass status line below reports found and empty', async (t) => {
  // Cursor parked on the composer line, just after the `❯ ` glyph (row 3, col 3).
  const { manager, reason } = await makeManager(CLAUDE_SCREEN, 3, 3);
  if (!manager) return t.skip(reason);

  const composer = manager.getComposerState('t1');
  assert.equal(composer.available, true);
  assert.equal(composer.found, true, 'composer must be found at the cursor row');
  assert.equal(composer.strategy, 'cursor-prompt');
  assert.equal(composer.isEmpty, true, 'bare `❯ ` composer must read as empty, not as the ⏵⏵ status line');
  assert.equal(composer.text, '');
});

test('cursor-anchored composer reports typed text, not the status line below', async (t) => {
  const screen = CLAUDE_SCREEN.slice();
  screen[2] = '❯ hello world';
  const { manager, reason } = await makeManager(screen, 3, 14);
  if (!manager) return t.skip(reason);

  const composer = manager.getComposerState('t1');
  assert.equal(composer.found, true);
  assert.equal(composer.strategy, 'cursor-prompt');
  assert.equal(composer.isEmpty, false);
  assert.equal(composer.text, 'hello world');
});

test('bottom-up fallback skips the bypass-permissions line when the cursor is elsewhere', async (t) => {
  // Cursor parked on the transcript row (no prompt glyph there), so the
  // cursor-prompt strategy cannot fire and the last-resort bottom-up scan runs.
  const { manager, reason } = await makeManager(CLAUDE_SCREEN, 1, 1);
  if (!manager) return t.skip(reason);

  const composer = manager.getComposerState('t1');
  assert.equal(composer.found, true);
  assert.equal(composer.strategy, 'prompt');
  assert.equal(composer.isEmpty, true, 'fallback must land on `❯ `, skipping the ⏵⏵ status line');
  assert.equal(composer.text, '');
});
