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

test('cursor-anchored composer treats unstyled text starting at the cursor as a ghost suggestion', async (t) => {
  const screen = CLAUDE_SCREEN.slice();
  screen[2] = '❯ git status';
  // Claude leaves the cursor immediately after `❯ ` while painting the
  // suggestion to its right. Snapshot replay can lose the suggestion's dim
  // style, so cursor position is the durable discriminator.
  const { manager, reason } = await makeManager(screen, 3, 3);
  if (!manager) return t.skip(reason);

  const composer = manager.getComposerState('t1');
  assert.equal(composer.found, true);
  assert.equal(composer.strategy, 'cursor-prompt');
  assert.equal(composer.isEmpty, true);
  assert.equal(composer.text, '');
  assert.equal(composer.ghost, 'git status');
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

test("agy's grey box hint is no text typed in it; what was typed still is", async (t) => {
  const composer = require('../lib/composer');
  if (!composer.loadHeadlessTerminal()) { t.skip('xterm-headless unavailable'); return; }
  const rule = '\x1b[90m' + '─'.repeat(60) + '\x1b[0m';
  const screen = (box) => `${rule}\r\n\x1b[94m>\x1b[0m ${box}\r\n${rule}\r\n? for shortcuts\x1b[2;3H`;
  const hint = '\x1b[90mAuto mode: edits & safe commands auto-approved (shift+tab to cycle)\x1b[0m';
  const empty = await composer.readComposerFromSerialized(screen(hint), 100, 10, { cursorGhost: false, greyGhost: true });
  assert.equal(empty.state.found, true);
  assert.equal(empty.state.isEmpty, true, 'the hint is a placeholder');
  assert.equal(empty.full.text, '');
  const claudeRules = await composer.readComposerFromSerialized(screen(hint), 100, 10, { cursorGhost: false });
  assert.equal(claudeRules.state.isEmpty, false, 'only where asked: grey stays text for other agents');
  const typed = await composer.readComposerFromSerialized(screen('continue') + '\x1b[2;11H', 100, 10, { cursorGhost: false, greyGhost: true });
  assert.equal(typed.state.isEmpty, false);
  assert.equal(typed.state.text, 'continue');
  assert.equal(typed.full.text, 'continue');
});

test("a framed card above Claude's input line is not the input box", async (t) => {
  // Claude Code's "Product feedback drafted" panel sits in a ╭╮╰╯ frame above
  // its rule-framed `❯` line; read as the box, the card was typed text and
  // every message for the session waited behind it.
  const composer = require('../lib/composer');
  if (!composer.loadHeadlessTerminal()) { t.skip('xterm-headless unavailable'); return; }
  const w = 70;
  const rule = '─'.repeat(w);
  const card = [
    '╭' + '─'.repeat(w - 2) + '╮',
    '│ ✻ Product feedback drafted: a model named a result by its mechanism │',
    '│ 1 to review · 2 to send · 0 to dismiss' + ' '.repeat(w - 42) + '│',
    '╰' + '─'.repeat(w - 2) + '╯'
  ];
  const screen = (input, cursorCol) => [...card, '', rule, `❯ ${input}`, rule, '  ⏵⏵ auto mode on (shift+tab to cycle) · 1 feedback draft']
    .join('\r\n') + `\x1b[7;${cursorCol}H`;
  // An empty box showing Claude's dim suggestion.
  const empty = await composer.readComposerFromSerialized(screen('\x1b[2msend me the design note\x1b[0m', 3), 80, 12);
  assert.equal(empty.state.found, true);
  assert.notEqual(empty.state.strategy, 'box');
  assert.equal(empty.state.isEmpty, true, 'the card is not typed text, and the suggestion is a ghost');
  assert.equal(empty.full.text, '');
  // What was typed is still read, from the input line.
  const typed = await composer.readComposerFromSerialized(screen('fix the axis labels', 22), 80, 12);
  assert.equal(typed.state.isEmpty, false);
  assert.equal(typed.state.text, 'fix the axis labels');
  assert.equal(typed.full.text, 'fix the axis labels');
  // The cursor elsewhere (a replay can leave it anywhere): the rule above the `❯` line still says so.
  const elsewhere = await composer.readComposerFromSerialized(screen('fix the axis labels', 22) + '\x1b[1;1H', 80, 12, { cursorGhost: false });
  assert.equal(elsewhere.state.text, 'fix the axis labels');
});

test("Claude's input box is found above its subagent list, and a prompt echoed in the transcript is not it", async (t) => {
  // With subagents running, Claude lists them under its status line, which
  // put a tall box out of reach of the bottom-up scan: "the agent's input
  // box isn't on screen", and every message for the session waited.
  const composer = require('../lib/composer');
  if (!composer.loadHeadlessTerminal()) { t.skip('xterm-headless unavailable'); return; }
  const rule = '─'.repeat(70);
  const draft = Array.from({ length: 12 }, (_, i) => (i === 0 ? '❯ ' : '  ') + `line ${i} of a long draft about the base model`);
  const agents = ['  ⏺ main', ...Array.from({ length: 6 }, (_, i) => `  ◯ general-purpose  Reading log ${i}`)];
  const rows = ['❯ [hop message from an agent] an older prompt, echoed in the transcript', '', '⏺ Working on it.', '',
    rule, ...draft, rule, '  ⏵⏵ auto mode on (shift+tab to cycle) · /tasks to see subagents', '', ...agents];
  const lastText = 5 + draft.length - 1; // 1-based row of the draft's last line
  const screen = rows.join('\r\n') + `\x1b[${lastText};${draft[draft.length - 1].length + 1}H`;
  const r = await composer.readComposerFromSerialized(screen, 80, 40);
  assert.equal(r.state.found, true, 'the box above the subagent list');
  assert.match(r.state.text, /^line 0 of a long draft/);
  assert.match(r.full.text, /line 11 of a long draft about the base model$/);
  // No box on screen (a dialog in its place): the echoed prompt is not taken for it.
  const noBox = ['❯ [hop message from an agent] an older prompt, echoed in the transcript', '', ...Array.from({ length: 20 }, (_, i) => `  output ${i}`),
    '  Select a model', '  1. Default', '  2. Opus', ...agents].join('\r\n') + '\x1b[23;3H';
  const n = await composer.readComposerFromSerialized(noBox, 80, 40);
  assert.equal(n.state.found, false);
});

test("a list the agent asks its person to choose from is a question on screen, not a draft", async (t) => {
  // Codex relaunched in another folder asks which one to resume in. Its
  // selected option starts with `›` like its input line, so the options read
  // as typed text: hop pressed its clear-line keys into the menu every few
  // seconds for hours and every message for the session waited behind it.
  const composer = require('../lib/composer');
  if (!composer.loadHeadlessTerminal()) { t.skip('xterm-headless unavailable'); return; }
  const chooser = ['', '  Working directory · resume', '  Session = latest cwd recorded in the resumed session', '  Current = your current working directory', '',
    '› 1. Use session directory (/Users/me/Code/project)', '  2. Use current directory (/Users/me)', '  3. Always use session directory', '  4. Always use current directory', '',
    '  enter continue · esc use session · ⌃c quit'].join('\r\n');
  for (const cursor of ['\x1b[6;1H', '\x1b[24;1H']) {
    const r = await composer.readComposerFromSerialized(chooser + cursor, 146, 24);
    assert.equal(r.state.found, false, 'no input box to type into');
    assert.equal(r.state.menu, true);
    assert.equal(r.full.found, false);
  }
  // Claude's permission prompt, its second option selected.
  const claudeAsk = ['⏺ Bash(rm -rf build)', '', ' Do you want to proceed?', '   1. Yes', ' ❯ 2. Yes, and don\'t ask again for rm commands', '   3. No, and tell Claude what to do differently (esc)', '', ' Esc to cancel · Tab to amend'].join('\r\n');
  const c = await composer.readComposerFromSerialized(claudeAsk, 80, 12);
  assert.equal(c.state.menu, true);
  // A numbered list typed in Codex's own box is still a draft.
  const draft = ['• Done.', '', '› 1. rerun the eval', '  2. then plot the loss', '', '  GPT-6.2-Astra xhigh · ~/Code/project · Main [default]', '  ← for agents · ? for shortcuts'].join('\r\n') + '\x1b[4;25H';
  const d = await composer.readComposerFromSerialized(draft, 100, 12);
  assert.equal(d.state.found, true);
  assert.equal(d.state.menu, undefined);
  assert.equal(d.full.text, '1. rerun the eval\n2. then plot the loss');
});
