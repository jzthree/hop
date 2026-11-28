'use strict';
// A TUI agent's input box ("composer") read off a terminal screen: what is
// typed in it, told apart from the dim placeholder an empty box shows. Shared
// by the MCP (its live virtual screens) and the daemon (a session's screen as
// the host serializes it), so both agree on when a box is empty and what it
// holds — the daemon types a queued message only into an EMPTY box, and checks
// the box let go of it after Enter.
//
// Works on an xterm buffer (xterm-headless: `term.buffer.active`).

// Box-drawing characters that frame a TUI input box (rounded, square, and heavy
// variants), plus the column separators. Used to locate the composer and to skip
// border cells when scraping its contents.
const COMPOSER_BORDER_CHARS = new Set([
  '╭', '╮', '╰', '╯', '─', '│',
  '┌', '┐', '└', '┘', '┃', '━', '┏', '┓', '┗', '┛'
]);
const COMPOSER_TOP_CORNER_CHARS = new Set(['╭', '┌', '┏']);
const COMPOSER_BOTTOM_CORNER_CHARS = new Set(['╰', '└', '┗']);
// Prompt glyphs Claude/other TUIs print at the start of the input line.
const COMPOSER_PROMPT_CHARS = new Set(['>', '❯', '›', '▶', '⏵']);

// A list the app asks its person to choose from, not a box: its selected row
// starts with a prompt glyph and a number ("› 1. Use session directory …",
// Codex's resume folder; "❯ 1. Yes", Claude's permission prompt), another
// numbered option sits beside it, and a key hint follows ("enter continue ·
// esc use session", "Enter to confirm · Esc to cancel"). Read as a box, its
// options were a draft: hop pressed its clear-line keys into the menu every
// few seconds and held every message behind it (2026-11-28).
const MENU_OPTION_RE = /^\d{1,2}[.)]\s+\S/;
const MENU_SIBLING_RE = /^\s+\d{1,2}[.)]\s+\S/;
const MENU_HINT_RE = /\b(enter|esc)\b.*\b(confirm|continue|cancel|select|choose|use|go back|dismiss)\b|\b(confirm|select|cancel)\b.*\b(enter|esc)\b/i;

// Placeholder text, not typed: dim, or (options.greyGhost) grey.
const GREY = 8; // SGR 90, "bright black"
function isGhostCell(c, greyGhost) {
  if (c.isDim()) return true;
  return !!greyGhost && typeof c.isFgPalette === 'function' && c.isFgPalette() && c.getFgColor() === GREY;
}

