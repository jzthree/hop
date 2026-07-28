import { describe, it, expect } from "vitest";
import { collectTerminalMatches, selectTerminalMatch } from "../src/utils/terminalSearch";

const mkTerm = (lines: string[]) => {
  const selections: Array<{ col: number; row: number; len: number }> = [];
  const scrolls: number[] = [];
  return {
    rows: 10,
    buffer: { active: { length: lines.length, getLine: (r: number) => ({ translateToString: () => lines[r] ?? "" }) } },
    select: (col: number, row: number, len: number) => selections.push({ col, row, len }),
    clearSelection: () => { /* not under test */ },
    scrollToLine: (l: number) => scrolls.push(l),
    selections,
    scrolls
  };
};

describe("terminalSearch", () => {
  it("finds case-insensitive matches with buffer-absolute positions", () => {
    const t = mkTerm(["alpha beta", "BETA beta", "nothing"]);
    const m = collectTerminalMatches(t, "beta");
    expect(m).toEqual([{ row: 0, col: 6 }, { row: 1, col: 0 }, { row: 1, col: 5 }]);
  });

  it("selects with wrapping and centres the match", () => {
    const t = mkTerm(["x", "match here", "y"]);
    const m = collectTerminalMatches(t, "match");
    expect(selectTerminalMatch(t, m, -1, 5)).toBe(0); // wraps to the last (only) match
    expect(t.selections[0]).toEqual({ col: 0, row: 1, len: 5 });
  });

  it("empty query and empty buffer are safe", () => {
    const t = mkTerm([]);
    expect(collectTerminalMatches(t, "")).toEqual([]);
    expect(selectTerminalMatch(t, [], 0, 0)).toBe(-1);
  });
});
