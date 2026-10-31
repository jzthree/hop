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
};

export type RailNavItem = { key: string; label: string; icon: ReactNode; count?: number; fresh?: boolean; onClick: () => void };

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

export const SessionRail = ({ sessions, folders, currentRoom, onPick, onAllSessions, onClose, docked = false, canDock = false, onDockChange, onPark, onWall = false, searchSlot, externalFilter, nav = [], scope: scopeProp, onScopeChange, onResize }: Props) => {
  const [ownFilter, setFilter] = useState("");
  const filter = searchSlot ? (externalFilter ?? "") : ownFilter;
  const [ownScope, setScope] = useState<Scope>(() => (load(SCOPE_KEY) as Scope) || "user");
  const scope = scopeProp ?? ownScope;
  const [order, setOrder] = useState<Order>(() => (load(ORDER_KEY) === "recent" ? "recent" : "folder"));
  const [menu, setMenu] = useState<{ s: RailSession; x: number; y: number } | null>(null);
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
    return sessions
      .filter((s) => s.type !== "port")
      .filter((s) => scope === "all" || (scope === "agent" ? s.createdBy === "agent" : s.createdBy !== "agent"))
      .filter((s) => !q || (s.displayName || s.name).toLowerCase().includes(q) || (s.tagline || "").toLowerCase().includes(q))
      .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name, undefined, { sensitivity: "base" }));
  }, [sessions, scope, filter]);

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
    return (
      <button key={keyOf(s)} type="button" className={"rail-row" + (current ? " current" : "")}
              aria-current={current ? "true" : undefined} onClick={() => onPick(s)}
              // Out of the filter at the press (Safari never focuses a clicked button).
              onPointerDown={() => { if (document.activeElement === inputRef.current) inputRef.current?.blur(); }}
              onContextMenu={onPark ? (e) => { e.preventDefault(); setMenu({ s, x: e.clientX, y: e.clientY }); } : undefined}
              title={s.tagline || s.displayName || s.name}>
        <span className={`rail-dot ${dotClass(s)}`} aria-hidden="true" />
        <span className={"rail-name" + (wantsYou(s) || s.unread ? " strong" : "")}>{s.displayName || s.name}</span>
        {(s.parked || s.archived) && <span className="rail-mark" aria-label="parked" title="Parked">☾</span>}
        {!!s.checkbacks && <span className="rail-mark" title={`${s.checkbacks} check-back${s.checkbacks === 1 ? "" : "s"} scheduled`}>⏰{s.checkbacks}</span>}
        {wantsYou(s) && <span className="rail-badge" aria-label="wants you">!</span>}
      </button>
    );
  };

  return (
    <>
      {!docked && <div className="rail-backdrop" onClick={onClose} />}
      <aside className={"session-rail" + (docked ? " docked" : "")} role={docked ? "navigation" : "dialog"} aria-label="Sessions">
        <div className="rail-head">
          <span className="rail-title">{docked ? "hop" : "Sessions"}</span>
          <button type="button" className="rail-order" aria-label={`Arrange: ${order === "folder" ? "by folder" : "most recent first"}`}
                  title={order === "folder" ? "By folder — click for most recent first" : "Most recent first — click for by folder"}
                  onClick={() => changeOrder(order === "folder" ? "recent" : "folder")}>
            {order === "folder" ? "▤" : "◷"}
          </button>
          <div className="rail-scope" role="tablist" aria-label="Scope">
            {(["user", "agent", "all"] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={scope === v}
                      className={scope === v ? "on" : ""} onClick={() => changeScope(v)}>
                {v === "user" ? "You" : v === "agent" ? "Agents" : "All"}
              </button>
            ))}
          </div>
          {(canDock || docked) && (
            <button type="button" className={"rail-pin" + (docked ? " on" : "")} aria-pressed={docked}
                    aria-label={docked ? "Unpin the sidebar" : "Keep the sidebar open"}
                    title={docked ? "Unpin — the sidebar closes after a pick" : "Keep open beside the terminal"}
                    onClick={() => onDockChange?.(!docked)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />{docked && <path d="M5 8h2M5 12h2" />}</svg>
            </button>
          )}
          {!docked && <button type="button" className="rail-close" aria-label="Close sessions" onClick={onClose}>×</button>}
        </div>
        {searchSlot
          ? <div className="rail-search-slot" ref={searchSlot} />
          : <input ref={inputRef} className="rail-filter" type="search" placeholder="Jump to…" value={filter}
                   onChange={(e) => setFilter(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter" && visible[0]) onPick(visible[0]); }}
                   aria-label="Jump to a session" />}
        <div className="rail-list">
          <button type="button" className={"rail-row all" + (onWall ? " current" : "")} aria-current={onWall ? "page" : undefined}
                  onClick={onAllSessions}>
            <span className="rail-grid" aria-hidden="true">▦</span>
            <span className="rail-name">All sessions</span>
          </button>
          {nav.map((n) => (
            <button key={n.key} type="button" className="rail-row nav" onClick={n.onClick}>
              <span className="rail-grid" aria-hidden="true">{n.icon}</span>
              <span className="rail-name">{n.label}</span>
              {!!n.count && <span className={"rail-count" + (n.fresh ? " wants" : "")}>{n.count}</span>}
            </button>
          ))}
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
            <p className="rail-empty">{searching ? `No session matches “${filter.trim()}”.` : "No sessions in this scope."}</p>
          )}
        </div>
        {docked && onResize && (
          <div className="rail-resize" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar"
               title="Drag to resize · double-click for the default width"
               onPointerDown={startResize} onDoubleClick={() => onResize(null)} />
        )}
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