// Read the state of a TUI input box ("composer") from a screen, distinguishing
// text the user/agent actually typed from the dim ghost placeholder the app
// shows when the box is empty. The discriminator is the per-cell SGR dim
// attribute (cell.isDim()) rather than stripping \e[2m from a string, which
// sidesteps the color-payload ambiguity of attribute-blind scrapes.
//
// Strategy: scan the bottom of the viewport for a box-drawing frame
// (╭…╮ / ╰…╯). The rows between the corners are the composer body; within them
// we drop border cells, a leading prompt glyph (> / ❯), and any run of dim
// cells (the placeholder), and keep the rest as the real input `text`.
//
// options.cursorGhost (default true): text from the cursor on is a ghost
// suggestion (Claude's, which is not always dim after a replay). false for an
// app with no suggestions whose cursor can sit ON the last character typed
// (Antigravity's agy 1.5), where that rule would drop a real letter.
//
// options.greyGhost (default false): grey text (SGR 90, palette colour 8) is
// placeholder too. agy 1.5 draws its box hint that way, not dim ("Auto mode:
// edits & safe commands auto-approved (shift+tab to cycle)"), and an empty
// box read as typed-in held a queued message back for good.
//
// Returns { available, found, strategy, text, ghost, isEmpty, boxTop, boxBottom },
// or { found: false, strategy: 'menu', menu: true } when the app shows a list
// to choose from where its box would be.
// found=false (with available=true) means no recognizable composer was on
// screen — callers must treat that as "cannot verify", never as "empty".
function readComposer(buffer, rows, cols, options = {}) {
  const viewportStart = buffer.baseY;
  const ghostAtCursor = options.cursorGhost !== false;
  const greyGhost = options.greyGhost === true;
  const scanRows = Math.min(rows, Number.isFinite(options.scanRows) ? Math.max(1, Math.floor(options.scanRows)) : 16);
  // The composer is usually pinned near the bottom, but a near-empty screen
  // (e.g. a freshly launched Claude Code with only a welcome banner) draws it
  // top-aligned with empty rows below it. Anchoring the scan to the physical
  // bottom would then look only at those empty trailing rows and miss the
  // composer entirely — which silently defeats both verified-submit and
  // needs_input(parked_composer). Anchor to the last non-empty row instead.
  const viewportTop = viewportStart;
  const viewportBottom = viewportStart + rows - 1;
  let lastRow = viewportBottom;
  for (let row = viewportBottom; row >= viewportTop; row--) {
    const line = buffer.getLine(row);
    if (line && line.translateToString(true).trim()) { lastRow = row; break; }
  }
  const firstScanRow = Math.max(viewportTop, lastRow - scanRows + 1);

  const cell = buffer.getNullCell ? buffer.getNullCell() : undefined;
  const firstChar = (row) => {
    const line = buffer.getLine(row);
    if (!line) return '';
    const s = line.translateToString(true);
    const trimmed = s.replace(/\s+$/, '');
    const idx = trimmed.search(/\S/);
    return idx < 0 ? '' : trimmed[idx];
  };

  const rowString = (row) => (buffer.getLine(row)?.translateToString(true) || '');
  // A choice list, its selected row at `row` (see MENU_OPTION_RE).
  const menuAt = (row) => {
    const t = rowString(row).trim();
    if (!COMPOSER_PROMPT_CHARS.has(t[0]) || !MENU_OPTION_RE.test(t.slice(1).trim())) return false;
    let sibling = false;
    for (let r = Math.max(viewportTop, row - 4); r <= Math.min(lastRow, row + 4) && !sibling; r++) {
      if (r !== row && MENU_SIBLING_RE.test(rowString(r))) sibling = true;
    }
    if (!sibling) return false;
    for (let r = row + 1; r <= Math.min(lastRow, row + 16); r++) if (MENU_HINT_RE.test(rowString(r))) return true;
    return false;
  };
  const menu = { available: true, found: false, strategy: 'menu', menu: true, text: '', ghost: '', isEmpty: false };

  // Find the bottom border first (search upward from the screen bottom), then
  // the matching top border above it.
  let boxBottom = -1;
  for (let row = lastRow; row >= firstScanRow; row--) {
    if (COMPOSER_BOTTOM_CORNER_CHARS.has(firstChar(row))) { boxBottom = row; break; }
  }
  let boxTop = -1;
  if (boxBottom >= 0) {
    for (let row = boxBottom - 1; row >= firstScanRow; row--) {
      if (COMPOSER_TOP_CORNER_CHARS.has(firstChar(row))) { boxTop = row; break; }
      // A second bottom corner before a top corner means we mis-paired; reset.
      if (COMPOSER_BOTTOM_CORNER_CHARS.has(firstChar(row))) { boxBottom = row; }
    }
  }
  // A frame with the input line BELOW it is a card, not the composer: modern
  // Claude Code draws panels such as "✻ Product feedback drafted … 1 to review
  // · 2 to send" in a ╭╮╰╯ frame above its rule-framed `❯` line. Read as the
  // box, the card was text typed in it, and every message waited behind it.
  // The input line: the cursor's row when it starts with a prompt glyph, or a
  // `❯`/`›` line directly under a rule.
  if (boxBottom >= 0) {
    const cursorAt = viewportStart + (typeof buffer.cursorY === 'number' ? buffer.cursorY : -1);
    for (let row = boxBottom + 1; row <= lastRow; row++) {
      const ch = firstChar(row);
      if (!COMPOSER_PROMPT_CHARS.has(ch)) continue;
      const above = (buffer.getLine(row - 1)?.translateToString(true) || '').trim();
      if (row === cursorAt || ((ch === '❯' || ch === '›') && /^[─━]{8,}/.test(above))) {
        boxBottom = -1; boxTop = -1;
        break;
      }
    }
  }

  const readBody = (rowStart, rowEnd, cursorGhost = null) => {
    let real = '';
    let ghost = '';
    let strippedPrompt = false;
    for (let row = rowStart; row <= rowEnd; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const lineLen = Math.min(cols, line.length);
      let rowReal = '';
      for (let x = 0; x < lineLen; x++) {
        const c = line.getCell(x, cell);
        if (!c) continue;
        if (c.getWidth() === 0) continue; // trailing half of a wide glyph
        const ch = c.getChars();
        // Claude suggestions are not always emitted with SGR dim styling,
        // especially after a terminal snapshot is replayed. Text beginning
        // at the cursor is still a ghost suggestion: typed input lies before
        // the cursor (or on both sides when editing in the middle).
        if (
          ch
          && cursorGhost
          && ghostAtCursor
          && row === cursorGhost.row
          && x >= cursorGhost.column
        ) {
          ghost += ch;
          continue;
        }
        if (!ch) {
          if (!isGhostCell(c, greyGhost)) rowReal += ' ';
          continue;
        }
        if (COMPOSER_BORDER_CHARS.has(ch)) continue; // box frame
        // Strip a single leading prompt glyph at the very start of the body.
        if (!strippedPrompt && COMPOSER_PROMPT_CHARS.has(ch) && rowReal.trim() === '' && real.trim() === '') {
          strippedPrompt = true;
          continue;
        }
        if (isGhostCell(c, greyGhost)) { ghost += ch; continue; } // placeholder ghost text
        rowReal += ch;
      }
      real += (real && rowReal.trim() ? ' ' : '') + rowReal;
    }
    return { real: real.replace(/\s+/g, ' ').trim(), ghost: ghost.replace(/\s+/g, ' ').trim() };
  };

  if (boxTop >= 0 && boxBottom > boxTop) {
    const cursorRow = viewportStart + (typeof buffer.cursorY === 'number' ? buffer.cursorY : 0);
    const body = readBody(boxTop + 1, boxBottom - 1, {
      row: cursorRow,
      column: typeof buffer.cursorX === 'number' ? buffer.cursorX : cols
    });
    return {
      available: true,
      found: true,
      strategy: 'box',
      text: body.real,
      ghost: body.ghost,
      isEmpty: body.real.length === 0,
      boxTop: boxTop - viewportStart,
      boxBottom: boxBottom - viewportStart
    };
  }

  // No frame: fall back to a bare prompt line (legacy/narrow TUIs, and modern
  // Claude Code which draws `❯ ` with horizontal rules rather than a box).
  // Anchor to the CURSOR's line first: the cursor sits in the active input, so
  // it is the composer. Scanning "first prompt glyph up from the bottom"
  // mis-fires here — Claude's `⏵⏵ bypass permissions` status line sits BELOW
  // the composer and `⏵` is itself a prompt glyph, so a bottom-up scan reads
  // that status line as composer text (found, but never empty).
  const cursorRow = viewportStart + (typeof buffer.cursorY === 'number' ? buffer.cursorY : 0);
  if (cursorRow >= viewportTop && cursorRow <= viewportBottom
      && COMPOSER_PROMPT_CHARS.has(firstChar(cursorRow))) {
    if (menuAt(cursorRow)) return menu;
    const body = readBody(cursorRow, cursorRow, {
      row: cursorRow,
      column: typeof buffer.cursorX === 'number' ? buffer.cursorX : cols
    });
    return {
      available: true,
      found: true,
      strategy: 'cursor-prompt',
      text: body.real,
      ghost: body.ghost,
      isEmpty: body.real.length === 0,
      boxTop: cursorRow - viewportStart,
      boxBottom: cursorRow - viewportStart
    };
  }
  // Last resort: scan up from the bottom, but skip the bypass-permissions
  // status line so it can't masquerade as the composer. Past the usual scan
  // rows (Claude's subagent list under the box, a tall draft in it), only a
  // `❯`/`›` line between rules counts: a prompt echoed in the transcript
  // has none.
  const ruleAt = (row) => RULE_RE.test((buffer.getLine(row)?.translateToString(true) || '').trim());
  const betweenRules = (row) => {
    if (!ruleAt(row - 1)) return false;
    for (let r = row + 1; r <= lastRow && r <= row + 40; r++) if (ruleAt(r)) return true;
    return false;
  };
  const farScanRow = Math.max(viewportTop, lastRow - 48 + 1);
  for (let row = lastRow; row >= farScanRow; row--) {
    const ch = firstChar(row);
    if (!COMPOSER_PROMPT_CHARS.has(ch)) continue;
    if (row < firstScanRow && !((ch === '❯' || ch === '›') && betweenRules(row))) continue;
    // The app is asking a question: no box to read, and none above it.
    if (menuAt(row)) return menu;
    const body = readBody(row, row);
    if (/bypass permissions|shift\+tab to cycle/i.test(body.real)) continue;
    return {
      available: true,
      found: true,
      strategy: 'prompt',
      text: body.real,
      ghost: body.ghost,
      isEmpty: body.real.length === 0,
      boxTop: row - viewportStart,
      boxBottom: row - viewportStart
    };
  }

  return { available: true, found: false, strategy: 'none', text: '', ghost: '', isEmpty: false };
}

