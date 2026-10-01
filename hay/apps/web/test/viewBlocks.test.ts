import { describe, expect, it } from "vitest";
import { enableViewBlocks, findViewBoxes, fmtBytes, parseViewBlock, renderViewBlock, viewKind } from "../src/utils/viewBlocks";

const b64 = (o: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))));

describe("parseViewBlock", () => {
  it("reads the CLI's payload and rejects anything else", () => {
    const p = parseViewBlock(`hop-view;${b64({ session: "s_1", name: "roc.png", title: "ROC curve", bytes: 2048, url: "/view/s_1/roc.png/inline" })}`);
    expect(p).toEqual({ session: "s_1", name: "roc.png", title: "ROC curve", bytes: 2048, url: "/view/s_1/roc.png/inline" });
    expect(parseViewBlock("hop-view;not base64!")).toBe(null);
    expect(parseViewBlock(`hop-view;${b64({ name: "x" })}`)).toBe(null);
    expect(parseViewBlock("something-else;abc")).toBe(null);
  });
  it("sizes and kinds", () => {
    expect(fmtBytes(512)).toBe("512 B"); expect(fmtBytes(537_000)).toBe("524 KB"); expect(fmtBytes(3_000_000)).toBe("2.9 MB"); expect(fmtBytes(undefined)).toBe("");
    expect(viewKind("a.PNG")).toBe("image"); expect(viewKind("r.pdf")).toBe("pdf"); expect(viewKind("x.html")).toBe("html"); expect(viewKind("n.md")).toBe("markdown"); expect(viewKind("z.csv")).toBe("file");
  });
});

describe("the block", () => {
  it("renders a card with title, meta and an Open button that calls back", () => {
    const el = document.createElement("div");
    const opened: string[] = [];
    const block = { session: "s_1", name: "report.html", title: "Q3 analysis", bytes: 10_240, url: "/view/s_1/report.html/inline" };
    renderViewBlock(el, block, (b) => opened.push(b.name));
    expect(el.querySelector(".view-block-title")?.textContent).toBe("Q3 analysis");
    expect(el.querySelector(".view-block-meta")?.textContent).toBe("report.html · 10 KB");
    (el.querySelector(".view-block") as HTMLElement).click();
    expect(opened).toEqual(["report.html"]);
    renderViewBlock(el, block, () => {});                       // a re-render keeps one card
    expect(el.querySelectorAll(".view-block").length).toBe(1);
  });
  it("an image delivery shows a thumbnail", () => {
    const el = document.createElement("div");
    renderViewBlock(el, { session: "s", name: "roc.png", url: "/view/s/roc.png/inline" }, () => {});
    expect((el.querySelector("img.view-block-thumb") as HTMLImageElement).getAttribute("src")).toBe("/view/s/roc.png/inline");
  });
  it("the OSC handler anchors a decoration at the cursor line and swallows the sequence", () => {
    let osc: ((data: string) => boolean) | null = null;
    const registered: unknown[] = [];
    const term = {
      cols: 120, rows: 24,
      buffer: { active: { baseY: 0, cursorY: 0, length: 1, getLine: () => ({ translateToString: () => "" }) } },
      parser: { registerOscHandler: (_id: number, cb: (d: string) => boolean) => { osc = cb; return { dispose: () => { osc = null; } }; } },
      registerMarker: () => ({ dispose: () => {}, line: 0 }),
      registerDecoration: (o: unknown) => { registered.push(o); return { onRender: () => {}, dispose: () => {} }; }
    };
    const off = enableViewBlocks(term, () => {});
    expect(osc!(`hop-view;${b64({ session: "s", name: "a.pdf", url: "/u" })}`)).toBe(true);
    expect(registered.length).toBe(1);
    expect((registered[0] as { height: number; width: number }).height).toBe(4);
    expect((registered[0] as { width: number }).width).toBe(72);
    expect(osc!("hop-view;garbage")).toBe(true);
    expect(registered.length).toBe(1);
    off();
    expect(osc).toBe(null);
  });
});

describe("findViewBoxes — the text box is recognised in a replayed or scrolled buffer", () => {
  it("reads title, file, size and the URL printed above the box", () => {
    const lines = [
      "View: https://hop.example/view/s_256f2c370d/report.html/inline",
      "┌─ ◧ hop view ───────────────────────────────────┐",
      "│ Probe report: the before and after              │",
      "│ report.html · 1 KB                              │",
      "└─────────────────────────────────────────────────┘",
      "Session: s_256f2c370d (this terminal)",
      "View: https://hop.example/view/s_256f2c370d/dot.png/inline",
      "┌─ ◧ hop view ───────────────────────────────────┐",
      "│ dot.png                                         │",
      "│ hop view · 1 KB                                 │",
      "└─────────────────────────────────────────────────┘"
    ];
    const found = findViewBoxes(lines);
    expect(found.map((f) => f.top)).toEqual([1, 7]);
    expect(found[0].block).toEqual({ session: "s_256f2c370d", name: "report.html", url: "https://hop.example/view/s_256f2c370d/report.html/inline", title: "Probe report: the before and after", bytes: 1024 });
    expect(found[1].block.title).toBe(undefined);
    expect(found[1].block.name).toBe("dot.png");
  });
  it("a box with no View line above it is not a delivery", () => {
    expect(findViewBoxes(["┌─ ◧ hop view ──┐", "│ x │", "│ y │", "└───┘"])).toEqual([]);
  });
});
