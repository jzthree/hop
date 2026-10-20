import { useEffect, useMemo, useRef, useState } from "react";

// The Slack-style side panel, as on the iOS app (SessionDrawer.swift): every
// session filed by folder, what each one needs at a glance, and a jump to
// another without going back to the wall. Opened from the terminal's top
// bar on a phone and from the session header (or ⌘/Ctrl+Shift+K) on a
// desktop. Folding is remembered per browser; "All sessions" opens the wall.

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
};

type Props = {
  sessions: RailSession[];
  folders: Array<{ id: string; name: string }>;
  currentRoom: string | null;
  onPick: (s: RailSession) => void;
  onAllSessions: () => void;
  onClose: () => void;
};

type Scope = "user" | "agent" | "all";
const FOLD_KEY = "hop_rail_folded";
const SCOPE_KEY = "hop_rail_scope";

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

export const SessionRail = ({ sessions, folders, currentRoom, onPick, onAllSessions, onClose }: Props) => {
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<Scope>(() => (load(SCOPE_KEY) as Scope) || "user");
  const [folded, setFolded] = useState<Set<string>>(() => new Set((load(FOLD_KEY) || "").split(",").filter(Boolean)));
  const [parkedOpen, setParkedOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus the filter only with a real keyboard — on a phone it would pop
    // the on-screen one over the list.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const toggle = (id: string) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    save(FOLD_KEY, [...next].join(","));
    return next;
  });
  const changeScope = (next: Scope) => { setScope(next); save(SCOPE_KEY, next); };

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
    const known = new Set(folders.map((f) => f.id));
    const out: Array<{ id: string; title: string; rows: RailSession[] }> = [];
    for (const f of folders) {
      const rows = live.filter((s) => s.folderId === f.id);
      if (rows.length) out.push({ id: f.id, title: f.name, rows });
    }
    const unfiled = live.filter((s) => !s.folderId || !known.has(s.folderId));
    if (unfiled.length) out.push({ id: "", title: folders.length ? "Unfiled" : "Sessions", rows: unfiled });
    return out;
  }, [visible, folders, searching]);
  const parked = searching ? [] : visible.filter(shelved);

  const row = (s: RailSession) => {
    const current = keyOf(s) === currentRoom || s.name === currentRoom;
    return (
      <button key={keyOf(s)} type="button" className={"rail-row" + (current ? " current" : "")}
              aria-current={current ? "true" : undefined} onClick={() => onPick(s)}
              title={s.tagline || s.displayName || s.name}>
        <span className={`rail-dot ${dotClass(s)}`} aria-hidden="true" />
        <span className={"rail-name" + (wantsYou(s) || s.unread ? " strong" : "")}>{s.displayName || s.name}</span>
        {wantsYou(s) && <span className="rail-badge" aria-label="wants you">!</span>}
      </button>
    );
  };

  return (
    <>
      <div className="rail-backdrop" onClick={onClose} />
      <aside className="session-rail" role="dialog" aria-label="Sessions">
        <div className="rail-head">
          <span className="rail-title">Sessions</span>
          <div className="rail-scope" role="tablist" aria-label="Scope">
            {(["user", "agent", "all"] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={scope === v}
                      className={scope === v ? "on" : ""} onClick={() => changeScope(v)}>
                {v === "user" ? "You" : v === "agent" ? "Agents" : "All"}
              </button>
            ))}
          </div>
          <button type="button" className="rail-close" aria-label="Close sessions" onClick={onClose}>×</button>
        </div>
        <input ref={inputRef} className="rail-filter" type="search" placeholder="Jump to…" value={filter}
               onChange={(e) => setFilter(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && visible[0]) onPick(visible[0]); }}
               aria-label="Jump to a session" />
        <div className="rail-list">
          <button type="button" className="rail-row all" onClick={onAllSessions}>
            <span className="rail-grid" aria-hidden="true">▦</span>
            <span className="rail-name">All sessions</span>
          </button>
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
      </aside>
    </>
  );
};
