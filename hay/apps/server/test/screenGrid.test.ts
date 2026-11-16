// A serialized attach puts the cursor back where the live screen has it:
// replayed into a fresh terminal, the cursor and the text around it match.
import { beforeAll, describe, expect, it } from "vitest";
import { createScreenGrid, loadScreenGridDeps } from "../src/screenGrid";

type Term = {
  cols: number; rows: number;
  buffer: { active: { cursorX: number; cursorY: number; baseY: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined } };
  write(d: string, cb?: () => void): void;
};

let Terminal: new (o: Record<string, unknown>) => Term;
beforeAll(async () => {
  expect(await loadScreenGridDeps()).toBe(true);
  const h = await import("@xterm/headless") as { Terminal?: unknown; default?: { Terminal?: unknown } };
  Terminal = (h.Terminal ?? h.default?.Terminal) as typeof Terminal;
});

const snapshot = (cols: number, rows: number, output: string) => new Promise<string>((resolve, reject) => {
  const grid = createScreenGrid(cols, rows);
  if (!grid) { reject(new Error("no grid")); return; }
  grid.write(output);
  grid.serialize((data) => { grid.dispose(); data === null ? reject(new Error("no snapshot")) : resolve(data); });
});
const live = async (cols: number, rows: number, output: string) => {
  const t = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  await new Promise<void>((r) => t.write(output, r));
  return t;
};
const where = (t: Term) => {
  const b = t.buffer.active;
  return { x: b.cursorX, y: b.cursorY, row: b.getLine(b.baseY + b.cursorY)?.translateToString(true) };
};
const roundTrip = async (cols: number, rows: number, output: string) => {
  const replay = await live(cols, rows, await snapshot(cols, rows, output));
  return { want: where(await live(cols, rows, output)), got: where(replay) };
};

describe("a serialized attach keeps the cursor", () => {
  it("after a row written to the last column (agy's status line)", async () => {
    // agy's box: "> abc" between rules, the status line flush with the right
    // edge, then the cursor back after the "c" — as agy 1.5.9 draws it.
    const cols = 40;
    const status = "auto · Gemini 4 Carbon · high";
    const out = "\x1b[H\x1b[2J" + "─".repeat(cols) + "\r\n> abc\r\n" + "─".repeat(cols) + "\r\n"
      + `\x1b[${cols - status.length}C` + status + "\r\x1b[2A\x1b[5C";
    const { want, got } = await roundTrip(cols, 10, out);
    expect(want).toEqual({ x: 5, y: 1, row: "> abc" });
    expect(got).toEqual(want);
  });
  it("mid-row, with history above and empty rows below", async () => {
    let out = "";
    for (let i = 0; i < 30; i++) out += `line ${i}\r\n`;
    out += "> half typed\x1b[4D";
    const { want, got } = await roundTrip(40, 10, out);
    expect(got).toEqual(want);
  });
  it("on a short screen with nothing below the prompt", async () => {
    const { want, got } = await roundTrip(40, 10, "hello\r\n$ ls -la");
    expect(got).toEqual(want);
  });
  it("in the alternate screen", async () => {
    const { want, got } = await roundTrip(40, 10, "shell\r\n\x1b[?1049h\x1b[H\x1b[2Jfull screen app\x1b[5;7H");
    expect(got).toEqual(want);
  });
});
