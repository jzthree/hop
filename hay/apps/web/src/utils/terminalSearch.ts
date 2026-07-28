// Scrollback search over an xterm buffer — the one engine behind both the
// full-screen find bar and the live-tile find bar, so "find" behaves
// identically wherever a terminal is. Hand-rolled (no @xterm/addon-search):
// positions are absolute buffer rows, valid only until the next output or
// scrollback trim, so callers recompute before navigating.

type SearchableTerminal = {
  rows: number;
  buffer: { active: { length: number; getLine: (row: number) => { translateToString: (trim: boolean) => string } | undefined } };
  select: (col: number, row: number, len: number) => void;
  clearSelection: () => void;
  scrollToLine?: (line: number) => void;
};

export type SearchMatch = { row: number; col: number };

const MAX_MATCHES = 2000;

/** Case-insensitive scan of the whole buffer (scrollback included). */
export const collectTerminalMatches = (terminal: SearchableTerminal, query: string): SearchMatch[] => {
  if (!query) return [];
  const buffer = terminal.buffer.active;
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];
  for (let row = 0; row < buffer.length && matches.length < MAX_MATCHES; row++) {
    const text = (buffer.getLine(row)?.translateToString(true) ?? "").toLowerCase();
    let from = 0;
    while (matches.length < MAX_MATCHES) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      matches.push({ row, col: idx });
      from = idx + needle.length;
    }
  }
  return matches;
};

/**
 * Select match `idx` (wrapping) and centre it in the viewport. Returns the
 * normalized index, so callers can display "n of m".
 */
export const selectTerminalMatch = (
  terminal: SearchableTerminal,
  matches: SearchMatch[],
  idx: number,
  queryLen: number
): number => {
  if (matches.length === 0) return -1;
  const i = ((idx % matches.length) + matches.length) % matches.length;
  const m = matches[i];
  terminal.select(m.col, m.row, queryLen);
  terminal.scrollToLine?.(Math.max(0, m.row - Math.floor(terminal.rows / 2)));
  return i;
};
