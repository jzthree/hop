// OSC 8 links survive a serialize → inject → replay round trip through real
// xterm: the replayed terminal's cells carry the same targets, and its text
// is the serialized terminal's text.
import { describe, expect, it } from "vitest";
import { injectHyperlinks } from "../src/hyperlinks";

type Cell = { getChars(): string; getWidth(): number; extended?: { urlId?: number } };
type Term = {
  rows: number; cols: number;
  buffer: { active: { length: number; getLine(y: number): { getCell(x: number): Cell | undefined; translateToString(trim?: boolean): string } | undefined } };
  write(d: string, cb?: () => void): void;
  loadAddon(a: unknown): void;
  _core: { _oscLinkService: { getLinkData(id: number): { uri: string } | undefined } };
};

const g = globalThis as Record<string, unknown>;
if (!g.window) g.window = g;
if (!g.self) g.self = g;

const make = async (cols = 40, rows = 6, scrollback = 100) => {
  // UMD/CJS under ESM interop: the named exports may live on `default`
  // (screenGrid.ts resolves them the same way).
  const h = await import("@xterm/headless") as { Terminal?: unknown; default?: { Terminal?: unknown } };
  const sz = await import("@xterm/addon-serialize") as { SerializeAddon?: unknown; default?: { SerializeAddon?: unknown } };
  const Terminal = (h.Terminal ?? h.default?.Terminal) as new (o: Record<string, unknown>) => Term;
  const SerializeAddon = (sz.SerializeAddon ?? sz.default?.SerializeAddon) as new () => { serialize(o: { scrollback?: number }): string };
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  const addon = new SerializeAddon();
  term.loadAddon(addon);
  const write = (d: string) => new Promise<void>((r) => term.write(d, r));
  const serialize = (sb = scrollback) => {
    const s = addon.serialize({ scrollback: sb });
    const buf = term.buffer.active;
    const rowCount = Math.min(buf.length, sb + term.rows);
    return injectHyperlinks(s, {
      cols: term.cols, startRow: buf.length - rowCount, rowCount,
      getCell: (y, x) => { const c = buf.getLine(y)?.getCell(x); return c ? { chars: c.getChars(), width: c.getWidth(), urlId: c.extended?.urlId || 0 } : null; },
      uriOf: (id) => term._core._oscLinkService.getLinkData(id)?.uri
    });
  };
  return { term, write, serialize };
};

const linksOf = (term: Term) => {
  const buf = term.buffer.active;
  const out: { row: number; text: string; uri: string }[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)!;
    let cur: { row: number; text: string; uri: string } | null = null;
    for (let x = 0; x < term.cols; x++) {
      const c = line.getCell(x)!;
      const uri = c.extended?.urlId ? term._core._oscLinkService.getLinkData(c.extended.urlId)?.uri || "" : "";
      if (uri && cur && cur.uri === uri) cur.text += c.getChars();
      else if (uri) { cur = { row: y, text: c.getChars(), uri }; out.push(cur); }
      else cur = null;
    }
  }
  return out;
};
const textOf = (term: Term) => Array.from({ length: term.buffer.active.length }, (_, y) => term.buffer.active.getLine(y)!.translateToString(true)).join("\n").replace(/\n+$/, "");

const L = (uri: string, text: string) => `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;

describe("injectHyperlinks — OSC 8 links ride the serialized snapshot", () => {
  it("a titled link (Codex's markdown link) comes back as a link, text intact", async () => {
    const a = await make(80);
    await a.write(`• Wrote the plan: ${L("https://hop.zhoulab.io/view/s_1/plan.html/inline", "proposed next experiments")}.\r\nnext line\r\n`);
    const b = await make(80);
    await b.write(a.serialize());
    expect(textOf(b.term)).toBe(textOf(a.term));
    expect(linksOf(b.term)).toEqual([{ row: 0, text: "proposed next experiments", uri: "https://hop.zhoulab.io/view/s_1/plan.html/inline" }]);
  });

  it("colours inside a link, empty gaps, wide characters and a wrapped row all keep their places", async () => {
    const a = await make(20, 5);
    await a.write(`\x1b[31mred\x1b[0m   ${L("https://x.test/a", "li\x1b[1mnk\x1b[22m 漢字")}  tail\r\n`);
    await a.write(`${L("https://x.test/b", "0123456789abcdefghijKLMNOP")}\r\n`); // wraps at 20
    await a.write(`gap ${L("https://x.test/c", "c")}\x1b[5C${L("https://x.test/d", "d")}\r\n`);
    const b = await make(20, 5);
    await b.write(a.serialize());
    expect(textOf(b.term)).toBe(textOf(a.term));
    expect(linksOf(b.term)).toEqual(linksOf(a.term));
    expect(linksOf(b.term).map((l) => l.text)).toEqual(["link 漢字", "0123456789abcdefghij", "KLMNOP", "c", "d"]);
  });

  it("a snapshot with scrollback trimmed off keeps the links of the rows it covers", async () => {
    const a = await make(30, 3, 50);
    for (let i = 0; i < 8; i++) await a.write(`${L(`https://x.test/${i}`, `line ${i}`)}\r\n`);
    const b = await make(30, 3, 50);
    await b.write(a.serialize(2)); // 2 rows of history + 3 of screen
    expect(linksOf(b.term).map((l) => l.uri)).toEqual(["https://x.test/4", "https://x.test/5", "https://x.test/6", "https://x.test/7"]);
  });

  it("a desync returns the string untouched rather than a corrupted screen", () => {
    const s = "\x1b[31mhello\x1b[0m";
    const out = injectHyperlinks(s, { cols: 10, startRow: 0, rowCount: 1, getCell: () => ({ chars: "x", width: 1, urlId: 1 }), uriOf: () => "https://x" });
    expect(out).toBe(s);
  });
});
