import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import {
  PRIMARY_PANE,
  dropZoneAt,
  findLeaf,
  leafIds,
  type DropZone,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
  type Side
} from "../utils/paneTree";

// iTerm-style split panes over one session page.
//
// The PRIMARY terminal (the full-featured one, with its WebGL canvas, voice
// hold, drop zone, find…) must never re-parent: a React remount would kill
// the live xterm. So it is rendered exactly once, in an absolutely positioned
// layer, and that layer is placed over wherever the primary's empty SLOT
// lands in the tree. The tree itself is free — the primary can sit on the
// right, at the bottom, nested three deep, or zoomed — while its DOM stays
// put. Secondary panes tolerate remounts (they reconnect), so they render in
// place.
//
// Interaction lives here too: dividers drag (double-click resets), a pane's
// title bar drags the pane onto another's edge (split there) or middle
// (swap), and zoom lifts one leaf over the rest.

export type DragHandle = { onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void };
export type LeafApi = { focused: boolean; zoomed: boolean; dragHandle: DragHandle };

type Props = {
  tree: PaneNode;
  focusedId: string;
  zoomedId: string | null;
  /** The palette is over the page: the whole layout is inert and invisible. */
  hidden?: boolean;
  /** The full-featured terminal — rendered once, in the fixed layer. */
  primary: ReactNode;
  mac: boolean;
  labelOf: (leaf: PaneLeaf) => string;
  renderLeaf: (leaf: PaneLeaf, api: LeafApi) => ReactNode;
  onFocus: (id: string) => void;
  onRatio: (splitId: string, ratio: number) => void;
  onSplit: (id: string, side: Side) => void;
  onZoom: (id: string) => void;
  onMove: (id: string, targetId: string, where: DropZone) => void;
};

type DragState = { id: string; label: string; x: number; y: number; target: string | null; zone: DropZone | null };

/** Small monochrome glyphs for pane chrome (currentColor, 12px). */
export const PaneIcon = ({ kind }: { kind: "split-right" | "split-down" | "zoom" | "swap" | "close" }) => {
  const common = { viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (kind) {
    case "split-right":
      return (
        <svg {...common}>
          <rect x="1" y="1.5" width="10" height="9" rx="1.5" />
          <path d="M6 1.5v9" />
        </svg>
      );
    case "split-down":
      return (
        <svg {...common}>
          <rect x="1" y="1.5" width="10" height="9" rx="1.5" />
          <path d="M1 6h10" />
        </svg>
      );
    case "zoom":
      return (
        <svg {...common}>
          <path d="M7 1.5h3.5V5M5 10.5H1.5V7M10.5 1.5 7 5M1.5 10.5 5 7" />
        </svg>
      );
    case "swap":
      return (
        <svg {...common}>
          <path d="M2 4h8L7.5 1.5M10 8H2l2.5 2.5" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
        </svg>
      );
  }
};

/** Split-right · split-down · zoom — the buttons every pane's bar carries. */
export const PaneButtons = ({
  label,
  mac,
  zoomed,
  onSplit,
  onZoom
}: {
  label: string;
  mac: boolean;
  zoomed: boolean;
  onSplit: (side: Side) => void;
  onZoom: () => void;
}) => {
  const k = (m: string, o: string) => (mac ? m : o);
  // Buttons neither start a pane drag nor steal focus from the terminal.
  const swallow = (e: ReactPointerEvent | ReactMouseEvent) => e.stopPropagation();
  const act = (fn: () => void) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    fn();
  };
  return (
    <>
      <button
        type="button"
        className="pane-btn"
        aria-label={`Split ${label} to the right`}
        title={`Split right (${k("⌘D", "Ctrl+Shift+D")})`}
        onPointerDown={swallow}
        onMouseDown={(e) => e.preventDefault()}
        onClick={act(() => onSplit("right"))}
      >
        <PaneIcon kind="split-right" />
      </button>
      <button
        type="button"
        className="pane-btn"
        aria-label={`Split ${label} below`}
        title={`Split below (${k("⌘⇧D", "Ctrl+Shift+|")})`}
        onPointerDown={swallow}
        onMouseDown={(e) => e.preventDefault()}
        onClick={act(() => onSplit("bottom"))}
      >
        <PaneIcon kind="split-down" />
      </button>
      <button
        type="button"
        className={`pane-btn${zoomed ? " active" : ""}`}
        aria-label={zoomed ? `Restore ${label}` : `Zoom ${label}`}
        title={`${zoomed ? "Restore" : "Zoom"} (${k("⌘⇧⏎", "Ctrl+Shift+⏎")})`}
        onPointerDown={swallow}
        onMouseDown={(e) => e.preventDefault()}
        onClick={act(onZoom)}
      >
        <PaneIcon kind="zoom" />
      </button>
    </>
  );
};

