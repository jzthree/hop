import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// The Slack-style side panel, as on the iOS app (SessionDrawer.swift): every
// session filed by folder, what each one needs at a glance, and a jump to
// another without going back to the wall. Opened from the session header.
// On a wide desktop window it can be pinned: docked, it stays beside the
// terminal like Slack's sidebar, and a pick switches without closing it.
// Folding, arrangement and pinning are remembered per browser; "All
// sessions" opens the wall.

export type RailSession = {
  name: string;
  displayName: string;
  internalName?: string;
  type?: "terminal" | "port";
  createdBy?: "user" | "agent";
  folderId?: string | null;
  parked?: boolean;
  archived?: boolean;
  active?: boolean;
  tagline?: string;
  lastActivityAt?: number;
  attentionReason?: string;
  agentPhase?: "working" | "done" | null;
  turnSeen?: boolean;
  unread?: boolean;
  bellUnseen?: boolean;
  checkbacks?: number;
};

type Props = {
  sessions: RailSession[];
  folders: Array<{ id: string; name: string }>;
  currentRoom: string | null;
  onPick: (s: RailSession) => void;
  onAllSessions: () => void;
  onClose: () => void;
  /** Docked beside the terminal (no backdrop, stays open on a pick). */
  docked?: boolean;
  /** Offered only where a docked rail fits (a wide window, a mouse). */
  canDock?: boolean;
  onDockChange?: (docked: boolean) => void;
  /** Park / unpark from a row's right-click menu. */
  onPark?: (s: RailSession, parked: boolean) => void;
  /** The wall is the main view: "All sessions" is where you are. */
  onWall?: boolean;
  /** Sessions is the place shown — the wall, or a session's terminal (Views
   *  being the other way to look at a session). Defaults to onWall. */
  inSessions?: boolean;
  /** The wall's own search box is rendered here (a portal target), and
   *  what it holds filters this list too. Without it the rail has its own. */
  searchSlot?: (el: HTMLDivElement | null) => void;
  externalFilter?: string;
  /** Fleet-wide places, Slack's "Threads / Activity" rows. */
  nav?: RailNavItem[];
  /** Scope owned by the page (docked: it scopes the wall too). */
  scope?: Scope;
  onScopeChange?: (scope: Scope) => void;
  /** Docked: drag the right edge to resize (double-click resets). */
  onResize?: (width: number | null) => void;
  /** Docked: the header's compose button — a new session. */
  onNew?: () => void;
  /** Bumped by ⌘K: put the cursor in the search, ready to type. */
  focusSignal?: number;
  /** ⏎ on a name no session has: start one called that. */
  onCreate?: (name: string) => void;
  /** Esc with the search already empty: back to whatever had the keys. */
  onSearchDone?: () => void;
};

/** How well a session answers a search: the name's start beats a word's
 *  start beats anywhere in the name beats the description; -1 is no match. */
export const searchRank = (s: { name: string; displayName?: string; tagline?: string }, q: string): number => {
  if (!q) return 0;
  const name = (s.displayName || s.name).toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.split(/[-_ ./]+/).some((w) => w.startsWith(q))) return 1;
  if (name.includes(q)) return 2;
  if ((s.tagline || "").toLowerCase().includes(q)) return 3;
  return -1;
};

/** A place in the docked rail's icon strip (Slack's Home / DMs / Activity
 *  column); `bottom` items sit at its foot (Slack's + / theme / you). */
export type RailNavItem = { key: string; label: string; icon: ReactNode; count?: number; fresh?: boolean; bottom?: boolean; active?: boolean; onClick: () => void };

/** Line icons for the strip (24-grid, stroke = currentColor). */
const ICON_PATHS: Record<string, string> = {
  wall: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  views: "M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5M3 17.5l9 5 9-5",
  scheduled: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  calendar: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12ZM4 10h16M8.5 3v4M15.5 3v4",
  codex: "M4 4h16v16H4zM12 4v16M4 12h8",
  desktop: "M3 4h18v12H3zM8 20h8M12 16v4",
  light: "M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  dark: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  system: "M12 3a9 9 0 1 0 0 18V3ZM12 3a9 9 0 0 1 0 18",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M17 14H7",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
};
export const RailIcon = ({ name }: { name: keyof typeof ICON_PATHS | string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICON_PATHS[name] || ""} />
  </svg>
);

export type Scope = "user" | "agent" | "all";
type Order = "folder" | "recent";
const FOLD_KEY = "hop_rail_folded";
const SCOPE_KEY = "hop_rail_scope";
const ORDER_KEY = "hop_rail_order";

const load = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const save = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
};

const keyOf = (s: RailSession) => s.internalName || s.name;
const wantsYou = (s: RailSession) => !!s.attentionReason || !!s.bellUnseen;
const dotClass = (s: RailSession) =>
  wantsYou(s) ? "wants" : s.agentPhase === "working" ? "working" : s.agentPhase === "done" && !s.turnSeen ? "done" : s.active === false ? "off" : "live";

