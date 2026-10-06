// OSC 8 hyperlinks survive the serialized attach snapshot.
//
// A room's attach replay is the headless grid serialized by xterm's
// serialize addon, which carries colours and styles but not hyperlinks: a
// cell's link id (OSC 8) is dropped. Codex prints its markdown links as a
// TITLE with the URL riding underneath, so once a client attached — the
// usual way of reading a session — every link already on screen was plain
// text: "codex tile links are not clickable". Live output after the attach
// still carried them, which is why it looked intermittent.
//
// Rather than fork the addon, the serialized string is walked in step with
// the buffer it came from. The addon's emission is regular: per row, each
// cell of width > 0 either appends its characters or, when empty, is counted
// and later skipped with `ESC[nC` (after an optional `ESC[nX`); rows end
// with `\r\n`, or nothing when the next row is a wrap; width-0 cells (the
// second half of a wide char) are not emitted. So printable text maps onto
// cells one by one, and a link run can be wrapped where its first cell is
// consumed and closed where it ends. Any desync (a cell whose characters are
// not what the string says next) returns the original string unchanged — a
// snapshot without links beats a corrupted one.

export type LinkCell = { chars: string; width: number; urlId: number };

export type InjectOptions = {
  /** Cell at (buffer row, col) — null past the end. */
  getCell: (row: number, col: number) => LinkCell | null;
  cols: number;
  /** First buffer row the serialized string covers. */
  startRow: number;
  /** Number of buffer rows it covers. */
  rowCount: number;
  /** The link target for a cell's link id, if any. */
  uriOf: (urlId: number) => string | undefined;
};

const ESC = "\x1b";
const BEL = "\x07";

/** Length of the escape sequence starting at `i` (which is ESC). */
const escapeLength = (s: string, i: number): number => {
  const next = s[i + 1];
  if (next === "[") {
    let j = i + 2;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j + 1 - i;
      j++;
    }
    return s.length - i;
  }
  if (next === "]") {
    const bel = s.indexOf(BEL, i + 2);
    const st = s.indexOf(ESC + "\\", i + 2);
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
    if (end === -1) return s.length - i;
    return end + (s[end] === BEL ? 1 : 2) - i;
  }
  return Math.min(2, s.length - i);
};

/** `ESC[nC` → n, else 0. */
const cursorForward = (seq: string): number => {
  const m = /^\x1b\[(\d*)C$/.exec(seq);
  return m ? Math.max(1, Number(m[1] || 1)) : 0;
};

export const injectHyperlinks = (serialized: string, o: InjectOptions): string => {
  const endRow = o.startRow + o.rowCount; // exclusive
  let row = o.startRow;
  let col = 0;
  let out = "";
  let openId = 0;
  const open = (id: number): boolean => {
    const uri = o.uriOf(id);
    if (!uri) return false;
    out += `${ESC}]8;id=hop${id};${uri}${ESC}\\`;
    openId = id;
    return true;
  };
  const close = () => {
    if (openId) out += `${ESC}]8;;${ESC}\\`;
    openId = 0;
  };
  // The content cell at the cursor, skipping the placeholders a wide char
  // leaves behind. Null past the row's end.
  const contentCell = (): LinkCell | null => {
    while (col < o.cols) {
      const cell = o.getCell(row, col);
      if (!cell) return null;
      if (cell.width > 0) return cell;
      col++;
    }
    return null;
  };
  let i = 0;
  while (i < serialized.length) {
    const ch = serialized[i];
    if (ch === ESC) {
      const n = escapeLength(serialized, i);
      const seq = serialized.slice(i, i + n);
      // A link is a property of the characters written while it is open;
      // cursor moves and erases must not carry it, so close across them.
      // Styling (SGR) inside a run is fine: the id keeps the run one link.
      if (!/m$/.test(seq)) close();
      const fwd = cursorForward(seq);
      if (fwd && row < endRow) col = Math.min(o.cols, col + fwd);
      out += seq;
      i += n;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      close();
      out += ch;
      if (ch === "\n") { row++; col = 0; }
      i++;
      continue;
    }
    // Printable: the next content cell.
    if (row >= endRow) { close(); out += serialized.slice(i); return out; }
    if (col >= o.cols) { row++; col = 0; } // a wrapped row ran straight on
    const cell = contentCell();
    if (!cell || !cell.chars || !serialized.startsWith(cell.chars, i)) return serialized;
    if (cell.urlId !== openId) {
      close();
      if (cell.urlId) open(cell.urlId);
    }
    out += cell.chars;
    i += cell.chars.length;
    col += cell.width;
  }
  close();
  return out;
};
