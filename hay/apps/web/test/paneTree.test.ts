import { describe, it, expect } from "vitest";
import {
  PRIMARY_PANE,
  cycleLeaf,
  dropZoneAt,
  leafIds,
  leafRects,
  moveLeaf,
  neighborLeaf,
  paneTreeValid,
  removeLeaf,
  splitLeaf,
  type PaneLeaf,
  type PaneNode
} from "../src/utils/paneTree";

const leaf = (id: string, session: string | null = id): PaneLeaf => ({ kind: "leaf", id, session });
const split = (id: string, dir: "row" | "col", a: PaneNode, b: PaneNode, ratio = 0.5): PaneNode => ({
  kind: "split",
  id,
  dir,
  ratio,
  a,
  b
});

describe("splitLeaf", () => {
  it("puts the new pane on the asked side of any leaf — the primary included", () => {
    const left = splitLeaf(PRIMARY_PANE, "primary", "left", leaf("x"));
    expect(left.kind).toBe("split");
    if (left.kind !== "split") return;
    expect(left.dir).toBe("row");
    expect(left.a).toEqual(leaf("x"));
    expect(left.b).toEqual(PRIMARY_PANE);

    const below = splitLeaf(PRIMARY_PANE, "primary", "bottom", leaf("y"));
    expect(leafIds(below)).toEqual(["primary", "y"]);
    if (below.kind === "split") expect(below.dir).toBe("col");
  });

  it("nests: splitting one leaf leaves the rest of the tree alone", () => {
    const tree = split("root", "row", PRIMARY_PANE, leaf("x"));
    const next = splitLeaf(tree, "x", "top", leaf("z"));
    expect(leafIds(next)).toEqual(["primary", "z", "x"]);
    if (next.kind !== "split") return;
    expect(next.a).toBe(PRIMARY_PANE);
    expect(next.b.kind).toBe("split");
    if (next.b.kind === "split") expect(next.b.dir).toBe("col");
  });
});

describe("removeLeaf", () => {
  it("collapses the parent split into the sibling", () => {
    const tree = split("root", "row", PRIMARY_PANE, split("s", "col", leaf("x"), leaf("y")));
    const next = removeLeaf(tree, "x");
    expect(next && leafIds(next)).toEqual(["primary", "y"]);
    if (next?.kind === "split") expect(next.b).toEqual(leaf("y"));
  });

  it("removing the only leaf leaves nothing", () => {
    expect(removeLeaf(PRIMARY_PANE, "primary")).toBeNull();
  });
});

describe("moveLeaf", () => {
  const three = () => split("root", "row", split("s", "row", PRIMARY_PANE, leaf("x")), leaf("y"));

  it("an edge drop re-docks the pane beside the target — the primary can end up anywhere", () => {
    const next = moveLeaf(three(), "y", "primary", "left");
    expect(leafIds(next)).toEqual(["y", "primary", "x"]);
    const primaryLast = moveLeaf(three(), "primary", "y", "right");
    expect(leafIds(primaryLast)).toEqual(["x", "y", "primary"]);
  });

  it("a centre drop swaps the two panes in place", () => {
    const next = moveLeaf(three(), "x", "y", "center");
    expect(leafIds(next)).toEqual(["primary", "y", "x"]);
  });

  it("dropping on itself or on an unknown pane changes nothing", () => {
    const tree = three();
    expect(moveLeaf(tree, "x", "x", "left")).toBe(tree);
    expect(moveLeaf(tree, "x", "nope", "left")).toBe(tree);
  });
});

describe("leafRects + neighborLeaf", () => {
  // primary on the left; x stacked over y on the right.
  const tree = split("root", "row", PRIMARY_PANE, split("s", "col", leaf("x"), leaf("y")));

  it("lays panes out in unit coordinates", () => {
    const r = leafRects(tree);
    expect(r.get("primary")).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(r.get("x")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(r.get("y")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it("finds the pane in each direction, and nothing past the border", () => {
    expect(neighborLeaf(tree, "x", "down")).toBe("y");
    expect(neighborLeaf(tree, "y", "up")).toBe("x");
    expect(neighborLeaf(tree, "x", "left")).toBe("primary");
    expect(neighborLeaf(tree, "y", "left")).toBe("primary");
    expect(["x", "y"]).toContain(neighborLeaf(tree, "primary", "right"));
    expect(neighborLeaf(tree, "primary", "left")).toBeNull();
    expect(neighborLeaf(tree, "y", "right")).toBeNull();
    expect(neighborLeaf(tree, "y", "down")).toBeNull();
  });

  it("prefers the pane sharing the most edge", () => {
    // primary on the left; on the right, x takes the top 80% and y the rest.
    const lopsided = split("root", "row", PRIMARY_PANE, split("s", "col", leaf("x"), leaf("y"), 0.8));
    expect(neighborLeaf(lopsided, "primary", "right")).toBe("x");
  });
});

describe("cycleLeaf", () => {
  it("walks the visual order and wraps", () => {
    const tree = split("root", "row", PRIMARY_PANE, split("s", "col", leaf("x"), leaf("y")));
    expect(cycleLeaf(tree, "primary", 1)).toBe("x");
    expect(cycleLeaf(tree, "y", 1)).toBe("primary");
    expect(cycleLeaf(tree, "primary", -1)).toBe("y");
  });
});

describe("dropZoneAt", () => {
  it("names the nearest edge inside the band, else the centre", () => {
    expect(dropZoneAt(0.1, 0.5)).toBe("left");
    expect(dropZoneAt(0.5, 0.9)).toBe("bottom");
    expect(dropZoneAt(0.5, 0.5)).toBe("center");
    expect(dropZoneAt(0.95, 0.1)).toBe("right");
  });
});

describe("paneTreeValid", () => {
  it("accepts a real tree and rejects degenerate ratios or shapes", () => {
    expect(paneTreeValid(split("root", "row", PRIMARY_PANE, leaf("x")))).toBe(true);
    expect(paneTreeValid(split("root", "row", PRIMARY_PANE, leaf("x"), 1))).toBe(false);
    expect(paneTreeValid({ kind: "nope" })).toBe(false);
    expect(paneTreeValid(null)).toBe(false);
  });
});
