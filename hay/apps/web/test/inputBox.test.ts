import { describe, expect, it } from "vitest";
import { arrowWalk, boxIndexAt, clickTargetAfter, hasWideChars, inputBoxRows, mouseClick, selectedCharCount, selectionInBox } from "../src/utils/inputBox";

// Claude's box: "❯" and a no-break space, continuation rows indented two
// spaces, between two rules.
const screen = (rows: string[]) => (r: number) => rows[r];
const RULE = "─".repeat(40);

describe("the agent's input box on screen", () => {
  const rows = ["● Done.", "", RULE, "❯ hello world from hop and a long", "  second line of the draft", RULE, "  ⏵⏵ auto mode on"];
  const line = screen(rows);
  it("is found around the cursor, and not when the cursor is elsewhere", () => {
    expect(inputBoxRows(line, 3)).toEqual({ start: 3, end: 4 });
    expect(inputBoxRows(line, 4)).toEqual({ start: 3, end: 4 });
    expect(inputBoxRows(line, 0)).toBeNull();
    expect(inputBoxRows(line, 6)).toBeNull();
  });
  it("counts the characters a selection covers: not the prompt, one for a row break", () => {
    const box = { start: 3, end: 4 };
    // "world" on the first row (cols 8–13).
    expect(selectedCharCount(line, { startRow: 3, startCol: 8, endRow: 3, endCol: 13 }, box, 80)).toBe(5);
    // From the prompt glyph: the glyph and its space are not text.
    expect(selectedCharCount(line, { startRow: 3, startCol: 0, endRow: 3, endCol: 7 }, box, 80)).toBe(5);
    // "long" + the break + "second": 4 + 1 + 6.
    expect(selectedCharCount(line, { startRow: 3, startCol: 29, endRow: 4, endCol: 8 }, box, 80)).toBe(11);
    // A row full to the edge was a long word cut there: no character at the break.
    const full = screen(["❯ " + "x".repeat(38), "  yy"]);
    expect(selectedCharCount(full, { startRow: 0, startCol: 38, endRow: 1, endCol: 4 }, { start: 0, end: 1 }, 40)).toBe(4);
  });
  it("a selection must lie inside the box", () => {
    expect(selectionInBox({ startRow: 3, startCol: 2, endRow: 3, endCol: 7 }, { start: 3, end: 4 })).toBe(true);
    expect(selectionInBox({ startRow: 0, startCol: 0, endRow: 3, endCol: 7 }, { start: 3, end: 4 })).toBe(false);
    expect(selectionInBox({ startRow: 3, startCol: 5, endRow: 3, endCol: 5 }, { start: 3, end: 4 })).toBe(false);
  });
  it("the click goes right after the selection, kept on the row's text", () => {
    expect(clickTargetAfter(line, { startRow: 3, startCol: 8, endRow: 3, endCol: 13 }, { start: 3, end: 4 })).toEqual({ row: 3, col: 13 });
    expect(clickTargetAfter(line, { startRow: 4, startCol: 2, endRow: 4, endCol: 79 }, { start: 3, end: 4 })).toEqual({ row: 4, col: rows[4].length });
  });
  it("a click is written in the app's mouse encoding", () => {
    expect(mouseClick(8, 21, "SGR")).toEqual({ press: "\x1b[<0;9;22M", release: "\x1b[<0;9;22m" });
    expect(mouseClick(8, 21, "DEFAULT")).toEqual({ press: "\x1b[M" + " " + String.fromCharCode(41) + String.fromCharCode(54), release: "\x1b[M" + "#" + String.fromCharCode(41) + String.fromCharCode(54) });
  });
});

describe("wide characters", () => {
  it("are noticed, so a replace among them is left to ordinary typing", () => {
    expect(hasWideChars("hello world")).toBe(false);
    expect(hasWideChars("改成中文")).toBe(true);
    expect(hasWideChars("ship it 🚀")).toBe(true);
    expect(hasWideChars("café — ok")).toBe(false);
  });
});

// Antigravity's box as agy 1.5 draws it in a 100-column terminal (recorded):
// "> " then the text; a wrap keeps its space at the row's end (trimmed off
// by translateToString), the next row indented two spaces.
describe("Antigravity's box, walked with arrow keys", () => {
  const cols = 100;
  const rows = ["  /some/dir/", "", "─".repeat(100), "> " + "w".repeat(60), "  " + "z".repeat(69), "─".repeat(100), "  Gemini 4 Carbon · medium"];
  const line = screen(rows);
  const box = inputBoxRows(line, 4)!;
  it("is found like Claude's", () => {
    expect(box).toEqual({ start: 3, end: 4 });
  });
  it("counts a cell's place in the text across the wrap (the kept space is one)", () => {
    expect(boxIndexAt(line, box, 3, 2, cols)).toBe(0);
    expect(boxIndexAt(line, box, 3, 62, cols)).toBe(60);
    expect(boxIndexAt(line, box, 4, 2, cols)).toBe(61);
    // agy showed its cursor at x=30 on row 2 after 40 Lefts from the end of
    // 130 characters: the insertion point is one cell right, index 90.
    expect(boxIndexAt(line, box, 4, 30 + 1, cols)).toBe(90);
    // Past a row's end is its end; the prompt glyph is the start.
    expect(boxIndexAt(line, box, 4, 99, cols)).toBe(130);
    expect(boxIndexAt(line, box, 3, 0, cols)).toBe(0);
  });
  it("a full row (a word cut at the edge) adds no break", () => {
    const full = screen(["> " + "x".repeat(98), "  yy"]);
    expect(boxIndexAt(full, { start: 0, end: 1 }, 1, 3, cols)).toBe(99);
  });
  it("walks right or left by arrow keys", () => {
    expect(arrowWalk(2)).toBe("\x1b[C\x1b[C");
    expect(arrowWalk(-3)).toBe("\x1b[D\x1b[D\x1b[D");
    expect(arrowWalk(0)).toBe("");
  });
});
