// LaTeX in the terminal becomes a hover target, the way URLs become links:
// an xterm link provider scans the logical line under the pointer (soft
// wraps joined; a `$$`/`\[` block followed across the rows it spans), and
// each span found by utils/mathDetect is a link whose hover shows the
// KaTeX-rendered formula in the shared tooltip and whose click pins it.
import type { IBufferLine, IDisposable, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { findMathSpans } from "./mathDetect";
import type { MathTip } from "./mathTooltip";

const MAX_WRAP_ROWS = 12;      // a logical line joined from soft wraps
const MAX_BLOCK_ROWS = 14;     // a $$ … $$ block followed across hard rows

type Piece = { row: number; from: number; to: number }; // text offsets covered by a buffer row

const lineText = (line: IBufferLine | undefined): string => (line ? line.translateToString(false) : "");

/** Buffer rows [start, end] making up the logical line containing `y` (0-based). */
const logicalLine = (term: Terminal, y: number): { start: number; end: number } => {
  const buf = term.buffer.active;
  let start = y;
  let hops = 0;
  while (start > 0 && hops < MAX_WRAP_ROWS && buf.getLine(start)?.isWrapped) { start -= 1; hops += 1; }
  let end = y;
  hops = 0;
  while (end + 1 < buf.length && hops < MAX_WRAP_ROWS && buf.getLine(end + 1)?.isWrapped) { end += 1; hops += 1; }
  return { start, end };
};

/** Join rows [start, end] into one string, remembering which offsets each row covers. */
const joinRows = (term: Terminal, start: number, end: number, hard: boolean): { text: string; pieces: Piece[] } => {
  const buf = term.buffer.active;
  let text = "";
  const pieces: Piece[] = [];
  for (let r = start; r <= end; r += 1) {
    const raw = lineText(buf.getLine(r));
    // Soft-wrapped rows continue mid-word: keep every column. Hard rows are
    // separate lines of text: trim the right edge and add the newline back,
    // so `$$` blocks read as the author wrote them.
    const piece = hard ? raw.replace(/\s+$/, "") + "\n" : raw;
    pieces.push({ row: r, from: text.length, to: text.length + piece.length });
    text += piece;
  }
  return { text, pieces };
};

/** Map a text offset to a 1-based (x, y) buffer cell. */
const cellAt = (pieces: Piece[], offset: number): { x: number; y: number } | null => {
  for (const p of pieces) {
    if (offset >= p.from && offset < p.to) return { x: offset - p.from + 1, y: p.row + 1 };
  }
  const last = pieces[pieces.length - 1];
  return last ? { x: Math.max(1, last.to - last.from), y: last.row + 1 } : null;
};

const OPENERS = /\$\$|\\\[/;
const CLOSERS = /\$\$|\\\]/;

export const createMathLinkProvider = (term: Terminal, tip: MathTip): ILinkProvider => ({
  provideLinks(bufferLineNumber, callback) {
    const y = bufferLineNumber - 1; // xterm hands out 1-based line numbers
    const buf = term.buffer.active;
    if (y < 0 || y >= buf.length) { callback(undefined); return; }

    // The logical line, and — when a display block opens or is open here —
    // the hard rows the block spans as well.
    let { start, end } = logicalLine(term, y);
    let hard = false;
    const own = joinRows(term, start, end, false).text;
    const opens = (OPENERS.exec(own) !== null) && (own.match(/\$\$/g) || []).length % 2 === 1 || (/\\\[/.test(own) && !/\\\]/.test(own));
    if (opens) {
      // Follow the block down to its closer.
      let r = end;
      while (r + 1 < buf.length && r - end < MAX_BLOCK_ROWS) {
        r += 1;
        if (CLOSERS.test(lineText(buf.getLine(r)))) break;
      }
      end = r;
      hard = true;
    } else {
      // Inside or at the end of a block opened above? Walk up to the opener.
      let r = start;
      let found = -1;
      while (r > 0 && start - r < MAX_BLOCK_ROWS) {
        r -= 1;
        const t = lineText(buf.getLine(r));
        if (CLOSERS.test(t) && !OPENERS.test(t)) break;          // a closed block above; not ours
        if (OPENERS.test(t)) { found = r; break; }
      }
      if (found >= 0) {
        const opener = lineText(buf.getLine(found));
        const closedOnSameRow = (opener.match(/\$\$/g) || []).length >= 2 || (/\\\[/.test(opener) && /\\\]/.test(opener));
        if (!closedOnSameRow) {
          start = found;
          let e = y;
          while (e + 1 < buf.length && e - found < MAX_BLOCK_ROWS && !CLOSERS.test(lineText(buf.getLine(e)))) e += 1;
          end = e;
          hard = true;
        }
      }
    }

    const { text, pieces } = joinRows(term, start, end, hard);
    const spans = findMathSpans(text);
    if (!spans.length) { callback(undefined); return; }
    const links: ILink[] = [];
    for (const sp of spans) {
      const a = cellAt(pieces, sp.start);
      const b = cellAt(pieces, Math.max(sp.start, sp.end - 1));
      if (!a || !b) continue;
      // Only spans touching the requested row matter for this callback.
      if (bufferLineNumber < a.y || bufferLineNumber > b.y) continue;
      const tex = sp.tex;
      const display = sp.display;
      links.push({
        range: { start: a, end: b },
        text: text.slice(sp.start, sp.end),
        decorations: { pointerCursor: true, underline: true },
        activate: () => { tip.pin(); },
        hover: (event) => { tip.show(tex, display, { x: event.clientX, y: event.clientY }); },
        leave: () => { tip.hide(); }
      });
    }
    callback(links.length ? links : undefined);
  }
});

/** Register on a terminal; returns the disposable xterm hands back. */
export const enableMathHover = (term: Terminal, tip: MathTip): IDisposable =>
  term.registerLinkProvider(createMathLinkProvider(term, tip));