// The rows of a rule-framed composer (modern Claude Code: `❯ ` between two
// ──── rules) below its prompt row, up to the closing rule.
const RULE_RE = /^[─━]{8,}/;

/**
 * Everything typed in the box, for moving it elsewhere (hop's "send when the
 * agent is done"): every row of it, not the one line `readComposer` keys on,
 * with the prompt glyph, the continuation indent and the dim placeholder
 * dropped. A row that ends short of the box's width ended in a newline the
 * person typed; a full row was wrapped by the app and joins with a space.
 *
 * Returns { found, text, rows, collapsed } — `collapsed` when the box shows a
 * placeholder for content it holds elsewhere ("[Pasted text #1 +40 lines]",
 * "[Image #1]"), which cannot be read off the screen.
 */
function readComposerText(buffer, rows, cols, options = {}) {
  const state = readComposer(buffer, rows, cols, options);
  const greyGhost = options.greyGhost === true;
  if (!state.found) return { found: false, text: '', rows: 0, collapsed: false };
  const viewportStart = buffer.baseY;
  const top = viewportStart + state.boxTop;
  const cell = buffer.getNullCell ? buffer.getNullCell() : undefined;
  const rowText = (row, dropPrompt) => {
    const line = buffer.getLine(row);
    if (!line) return '';
    let out = '';
    let stripped = !dropPrompt;
    const n = Math.min(cols, line.length);
    for (let x = 0; x < n; x++) {
      const c = line.getCell(x, cell);
      if (!c || c.getWidth() === 0) continue;
      const ch = c.getChars();
      if (!ch) { out += ' '; continue; }
      if (COMPOSER_BORDER_CHARS.has(ch) && (ch === '│' || ch === '┃')) continue;
      if (!stripped && COMPOSER_PROMPT_CHARS.has(ch) && out.trim() === '') { stripped = true; continue; }
      if (isGhostCell(c, greyGhost)) continue;
      out += ch;
    }
    return out.replace(/\s+$/, '');
  };
  const lines = [];
  if (state.strategy === 'box') {
    for (let r = top; r <= viewportStart + state.boxBottom; r++) lines.push(rowText(r, lines.length === 0));
  } else {
    lines.push(rowText(top, true));
    for (let r = top + 1, k = 0; r < viewportStart + rows && k < 60; r++, k++) {
      const raw = (buffer.getLine(r)?.translateToString(true) || '');
      const t = raw.trim();
      if (!t || RULE_RE.test(t)) break;
      // A continuation row is indented under the prompt; anything flush left
      // (a status line, another prompt) is not the box.
      if (!/^\s{2,}/.test(raw)) break;
      lines.push(rowText(r, false));
    }
  }
  // Join: a row that filled the box was wrapped by the app.
  const width = Math.max(10, cols - 6);
  let text = '';
  lines.forEach((l, i) => {
    const body = i === 0 ? l.replace(/^\s+/, '') : l.replace(/^\s{1,2}/, '');
    if (i === 0) { text = body; return; }
    const prev = lines[i - 1];
    const prevFull = prev.length >= width - 12;
    if (!prevFull) { text += '\n' + body; return; }
    // A wrap after a "/" or "-" (a long path, a hyphenated word) had no space.
    text += (/[\/-]$/.test(prev) ? '' : ' ') + body.replace(/^\s+/, '');
  });
  text = text.replace(/\s+$/, '');
  const collapsed = /\[(Pasted text|Pasted Content|Image) #?\d*[^\]]*\]/i.test(text);
  return { found: true, text, rows: lines.length, collapsed };
}

/** The xterm-headless Terminal constructor, or null where it is not installed. */
let headlessCtor;
function loadHeadlessTerminal() {
  if (headlessCtor !== undefined) return headlessCtor;
  const path = require('path');
  for (const candidate of ['xterm-headless', path.join(__dirname, '..', 'hay', 'node_modules', 'xterm-headless'), '@xterm/headless',
    path.join(__dirname, '..', 'hay', 'node_modules', '@xterm', 'headless')]) {
    try {
      const m = require(candidate);
      if (m && typeof m.Terminal === 'function') { headlessCtor = m.Terminal; return headlessCtor; }
    } catch (e) { /* next */ }
  }
  headlessCtor = null;
  return null;
}

/**
 * A screen as serialized bytes (what the host's /serialized returns), replayed
 * into a throwaway headless terminal and read. Resolves { state, full } or
 * null when no headless terminal is available.
 */
async function readComposerFromSerialized(data, cols, rows, options = {}) {
  const Terminal = loadHeadlessTerminal();
  if (!Terminal || typeof data !== 'string') return null;
  const term = new Terminal({ cols: Math.max(2, cols || 80), rows: Math.max(1, rows || 24), scrollback: 200, allowProposedApi: true });
  try {
    // xterm never calls back when its parser throws partway (that throw is
    // on its own timer, out of reach here): an unanswered write is no screen.
    const parsed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10000);
      if (timer.unref) timer.unref();
      try { term.write(data, () => { clearTimeout(timer); resolve(true); }); }
      catch (e) { clearTimeout(timer); resolve(false); }
    });
    if (!parsed) return null;
    const buffer = term.buffer.active;
    return { state: readComposer(buffer, term.rows, term.cols, options), full: readComposerText(buffer, term.rows, term.cols, options) };
  } finally {
    try { term.dispose(); } catch (e) { /* gone */ }
  }
}

module.exports = {
  COMPOSER_BORDER_CHARS, COMPOSER_TOP_CORNER_CHARS, COMPOSER_BOTTOM_CORNER_CHARS, COMPOSER_PROMPT_CHARS,
  readComposer, readComposerText, readComposerFromSerialized, loadHeadlessTerminal
};