const DRAG_THRESHOLD_PX = 6;

export const PaneLayout = ({
  tree,
  focusedId,
  zoomedId,
  hidden,
  primary,
  mac,
  labelOf,
  renderLeaf,
  onFocus,
  onRatio,
  onSplit,
  onZoom,
  onMove
}: Props) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLElement>());
  const placedRef = useRef("");
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<{
    id: string;
    label: string;
    startX: number;
    startY: number;
    active: boolean;
    rects: Array<{ id: string; r: DOMRect }>;
    drop: { target: string | null; zone: DropZone | null };
  } | null>(null);

  const ids = leafIds(tree);
  const multi = ids.length > 1;
  const zoomed = zoomedId && ids.includes(zoomedId) ? zoomedId : null;
  const primaryLeaf = findLeaf(tree, "primary") ?? PRIMARY_PANE;
  const primaryLabel = labelOf(primaryLeaf);

  // ── Place the primary layer over its slot ──────────────────────────────
  const place = () => {
    const root = rootRef.current;
    const layer = layerRef.current;
    if (!root || !layer) return;
    const rr = root.getBoundingClientRect();
    const slot = slotRef.current;
    const sr = zoomed === "primary" || !multi || !slot ? rr : slot.getBoundingClientRect();
    const box = [sr.left - rr.left, sr.top - rr.top, sr.width, sr.height].map((v) => Math.round(v));
    const key = box.join(",");
    if (key === placedRef.current) return; // same place: no style write, no layout
    placedRef.current = key;
    layer.style.left = `${box[0]}px`;
    layer.style.top = `${box[1]}px`;
    layer.style.width = `${box[2]}px`;
    layer.style.height = `${box[3]}px`;
  };
  useLayoutEffect(place);
  useEffect(() => {
    const ro = new ResizeObserver(() => place());
    if (rootRef.current) ro.observe(rootRef.current);
    if (slotRef.current) ro.observe(slotRef.current);
    return () => ro.disconnect();
    // The slot element is recreated when the tree changes shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, zoomed, multi]);

  // ── Divider drag ───────────────────────────────────────────────────────
  const divDragRef = useRef<{ id: string; dir: "row" | "col"; rect: DOMRect } | null>(null);
  const renderDivider = (node: PaneSplit) => (
    <div
      key={`div-${node.id}`}
      className="pane-divider"
      role="separator"
      aria-orientation={node.dir === "row" ? "vertical" : "horizontal"}
      title="Drag to resize · double-click to even out"
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        const parent = e.currentTarget.parentElement;
        if (!parent) return;
        divDragRef.current = { id: node.id, dir: node.dir, rect: parent.getBoundingClientRect() };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e: ReactPointerEvent<HTMLDivElement>) => {
        const d = divDragRef.current;
        if (!d || d.id !== node.id) return;
        const r =
          d.dir === "row"
            ? (e.clientX - d.rect.left) / Math.max(1, d.rect.width)
            : (e.clientY - d.rect.top) / Math.max(1, d.rect.height);
        onRatio(d.id, Math.min(0.85, Math.max(0.15, r)));
      }}
      onPointerUp={() => {
        divDragRef.current = null;
      }}
      onDoubleClick={() => onRatio(node.id, 0.5)}
    />
  );

  // ── Pane drag (re-dock) ────────────────────────────────────────────────
  const dragHandle = (id: string, label: string): DragHandle => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
      if (dragRef.current) return;
      const state = {
        id,
        label,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        rects: [] as Array<{ id: string; r: DOMRect }>,
        drop: { target: null as string | null, zone: null as DropZone | null }
      };
      dragRef.current = state;
      const finish = (apply: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", onKey, true);
        dragRef.current = null;
        document.body.classList.remove("pane-dragging");
        if (apply && state.active && state.drop.target && state.drop.zone) {
          onMove(state.id, state.drop.target, state.drop.zone);
        }
        setDrag(null);
      };
      const move = (ev: PointerEvent) => {
        if (!state.active) {
          if (Math.hypot(ev.clientX - state.startX, ev.clientY - state.startY) < DRAG_THRESHOLD_PX) return;
          state.active = true;
          // Geometry is frozen for the drag: nothing re-lays out under the pointer.
          state.rects = [...cellRefs.current].map(([cid, el]) => ({ id: cid, r: el.getBoundingClientRect() }));
          document.body.classList.add("pane-dragging");
        }
        ev.preventDefault();
        const hit = state.rects.find(
          ({ r }) => ev.clientX >= r.left && ev.clientX < r.right && ev.clientY >= r.top && ev.clientY < r.bottom
        );
        let target: string | null = null;
        let zone: DropZone | null = null;
        if (hit && hit.id !== state.id) {
          target = hit.id;
          zone = dropZoneAt((ev.clientX - hit.r.left) / hit.r.width, (ev.clientY - hit.r.top) / hit.r.height);
        }
        state.drop = { target, zone };
        setDrag({ id: state.id, label: state.label, x: ev.clientX, y: ev.clientY, target, zone });
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          finish(false);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", onKey, true);
    }
  });

  const hint = (id: string) =>
    drag && drag.target === id && drag.zone ? <div className={`pane-drop-hint zone-${drag.zone}`} aria-hidden="true" /> : null;
  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) cellRefs.current.set(id, el);
    else cellRefs.current.delete(id);
  };

  const renderNode = (node: PaneNode): ReactNode => {
    if (node.kind === "leaf") {
      if (node.session === null) {
        return (
          <div
            key="primary-slot"
            className="pane-leaf primary-slot"
            ref={(el) => {
              slotRef.current = el;
              register("primary")(el);
            }}
          />
        );
      }
      const api: LeafApi = {
        focused: focusedId === node.id,
        zoomed: zoomed === node.id,
        dragHandle: dragHandle(node.id, labelOf(node))
      };
      return (
        <div
          key={node.id}
          className={`pane-leaf${zoomed === node.id ? " zoomed" : ""}${drag?.id === node.id ? " dragging" : ""}`}
          ref={register(node.id)}
        >
          {renderLeaf(node, api)}
          {hint(node.id)}
        </div>
      );
    }
    return (
      <div key={node.id} className={`pane-split ${node.dir === "row" ? "dir-row" : "dir-col"}`}>
        <div className="pane-cell" style={{ flexGrow: node.ratio, flexBasis: 0 }}>
          {renderNode(node.a)}
        </div>
        {renderDivider(node)}
        <div className="pane-cell" style={{ flexGrow: 1 - node.ratio, flexBasis: 0 }}>
          {renderNode(node.b)}
        </div>
      </div>
    );
  };

  const primaryHandle = dragHandle("primary", primaryLabel);
  return (
    <div
      ref={rootRef}
      className={`pane-root${multi ? " multi" : ""}`}
      inert={hidden}
      style={hidden ? { visibility: "hidden" } : undefined}
    >
      {renderNode(tree)}
      <div
        ref={layerRef}
        className={`primary-pane-layer${multi && focusedId === "primary" ? " focused" : ""}${zoomed === "primary" ? " zoomed" : ""}${drag?.id === "primary" ? " dragging" : ""}`}
        onMouseDownCapture={() => onFocus("primary")}
      >
        {primary}
        {multi && (
          <div className="pane-toolbar" onPointerDown={primaryHandle.onPointerDown} title="Drag to move this pane">
            <span className="pane-toolbar-grip">{primaryLabel}</span>
            <PaneButtons
              label={primaryLabel}
              mac={mac}
              zoomed={zoomed === "primary"}
              onSplit={(side) => onSplit("primary", side)}
              onZoom={() => onZoom("primary")}
            />
          </div>
        )}
        {hint("primary")}
      </div>
      {drag && (
        <div className="pane-drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          {drag.label}
          <span className="pane-drag-ghost-hint">
            {drag.zone === "center" ? "swap" : drag.zone ? `dock ${drag.zone}` : "drop on a pane"}
          </span>
        </div>
      )}
    </div>
  );
};
