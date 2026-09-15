// The URL under a terminal cell, reassembled across the rows it spans.
//
// xterm's web-links addon joins rows only when the terminal itself wrapped
// them (the `isWrapped` flag). A TUI that lays out its own text — Codex,
// ratatui apps generally — breaks a long URL at the column boundary with a
// HARD break: each row is positioned on its own, nothing is flagged wrapped,
// and the addon sees two unrelated lines. In a wide full-screen terminal the
// URL fits one row and clicks work; in a narrow tile it breaks and the same
// click opens a truncated fragment or nothing. So this joins a row that runs
// to the right edge with the row below when the continuation looks like the
// rest of a URL, and searches the joined text for the URL covering the cell.

export type CellLine = { text: string; wrapped: boolean };

/**
 * The (row, col) under a viewport point. With the DOM renderer each row is
 * an element, so the row comes from whichever one contains the point —
 * exact even when the terminal is scaled, cropped, or bottom-anchored
 * inside a tile, where dividing the screen's height by `rows` was off by
 * enough to land on the wrong line. Canvas/WebGL renderers keep no row
 * elements; those fall back to the proportional split.
 */
export const cellAtPoint = (
  screen: HTMLElement,
  rowsEl: HTMLElement | null,
  cols: number,
  rows: number,
  clientX: number,
  clientY: number
): { row: number; col: number } | null => {
  const sr = screen.getBoundingClientRect();
  if (clientX < sr.left || clientX >= sr.right) return null;
  const col = Math.floor(((clientX - sr.left) / sr.width) * cols);
  const kids = rowsEl ? Array.from(rowsEl.children) as HTMLElement[] : [];
  if (kids.length) {
    const row = kids.findIndex((el) => { const r = el.getBoundingClientRect(); return clientY >= r.top && clientY < r.bottom; });
    return row < 0 ? null : { row, col };
  }
  if (clientY < sr.top || clientY >= sr.bottom) return null;
  return { row: Math.floor(((clientY - sr.top) / sr.height) * rows), col };
};

const URL_CHAR = /^[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]/;
const URL_RE = /https?:\/\/[^\s"'`<>]+/g;

/**
 * Does `next` read as the hard-broken continuation of `prev` at width `cols`?
 * Three signs together: `prev` runs to the right edge, the URL on it is what
 * reaches the edge (not prose that happens to end there), and the first
 * token of `next` looks like more URL — punctuation a URL carries, or a
 * token too long for a word. "Then the agent continued." after a URL that
 * ends at the edge is prose, and stays separate.
 */
const hardContinues = (prev: CellLine | null, next: CellLine | null, cols: number) => {
  if (!prev || !next) return false;
  const prevText = prev.text.replace(/\s+$/, "");
  if (prevText.length < cols - 1) return false;
  let endsInUrl = false;
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(prevText)) !== null) endsInUrl = m.index + m[0].length >= prevText.length;
  if (!endsInUrl) return false;
  const token = next.text.replace(/^\s+/, "").split(/\s/)[0] || "";
  return token.length > 0 && URL_CHAR.test(token) && (/[/?=&%#._-]/.test(token) || token.length > 12);
};

/**
 * @param getLine buffer accessor (absolute row → line, or null)
 * @param length  buffer length (rows)
 * @param cols    terminal width
 * @param bufferRow / col  the cell clicked
 */
export const urlAtCell = (
  getLine: (row: number) => CellLine | null,
  length: number,
  cols: number,
  bufferRow: number,
  col: number
): string | null => {
  const at = (r: number) => (r >= 0 && r < length ? getLine(r) : null);
  if (!at(bufferRow)) return null;
  // Walk up to the logical start: soft wraps, or hard continuations.
  let start = bufferRow;
  let hops = 0;
  while (start > 0 && hops < 6) {
    const cur = at(start);
    const prev = at(start - 1);
    if (!cur || !prev) break;
    if (cur.wrapped || hardContinues(prev, cur, cols)) { start--; hops++; } else break;
  }
  // Walk down, joining; hard continuations drop their indentation.
  let text = "";
  let offset = -1;
  let r = start;
  let joined = 0;
  while (r < length && joined < 8) {
    const line = at(r);
    if (!line) break;
    if (r > start) {
      const prev = at(r - 1);
      if (!(line.wrapped || hardContinues(prev, line, cols))) break;
    }
    const lead = line.wrapped || r === start ? 0 : line.text.length - line.text.replace(/^\s+/, "").length;
    const piece = line.text.slice(lead);
    if (r === bufferRow) offset = text.length + Math.max(0, Math.min(col, cols - 1) - lead);
    text += piece;
    r++;
    joined++;
  }
  if (offset < 0) return null;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (offset >= m.index && offset <= m.index + m[0].length) {
      return m[0].replace(/[.,;:!?)\]}]+$/, "");
    }
  }
  return null;
};
