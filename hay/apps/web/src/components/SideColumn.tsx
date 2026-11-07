// The column beside a session. Views, Briefing, Pulse and Calendar each
// open as a page (or a session's tab) or in this column, one at a time;
// while the column is up, whichever of them opens next opens in it (App
// decides that). Here: the parts every pane shares there — the button that
// moves a pane between its page and the column, the column's resize edge,
// the scope (the selected session's share, or everything), and the rule
// that a column answers only keys that start inside it.
import type { PointerEvent as ReactPointerEvent } from "react";

/** Page ⇄ column. In the column the icon is a plain page; elsewhere, a page with a column. */
export const SideToggle = ({ side, onToggle }: { side: boolean; onToggle: () => void }) => (
  <button type="button" className="views-act vg-layout" onClick={onToggle}
          aria-label={side ? "Full page" : "Side by side with the session"}
          title={side ? "Full page" : "Side by side with the session — the terminal makes room"}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {side ? <path d="M4 4h16v16H4z" /> : <><path d="M4 4h16v16H4z" /><path d="M14 4v16" /></>}
    </svg>
  </button>
);

/** The column's left edge: drag to resize, double-click for the default width. */
export const SideHandle = ({ label, onResize }: { label: string; onResize: (w: number | null) => void }) => {
  const onDown = (down: ReactPointerEvent<HTMLDivElement>) => {
    down.preventDefault();
    const el = down.currentTarget;
    el.setPointerCapture(down.pointerId);
    const move = (ev: PointerEvent) => onResize(window.innerWidth - ev.clientX);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.classList.remove("rail-resizing");
    };
    document.body.classList.add("rail-resizing");
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <div className="views-side-handle" role="separator" aria-orientation="vertical" aria-label={label}
         title="Drag to resize · double-click for the default width"
         onPointerDown={onDown} onDoubleClick={() => onResize(null)} />
  );
};

/** In the column: the selected session's share, or all of it. */
export const SideScope = ({ label, all, onScope }: { label: string; all: boolean; onScope: (all: boolean) => void }) => (
  <span className="views-scope-toggle" role="tablist" aria-label="Scope">
    <button type="button" role="tab" aria-selected={!all} className={all ? "" : "on"} title={label}
            onClick={() => onScope(false)}>{label}</button>
    <button type="button" role="tab" aria-selected={all} className={all ? "on" : ""}
            onClick={() => onScope(true)}>all</button>
  </span>
);

/**
 * Side by side, the terminal beside the column is live and Esc is a real
 * key there (vim!): a column answers only keys that start inside it.
 */
export const keyStartsInside = (panel: HTMLElement | null, event: KeyboardEvent): boolean => {
  if (!panel) return false;
  // A keydown dispatched on `window` has a non-Node target; jsdom throws on
  // contains() for it.
  const target = event.target instanceof Node ? event.target : null;
  return !!((target && panel.contains(target)) || (document.activeElement && panel.contains(document.activeElement)));
};
