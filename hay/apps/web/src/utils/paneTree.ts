// Pane layout tree — the model behind iTerm-style split panes.
//
// A full binary tree: every split has a direction, a ratio and two children;
// every leaf shows one session. The PRIMARY leaf (session: null) is the
// full-featured terminal; "" marks an empty leaf still waiting for a session.
// Everything here is pure so the layout can be reasoned about (and tested)
// without a DOM: splitting on any side, pruning, re-docking a pane onto
// another's edge, and finding the neighbour in a direction.

export type PaneLeaf = { kind: "leaf"; id: string; session: string | null };
export type PaneSplit = {
  kind: "split";
  id: string;
  dir: "row" | "col";
  ratio: number;
  a: PaneNode;
  b: PaneNode;
};
export type PaneNode = PaneLeaf | PaneSplit;

/** Where a new (or moved) pane lands relative to an existing one. */
export type Side = "left" | "right" | "top" | "bottom";
/** A drop target: an edge (split there) or the centre (trade places). */
export type DropZone = Side | "center";
/** Keyboard navigation between panes. */
export type Direction = "left" | "right" | "up" | "down";

export const PRIMARY_PANE: PaneLeaf = { kind: "leaf", id: "primary", session: null };
export const newPaneId = () => `p${Math.random().toString(36).slice(2, 8)}`;

export const paneTreeValid = (n: unknown): n is PaneNode => {
  const x = n as PaneNode;
  if (!x || typeof x !== "object") return false;
  if (x.kind === "leaf") return typeof x.id === "string" && (x.session === null || typeof x.session === "string");
  if (x.kind === "split") {
    return (
      (x.dir === "row" || x.dir === "col") &&
      typeof x.ratio === "number" &&
      x.ratio > 0 &&
      x.ratio < 1 &&
      paneTreeValid(x.a) &&
      paneTreeValid(x.b)
    );
  }
  return false;
};

export const paneTreeHasPrimary = (n: PaneNode): boolean =>
  n.kind === "leaf" ? n.session === null : paneTreeHasPrimary(n.a) || paneTreeHasPrimary(n.b);

/** In-order leaves = visual left-to-right / top-to-bottom order. */
export const leafIds = (n: PaneNode): string[] =>
  n.kind === "leaf" ? [n.id] : [...leafIds(n.a), ...leafIds(n.b)];

export const findLeaf = (n: PaneNode, id: string): PaneLeaf | null => {
  if (n.kind === "leaf") return n.id === id ? n : null;
  return findLeaf(n.a, id) ?? findLeaf(n.b, id);
};

export const setLeafSession = (n: PaneNode, id: string, session: string): PaneNode =>
  n.kind === "leaf"
    ? n.id === id
      ? { ...n, session }
      : n
    : { ...n, a: setLeafSession(n.a, id, session), b: setLeafSession(n.b, id, session) };

export const setSplitRatio = (n: PaneNode, id: string, ratio: number): PaneNode =>
  n.kind === "split"
    ? n.id === id
      ? { ...n, ratio }
      : { ...n, a: setSplitRatio(n.a, id, ratio), b: setSplitRatio(n.b, id, ratio) }
    : n;

/**
 * Replace a leaf with a split holding it and `fresh`, `fresh` on the given
 * side. Any leaf — the primary included — can be split on any side.
 */
