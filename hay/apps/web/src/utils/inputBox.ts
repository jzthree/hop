// The agent's input box on the terminal screen, for the two edits hop makes
// there on the person's behalf (Claude and Codex, both verified against the
// real apps; only while the app reads the mouse):
//
//  - a single click moves the cursor: hop pauses the app's mouse tracking on
//    every press so a drag can select (utils/dragSelect), which also kept a
//    plain click from ever reaching Claude — only a double-click got through.
//    Now a click that selected nothing is handed to the app as a click.
//  - typing over a selection made inside the box replaces it, as in any text
//    field: hop clicks at the selection's end (Claude puts its cursor there),
//    deletes as many characters as were selected, then types the key.
//
// Claude's box: `❯ ` and the text, continuation rows indented two spaces,
// between two ──── rules; Codex's: `› ` and the same indent, ended by a blank
// row. Their wrapping drops the space it breaks at, and a word too long for
// a row is cut at the right edge.
//
// Antigravity's agy draws the same box (`> `, rules) but never reads the
// mouse, so hop moves its cursor with arrow keys instead of a click (verified
// against agy 1.5: one character per arrow, across wrapped rows). agy parks
// its cursor ON the last character typed: the insertion point is one cell to
// the right of where the terminal shows the cursor.

const RULE = /^\s*[─━]{8,}/;
const PROMPT = /^\s*[❯›>](\s|$)/;

export type BoxRows = { start: number; end: number };

/** Buffer rows [start, end] of the input box holding row `cursorRow`, or null when the cursor is not in one. */
export const inputBoxRows = (line: (row: number) => string | undefined, cursorRow: number, maxRows = 40): BoxRows | null => {
  let start = -1;
  for (let r = cursorRow, k = 0; r >= 0 && k < maxRows; r--, k++) {
    const t = line(r);
    if (t === undefined || RULE.test(t)) break;
    if (PROMPT.test(t)) { start = r; break; }
    // A continuation row is indented; anything else above the cursor ends the search.
    if (t.trim() && !/^\s{2,}/.test(t)) break;
  }
  if (start < 0) return null;
  let end = start;
  for (let r = start + 1, k = 0; k < maxRows; r++, k++) {
    const t = line(r);
    if (t === undefined || !t.trim() || RULE.test(t) || !/^\s{2,}/.test(t)) break;
    end = r;
  }
  return cursorRow >= start && cursorRow <= end ? { start, end } : null;
};

/** Where the typed text starts on a row of the box: after `❯ ` on the first, after the indent on the rest. */
export const contentStart = (text: string, firstRow: boolean): number => {
  if (firstRow) { const i = text.search(/[❯›>]/); return i < 0 ? 0 : i + 2; }
  return Math.min(2, text.length);
};

/**
 * Characters drawn two cells wide (CJK, emoji): the counts here are by cell
 * and the text by character, so a row holding one would count wrong, and a
 * replace there is left to ordinary typing.
 */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]/u;
export const hasWideChars = (text: string): boolean => WIDE.test(text);

export type Selection = { startRow: number; startCol: number; endRow: number; endCol: number }; // buffer rows; endCol exclusive

/** The selection lies inside the box's text (the prompt glyph and indents may be swept up; they are not counted). */
export const selectionInBox = (sel: Selection, box: BoxRows): boolean =>
  sel.startRow >= box.start && sel.endRow <= box.end && (sel.endRow > sel.startRow || sel.endCol > sel.startCol);

/**
 * How many characters of the box's text the selection covers. A row break
 * inside it is one character (the newline typed, or the space Claude's
 * wrapping dropped) unless the row is full to the edge (a long word cut).
 */
export const selectedCharCount = (line: (row: number) => string | undefined, sel: Selection, box: BoxRows, cols: number): number => {
  let n = 0;
  for (let r = sel.startRow; r <= sel.endRow; r++) {
    const t = line(r) ?? "";
    const lo = contentStart(t, r === box.start);
    const from = Math.max(r === sel.startRow ? sel.startCol : 0, lo);
    const to = Math.min(r === sel.endRow ? sel.endCol : t.length, t.length);
    n += Math.max(0, to - from);
    if (r < sel.endRow) n += t.length >= cols - 1 ? 0 : 1;
  }
  return n;
};

/** Where to click so the cursor lands right after the selection: its end, kept inside the row's text. */
export const clickTargetAfter = (line: (row: number) => string | undefined, sel: Selection, box: BoxRows): { row: number; col: number } => {
  const t = line(sel.endRow) ?? "";
  const lo = contentStart(t, sel.endRow === box.start);
  return { row: sel.endRow, col: Math.max(lo, Math.min(sel.endCol, t.length)) };
};

/**
 * A cell's place in the box's text: characters from its start, row breaks
 * counted as selectedCharCount counts them. Past a row's end is its end.
 */
export const boxIndexAt = (line: (row: number) => string | undefined, box: BoxRows, row: number, col: number, cols: number): number => {
  let n = 0;
  for (let r = box.start; r < row; r++) {
    const t = line(r) ?? "";
    n += Math.max(0, t.length - contentStart(t, r === box.start)) + (t.length >= cols - 1 ? 0 : 1);
  }
  const t = line(row) ?? "";
  return n + Math.max(0, Math.min(col, t.length) - contentStart(t, row === box.start));
};

/** The arrow keys that move a cursor `delta` characters (right when positive). */
export const arrowWalk = (delta: number): string => (delta > 0 ? "\x1b[C" : "\x1b[D").repeat(Math.abs(delta));

/** A left click at a viewport cell, in the mouse encoding the app asked for. */
export const mouseClick = (col: number, row: number, encoding: string): { press: string; release: string } => {
  if (encoding === "SGR" || encoding === "SGR_PIXELS") {
    return { press: `\x1b[<0;${col + 1};${row + 1}M`, release: `\x1b[<0;${col + 1};${row + 1}m` };
  }
  const c = (v: number) => String.fromCharCode(Math.min(255, 32 + v));
  return { press: `\x1b[M${c(0)}${c(col + 1)}${c(row + 1)}`, release: `\x1b[M${c(3)}${c(col + 1)}${c(row + 1)}` };
};