export const SessionRail = ({ sessions, folders, currentRoom, onPick, onAllSessions, onClose, docked = false, canDock = false, onDockChange, onPark, onWall = false, inSessions, searchSlot, externalFilter, nav = [], scope: scopeProp, onScopeChange, onResize, onNew, focusSignal = 0, onCreate, onSearchDone }: Props) => {
  const [ownFilter, setFilter] = useState("");
  const filter = searchSlot ? (externalFilter ?? "") : ownFilter;
  const [ownScope, setScope] = useState<Scope>(() => (load(SCOPE_KEY) as Scope) || "user");
  const scope = scopeProp ?? ownScope;
  const [order, setOrder] = useState<Order>(() => (load(ORDER_KEY) === "recent" ? "recent" : "folder"));
  const [menu, setMenu] = useState<{ s: RailSession; x: number; y: number } | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(() => new Set((load(FOLD_KEY) || "").split(",").filter(Boolean)));
  const [parkedOpen, setParkedOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Docked, the rail sits beside a terminal you are typing in: it must not
    // take the keyboard on mount, nor Escape (the session's own key).
    if (docked) return;
    // Focus the filter only with a real keyboard — on a phone it would pop
    // the on-screen one over the list.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, docked]);

  useEffect(() => {
    if (!optionsOpen) return;
    const close = () => setOptionsOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey, true); };
  }, [optionsOpen]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey, true); };
  }, [menu]);

  const toggle = (id: string) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    save(FOLD_KEY, [...next].join(","));
    return next;
  });
  const changeScope = (next: Scope) => {
    if (onScopeChange) { onScopeChange(next); return; }
    setScope(next); save(SCOPE_KEY, next);
  };
  // Drag the docked rail's edge: the width follows the pointer.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onResize) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onResize(ev.clientX);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("rail-resizing");
    };
    document.body.classList.add("rail-resizing");
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const changeOrder = (next: Order) => { setOrder(next); save(ORDER_KEY, next); };

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const inScope = sessions
      .filter((s) => s.type !== "port")
      .filter((s) => scope === "all" || (scope === "agent" ? s.createdBy === "agent" : s.createdBy !== "agent"));
    if (!q) {
      return inScope.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name, undefined, { sensitivity: "base" }));
    }
    // Searching is how sessions are switched: best answer first, and among
    // equals the one you were in most recently. The session already on
    // screen goes last — a search is for going somewhere else.
    const here = (s: RailSession) => (keyOf(s) === currentRoom || s.name === currentRoom ? 1 : 0);
    return inScope
      .map((s) => ({ s, r: searchRank(s, q) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => here(a.s) - here(b.s) || a.r - b.r || (b.s.lastActivityAt || 0) - (a.s.lastActivityAt || 0))
      .map((x) => x.s);
  }, [sessions, scope, filter, currentRoom]);
  // The keyboard's choice among the matches (↑ ↓), reset as the query changes.
  const [sel, setSel] = useState(0);
  useEffect(() => { setSel(0); }, [filter, scope]);
  useEffect(() => {
    if (!focusSignal) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  const searching = filter.trim().length > 0;
  const shelved = (s: RailSession) => s.parked || s.archived;
  const groups = useMemo(() => {
    const live = visible.filter((s) => searching || !shelved(s));
    if (searching) return [{ id: "", title: "Matches", rows: live }];
    if (order === "recent") {
      const rows = [...live].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
      return rows.length ? [{ id: "recent:", title: "Recent", rows }] : [];
    }
    const known = new Set(folders.map((f) => f.id));
    const out: Array<{ id: string; title: string; rows: RailSession[] }> = [];
    for (const f of folders) {
      const rows = live.filter((s) => s.folderId === f.id);
      if (rows.length) out.push({ id: f.id, title: f.name, rows });
    }
    const unfiled = live.filter((s) => !s.folderId || !known.has(s.folderId));
    if (unfiled.length) out.push({ id: "", title: folders.length ? "Unfiled" : "Sessions", rows: unfiled });
    return out;
  }, [visible, folders, searching, order]);
  const parked = searching ? [] : visible.filter(shelved);

  const row = (s: RailSession) => {
    const current = keyOf(s) === currentRoom || s.name === currentRoom;
    const chosen = !searchSlot && filter.trim().length > 0 && visible[sel] === s;
    return (
      <button key={keyOf(s)} type="button" className={"rail-row" + (current ? " current" : "") + (chosen ? " kbd" : "")}
              ref={chosen ? (el) => el?.scrollIntoView?.({ block: "nearest" }) : undefined}
              aria-current={current ? "true" : undefined} onClick={() => onPick(s)}
              // Out of the filter at the press (Safari never focuses a clicked button).
              onPointerDown={() => { if (document.activeElement === inputRef.current) inputRef.current?.blur(); }}
              onContextMenu={onPark ? (e) => { e.preventDefault(); setMenu({ s, x: e.clientX, y: e.clientY }); } : undefined}
              title={s.tagline || s.displayName || s.name}>
        <span className={`rail-dot ${dotClass(s)}`} aria-hidden="true" />
        <span className={"rail-name" + (wantsYou(s) || s.unread ? " strong" : "")}>{s.displayName || s.name}</span>
        {(s.parked || s.archived) && <span className="rail-mark" aria-label="parked" title="Parked">☾</span>}
        {!!s.checkbacks && (
          <span className="rail-mark rail-sched" title={`${s.checkbacks} check-back${s.checkbacks === 1 ? "" : "s"} scheduled`}>
            <RailIcon name="scheduled" />{s.checkbacks}
          </span>
        )}
        {/* News, not an error: a spark, never a warning sign. */}
        {wantsYou(s) && <span className="rail-spark" aria-label="has news for you" title={s.attentionReason || "Has news for you"}>✦</span>}
      </button>
    );
  };

  const scopeLabel = (v: Scope) => (v === "user" ? "You" : v === "agent" ? "Agents" : "All");
  const searchBox = searchSlot
    ? <div className="rail-search-slot" ref={searchSlot} />
    : <input ref={inputRef} className="rail-filter" type="search" placeholder={docked ? "Find a session…" : "Jump to…"} value={filter}
             onChange={(e) => setFilter(e.target.value)}
             onKeyDown={(e) => {
               const searchingNow = filter.trim().length > 0;
               if ((e.key === "ArrowDown" || e.key === "ArrowUp") && searchingNow && visible.length) {
                 e.preventDefault();
                 setSel((i) => Math.max(0, Math.min(visible.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
               } else if (e.key === "Enter") {
                 e.preventDefault();
                 const pick = searchingNow ? visible[sel] : visible[0];
                 if (pick) { setFilter(""); onPick(pick); }
                 else if (searchingNow && onCreate) { const name = filter.trim(); setFilter(""); onCreate(name); }
               } else if (e.key === "Escape") {
                 e.preventDefault();
                 e.stopPropagation();
                 if (filter) setFilter("");
                 else { inputRef.current?.blur(); onSearchDone?.(); }
               }
             }}
             aria-label="Jump to a session" />;
  const list = (
    <div className="rail-list">
      {!docked && (
        <button type="button" className={"rail-row all" + (onWall ? " current" : "")} aria-current={onWall ? "page" : undefined}
                onClick={onAllSessions}>
          <span className="rail-grid" aria-hidden="true">▦</span>
          <span className="rail-name">All sessions</span>
        </button>
      )}
      {groups.map((g) => {
        const isFolded = !searching && folded.has(g.id);
        const wanting = g.rows.filter(wantsYou).length;
        return (
          <section key={g.id || "unfiled"}>
            <button type="button" className="rail-folder" aria-expanded={!isFolded} onClick={() => toggle(g.id)}>
              <span className="rail-chev" aria-hidden="true">{isFolded ? "▸" : "▾"}</span>
              <span className="rail-folder-name">{g.title}</span>
              {isFolded && wanting > 0
                ? <span className="rail-count wants">{wanting}</span>
                : <span className="rail-count">{g.rows.length}</span>}
            </button>
            {!isFolded && g.rows.map(row)}
          </section>
        );
      })}
      {parked.length > 0 && (
        <section>
          <button type="button" className="rail-folder" aria-expanded={parkedOpen} onClick={() => setParkedOpen((o) => !o)}>
            <span className="rail-chev" aria-hidden="true">{parkedOpen ? "▾" : "▸"}</span>
            <span className="rail-folder-name">Parked</span>
            <span className="rail-count">{parked.length}</span>
          </button>
          {parkedOpen && parked.map(row)}
        </section>
      )}
      {visible.length === 0 && (
        <p className="rail-empty">
          {searching ? <>No session matches “{filter.trim()}”.{onCreate && !searchSlot && <> <kbd>⏎</kbd> starts one with that name.</>}</> : "No sessions in this scope."}
        </p>
      )}
    </div>
  );
  const stripButton = (n: { key: string; label: string; icon: ReactNode; count?: number; fresh?: boolean; active?: boolean; onClick: () => void }) => (
    <button key={n.key} type="button" className={"rail-strip-btn" + (n.active ? " on" : "")} onClick={n.onClick}
            aria-current={n.active ? "page" : undefined} aria-label={n.label} title={n.label}>
      <span className="rail-strip-icon" aria-hidden="true">{n.icon}</span>
      <span className="rail-strip-label">{n.label}</span>
      {!!n.count && <span className={"rail-strip-count" + (n.fresh ? " fresh" : "")}>{n.count}</span>}
    </button>
  );

  return (
    <>
      {!docked && <div className="rail-backdrop" onClick={onClose} />}
      <aside className={"session-rail" + (docked ? " docked" : "")} role={docked ? "navigation" : "dialog"} aria-label="Sessions">
        {docked ? (<>
          {/* Slack's left column: places, not sessions. */}
          <nav className="rail-strip" aria-label="Places">
            {stripButton({ key: "home", label: "Sessions", icon: <RailIcon name="wall" />, active: inSessions ?? onWall, onClick: onAllSessions })}
            {nav.filter((n) => !n.bottom).map(stripButton)}
            <span className="rail-strip-spacer" />
            {nav.filter((n) => n.bottom).map(stripButton)}
          </nav>
          {/* The sidebar proper: sessions, front and center. */}
          <div className="rail-pane">
            <div className="rail-head">
              <span className="rail-title">hop<span className="rail-title-cursor" aria-hidden="true" /></span>
              {scope !== "user" && (
                <button type="button" className="rail-scope-chip" title="Showing this scope — click to show yours"
                        onClick={() => changeScope("user")}>
                  {scopeLabel(scope)} <span aria-hidden="true">×</span>
                </button>
              )}
              <span className="rail-head-spacer" />
              <div className="rail-options-wrap" onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" className="rail-icon-btn" aria-label="Sidebar options" aria-expanded={optionsOpen}
                        title="Show, arrange, hide" onClick={() => setOptionsOpen((o) => !o)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
                </button>
                {optionsOpen && (
                  <div className="rail-options" role="menu">
                    <div className="rail-options-label">Show</div>
                    {(["user", "agent", "all"] as const).map((v) => (
                      <button key={v} type="button" role="menuitemradio" aria-checked={scope === v}
                              onClick={() => { changeScope(v); setOptionsOpen(false); }}>
                        <span className="rail-options-check">{scope === v ? "✓" : ""}</span>
                        {v === "user" ? "Your sessions" : v === "agent" ? "Agents' sessions" : "All sessions"}
                      </button>
                    ))}
                    <div className="rail-options-label">Arrange</div>
                    {(["folder", "recent"] as const).map((v) => (
                      <button key={v} type="button" role="menuitemradio" aria-checked={order === v}
                              onClick={() => { changeOrder(v); setOptionsOpen(false); }}>
                        <span className="rail-options-check">{order === v ? "✓" : ""}</span>
                        {v === "folder" ? "By folder" : "Most recent first"}
                      </button>
                    ))}
                    <div className="rail-options-sep" />
                    <button type="button" role="menuitem" onClick={() => { setOptionsOpen(false); onDockChange?.(false); }}>
                      <span className="rail-options-check" />Hide sidebar
                    </button>
                  </div>
                )}
              </div>
              {onNew && (
                <button type="button" className="rail-icon-btn" aria-label="New session" title="New session" onClick={onNew}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </button>
              )}
            </div>
            {searchBox}
            {list}
          </div>
          {onResize && (
            <div className="rail-resize" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar"
                 title="Drag to resize · double-click for the default width"
                 onPointerDown={startResize} onDoubleClick={() => onResize(null)} />
          )}
        </>) : (<>
          <div className="rail-head">
            <span className="rail-title">Sessions</span>
            <button type="button" className="rail-order" aria-label={`Arrange: ${order === "folder" ? "by folder" : "most recent first"}`}
                    title={order === "folder" ? "By folder — click for most recent first" : "Most recent first — click for by folder"}
                    onClick={() => changeOrder(order === "folder" ? "recent" : "folder")}>
              {order === "folder" ? "▤" : "◷"}
            </button>
            <div className="rail-scope" role="tablist" aria-label="Scope">
              {(["user", "agent", "all"] as const).map((v) => (
                <button key={v} type="button" role="tab" aria-selected={scope === v}
                        className={scope === v ? "on" : ""} onClick={() => changeScope(v)}>
                  {scopeLabel(v)}
                </button>
              ))}
            </div>
            {canDock && (
              <button type="button" className="rail-pin" aria-pressed={false}
                      aria-label="Keep the sidebar open" title="Keep open beside the terminal"
                      onClick={() => onDockChange?.(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
              </button>
            )}
            <button type="button" className="rail-close" aria-label="Close sessions" onClick={onClose}>×</button>
          </div>
          {searchBox}
          {list}
        </>)}
      </aside>
      {menu && onPark && (
        <div className="rail-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => { const { s } = menu; setMenu(null); onPark(s, !(s.parked || s.archived)); }}>
            {menu.s.parked || menu.s.archived ? "Unpark" : "Park"}
          </button>
        </div>
      )}
    </>
  );
};
