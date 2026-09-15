import { describe, expect, it } from "vitest";
import { urlAtCell } from "../src/utils/urlAtCell";

const COLS = 42;
const pad = (s: string) => s.padEnd(COLS, " ");
const buf = (rows: Array<[string, boolean?]>) => {
  const lines = rows.map(([text, wrapped]) => ({ text: pad(text), wrapped: !!wrapped }));
  return { get: (r: number) => lines[r] ?? null, length: lines.length };
};

describe("urlAtCell", () => {
  it("finds a URL on one row and trims trailing punctuation", () => {
    const b = buf([["see https://example.com/a/b, then"]]);
    expect(urlAtCell(b.get, b.length, COLS, 0, 10)).toBe("https://example.com/a/b");
    expect(urlAtCell(b.get, b.length, COLS, 0, 2)).toBeNull();
  });

  it("joins rows the terminal soft-wrapped (isWrapped), like the addon does", () => {
    const b = buf([["https://example.com/0123456789012345678901"], ["23456789/tail ok", true]]);
    expect(urlAtCell(b.get, b.length, COLS, 0, 5)).toBe("https://example.com/012345678901234567890123456789/tail");
    expect(urlAtCell(b.get, b.length, COLS, 1, 3)).toBe("https://example.com/012345678901234567890123456789/tail");
  });

  it("joins a HARD break a TUI made at the right edge (Codex): no wrapped flag, continuation indented", () => {
    // Row 0 fills the width; row 1 is positioned by the app with an indent.
    const b = buf([["https://auth.example.com/authorize?client="], ["  abcdef&state=xyz"]]);
    expect(b.get(0)!.text.replace(/\s+$/, "").length).toBe(COLS);
    expect(urlAtCell(b.get, b.length, COLS, 0, 12)).toBe("https://auth.example.com/authorize?client=abcdef&state=xyz");
    // A click on the continuation row resolves to the same URL.
    expect(urlAtCell(b.get, b.length, COLS, 1, 6)).toBe("https://auth.example.com/authorize?client=abcdef&state=xyz");
  });

  it("does not glue an unrelated next row onto a URL that merely ends at the edge", () => {
    const b = buf([["https://example.com/0123456789012345678901"], ["Then the agent continued."]]);
    expect(b.get(0)!.text.replace(/\s+$/, "").length).toBe(COLS);
    expect(urlAtCell(b.get, b.length, COLS, 0, 5)).toBe("https://example.com/0123456789012345678901");
  });

  it("a long unpunctuated remainder still joins; a short word does not", () => {
    const b = buf([["https://example.com/0123456789012345678901"], ["  abcdefghijklmnop rest"]]);
    expect(urlAtCell(b.get, b.length, COLS, 0, 5)).toBe("https://example.com/0123456789012345678901abcdefghijklmnop");
    const c = buf([["https://example.com/0123456789012345678901"], ["  docs are here"]]);
    expect(urlAtCell(c.get, c.length, COLS, 0, 5)).toBe("https://example.com/0123456789012345678901");
  });

  it("returns null with no URL under the cell", () => {
    const b = buf([["nothing here"]]);
    expect(urlAtCell(b.get, b.length, COLS, 0, 3)).toBeNull();
  });
});