export const splitLeaf = (tree: PaneNode, leafId: string, side: Side, fresh: PaneLeaf): PaneNode => {
  const dir: PaneSplit["dir"] = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  const walk = (n: PaneNode): PaneNode => {
    if (n.kind === "leaf") {
      if (n.id !== leafId) return n;
      return { kind: "split", id: newPaneId(), dir, ratio: 0.5, a: before ? fresh : n, b: before ? n : fresh };
    }
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(tree);
};

/** Remove a leaf; its parent split collapses into the sibling. Null when it was the whole tree. */
export const removeLeaf = (tree: PaneNode, leafId: string): PaneNode | null => {
  const prune = (n: PaneNode): PaneNode | null => {
    if (n.kind === "leaf") return n.id === leafId ? null : n;
    const a = prune(n.a);
    const b = prune(n.b);
    if (a && b) return { ...n, a, b };
    return a || b;
  };
  return prune(tree);
};

/** Two leaves trade places; everything else stays. */
export const swapLeaves = (tree: PaneNode, idA: string, idB: string): PaneNode => {
  const a = findLeaf(tree, idA);
  const b = findLeaf(tree, idB);
  if (!a || !b || idA === idB) return tree;
  const walk = (n: PaneNode): PaneNode => {
    if (n.kind === "leaf") return n.id === idA ? b : n.id === idB ? a : n;
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(tree);
};

/**
 * Re-dock: drop `leafId` on `targetId`. An edge zone splits the target there
 * with the moved pane; the centre swaps the two. Dropping a pane on itself,
 * or on nothing, is a no-op.
 */
export const moveLeaf = (tree: PaneNode, leafId: string, targetId: string, where: DropZone): PaneNode => {
  if (leafId === targetId) return tree;
  const moving = findLeaf(tree, leafId);
  if (!moving || !findLeaf(tree, targetId)) return tree;
  if (where === "center") return swapLeaves(tree, leafId, targetId);
  const without = removeLeaf(tree, leafId);
  if (!without) return tree;
  return splitLeaf(without, targetId, where, moving);
};

export type Rect = { x: number; y: number; w: number; h: number };

/** Each leaf's box in unit coordinates (dividers ignored). */
export const leafRects = (tree: PaneNode, box: Rect = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Rect> => {
  const out = new Map<string, Rect>();
  const walk = (n: PaneNode, r: Rect) => {
    if (n.kind === "leaf") {
      out.set(n.id, r);
      return;
    }
    if (n.dir === "row") {
      const wa = r.w * n.ratio;
      walk(n.a, { x: r.x, y: r.y, w: wa, h: r.h });
      walk(n.b, { x: r.x + wa, y: r.y, w: r.w - wa, h: r.h });
    } else {
      const ha = r.h * n.ratio;
      walk(n.a, { x: r.x, y: r.y, w: r.w, h: ha });
      walk(n.b, { x: r.x, y: r.y + ha, w: r.w, h: r.h - ha });
    }
  };
  walk(tree, box);
  return out;
};

const overlap = (a: number, al: number, b: number, bl: number) => Math.min(a + al, b + bl) - Math.max(a, b);

/**
 * The leaf to focus when moving in a direction: the nearest one lying that
 * way that shares an edge span with the current pane — ties go to the pane
 * sharing the most edge. Null at the layout's border.
 */
export const neighborLeaf = (tree: PaneNode, fromId: string, dir: Direction): string | null => {
  const rects = leafRects(tree);
  const from = rects.get(fromId);
  if (!from) return null;
  const eps = 1e-6;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [id, r] of rects) {
    if (id === fromId) continue;
    let gap: number;
    let shared: number;
    if (dir === "right") {
      gap = r.x - (from.x + from.w);
      shared = overlap(from.y, from.h, r.y, r.h);
    } else if (dir === "left") {
      gap = from.x - (r.x + r.w);
      shared = overlap(from.y, from.h, r.y, r.h);
    } else if (dir === "down") {
      gap = r.y - (from.y + from.h);
      shared = overlap(from.x, from.w, r.x, r.w);
    } else {
      gap = from.y - (r.y + r.h);
      shared = overlap(from.x, from.w, r.x, r.w);
    }
    if (gap < -eps || shared <= eps) continue;
    const score = gap * 10 - shared;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
};

/** The next / previous leaf in visual order, wrapping. */
export const cycleLeaf = (tree: PaneNode, fromId: string, step: 1 | -1): string => {
  const ids = leafIds(tree);
  const cur = Math.max(0, ids.indexOf(fromId));
  return ids[(cur + step + ids.length) % ids.length];
};

/**
 * Which zone a point at normalised (rx, ry) inside a pane targets: the
 * nearest edge when within `band` of it, else the centre.
 */
export const dropZoneAt = (rx: number, ry: number, band = 0.28): DropZone => {
  const edges: Array<[Side, number]> = [
    ["left", rx],
    ["right", 1 - rx],
    ["top", ry],
    ["bottom", 1 - ry]
  ];
  edges.sort((p, q) => p[1] - q[1]);
  return edges[0][1] < band ? edges[0][0] : "center";
};
