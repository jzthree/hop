import { useEffect, useMemo, useState } from "react";
import type { SwitcherSession } from "../utils/switcherModel";

// The briefing, on the desktop wall — the same editions the iOS app renders,
// written by the host-side agent (hop-ios tools/digest.mjs) into the
// directory the daemon serves under /assets/. digest.json is the newest
// edition; digest-archive.json holds every edition (newest first), which is
// what lets this card scroll back through briefings the user HAS or HAS NOT
// seen. Two organizations, toggleable: a timeline of editions, or grouped by
// session (each session collapsed to its newest briefing, expandable to its
// whole thread). Self-contained: two fetches, localStorage for seen/dismissed
// state, no new endpoints.

type DigestItem = {
  session: string;
  headline: string;
  why?: string;
  urgency?: string;
};

type Edition = {
  generated_at?: string;
  summary?: string;
  items?: DigestItem[];
};

const SEEN_KEY = "hop_digest_seen_v2";        // JSON array of edition stamps seen
const DISMISS_KEY = "hop_digest_dismissed";   // "<stamp>" of the newest edition
const MODE_KEY = "hop_digest_mode";           // "timeline" | "session"
const SEEN_CAP = 200;                          // bound the seen list

const loadSeen = (): Set<string> => {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
};
const saveSeen = (set: Set<string>) => {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-SEEN_CAP))); }
  catch { /* private mode — seen state just won't persist */ }
};

const urgencyClass = (u?: string) =>
  u === "needs-you" ? "needs" : u === "blocked" ? "blocked" : u === "finished" ? "done" : "fyi";

// Compact "time since" for a dateline. Local so the card stays self-contained.
const ago = (iso?: string): string => {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export const DigestCard = ({ sessions, onOpen }: {
  sessions: SwitcherSession[];
  onOpen: (session: SwitcherSession) => void;
}) => {
  const [editions, setEditions] = useState<Edition[]>([]);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) || ""; } catch { return ""; }
  });
  const [seen, setSeen] = useState<Set<string>>(() => loadSeen());
  const [mode, setMode] = useState<"timeline" | "session">(() => {
    try { return localStorage.getItem(MODE_KEY) === "session" ? "session" : "timeline"; }
    catch { return "timeline"; }
  });
  // Which editions (timeline) or sessions (by-session) are expanded.
  const [openEditions, setOpenEditions] = useState<Set<string>>(new Set());
  const [openSessions, setOpenSessions] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      // The archive carries every edition (newest first) and its [0] IS the
      // current one, so it alone is enough; digest.json is the fallback for
      // the very first briefing, before an archive exists.
      Promise.all([
        fetch("/assets/digest-archive.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/assets/digest.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      ]).then(([archive, latest]: [{ editions?: Edition[] } | null, Edition | null]) => {
        if (cancelled) return;
        let list: Edition[] = Array.isArray(archive?.editions) ? archive!.editions! : [];
        if (latest?.summary && (!list.length || list[0]?.generated_at !== latest.generated_at)) {
          list = [latest, ...list];
        }
        list = list.filter((e) => e && e.summary);
        setEditions(list);
        // The newest edition auto-expands (the front page); open it and, on
        // first sight, everything already in the seen set stays collapsed.
        if (list[0]?.generated_at) setOpenEditions((prev) => new Set(prev).add(list[0].generated_at!));
      });
    };
    load();
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // Mark a set of edition stamps seen (idempotent, persisted).
  const markSeen = (stamps: Array<string | undefined>) => {
    setSeen((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const s of stamps) if (s && !next.has(s)) { next.add(s); changed = true; }
      if (changed) saveSeen(next);
      return changed ? next : prev;
    });
  };

  // Newest edition auto-counts as seen once it has been on screen a moment —
  // it is the front page the user is looking at.
  const newestStamp = editions[0]?.generated_at;
  useEffect(() => {
    if (!newestStamp) return;
    const t = window.setTimeout(() => markSeen([newestStamp]), 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestStamp]);

  // The daemon folds case when a name addresses a session; match it.
  const find = (internalName: string) =>
    sessions.find((s) => (s.internalName || s.name) === internalName)
      || sessions.find((s) => (s.internalName || s.name).toLowerCase() === internalName.toLowerCase());
  const sessionLabel = (internalName: string) => {
    const t = find(internalName);
    return t ? (t.displayName || t.name) : internalName;
  };

  // By-session grouping: every item across every edition, bucketed by session,
  // newest first within each. The group is "unseen" if its NEWEST item's
  // edition has not been seen — which is what "collapse to the newest
  // briefing" tracks.
  const sessionGroups = useMemo(() => {
    const groups = new Map<string, Array<DigestItem & { at?: string }>>();
    for (const ed of editions) {
      for (const item of ed.items || []) {
        const arr = groups.get(item.session) || [];
        arr.push({ ...item, at: ed.generated_at });
        groups.set(item.session, arr);
      }
    }
    return [...groups.entries()]
      .map(([session, items]) => ({ session, items }))
      .sort((a, b) => Date.parse(b.items[0]?.at || "") - Date.parse(a.items[0]?.at || ""));
  }, [editions]);

  if (!editions.length) return null;
  const stamp = editions[0].generated_at || "";
  const unseenCount = editions.filter((e) => e.generated_at && !seen.has(e.generated_at)).length;
  // Dismissing is not throwing away — like hop-ios's swipe-to-archive, the
  // briefing stays one tap away. When dismissed, collapse to a slim recall
  // bar instead of vanishing, so a hidden briefing is always recoverable
  // (not just when a newer edition lands).
  if (dismissed === stamp) {
    return (
      <button
        className="digest-recall"
        onClick={() => { setDismissed(""); try { localStorage.removeItem(DISMISS_KEY); } catch { /* ok */ } }}
      >
        <span className="digest-badge">✦ Briefing</span>
        {unseenCount > 0 && <span className="digest-unseen">{unseenCount} new</span>}
        <span className="digest-recall-hint">show</span>
      </button>
    );
  }

  const openItem = (session: string) => {
    const t = find(session);
    if (t) onOpen(t);
  };

  const setModePersist = (m: "timeline" | "session") => {
    setMode(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ok */ }
  };

  const toggleEdition = (s?: string) => {
    if (!s) return;
    setOpenEditions((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else { next.add(s); markSeen([s]); }
      return next;
    });
  };
  const toggleSession = (session: string, stamps: Array<string | undefined>) => {
    setOpenSessions((prev) => {
      const next = new Set(prev);
      if (next.has(session)) next.delete(session); else { next.add(session); markSeen(stamps); }
      return next;
    });
  };

  return (
    <div className="digest-card">
      <div className="digest-head">
        <span className="digest-badge">✦ Briefing</span>
        {unseenCount > 0 && <span className="digest-unseen" title={`${unseenCount} unseen`}>{unseenCount} new</span>}
        <div className="digest-modes" role="tablist" aria-label="Organize briefings">
          <button
            className={"digest-mode" + (mode === "timeline" ? " on" : "")}
            role="tab" aria-selected={mode === "timeline"}
            onClick={() => setModePersist("timeline")}
          >Timeline</button>
          <button
            className={"digest-mode" + (mode === "session" ? " on" : "")}
            role="tab" aria-selected={mode === "session"}
            onClick={() => setModePersist("session")}
          >By session</button>
        </div>
        <button className="digest-dismiss" title="Dismiss briefing"
          onClick={() => { setDismissed(stamp); try { localStorage.setItem(DISMISS_KEY, stamp); } catch { /* ok */ } }}>
          ×
        </button>
      </div>

      {mode === "timeline" ? (
        <div className="digest-scroll">
          {editions.map((ed) => {
            const s = ed.generated_at;
            const open = !!s && openEditions.has(s);
            const isUnseen = !!s && !seen.has(s);
            return (
              <section key={s} className={"digest-edition" + (isUnseen ? " unseen" : "")}>
                <button className="digest-edition-head" onClick={() => toggleEdition(s)} aria-expanded={open}>
                  {isUnseen && <span className="digest-dot" />}
                  <span className="digest-when">{ago(s)}</span>
                  <span className="digest-edition-summary">{ed.summary}</span>
                  <span className="digest-caret">{open ? "▾" : "▸"}</span>
                </button>
                {open && (ed.items || []).map((item) => (
                  <button
                    key={item.session + item.headline}
                    className={"digest-item " + urgencyClass(item.urgency)}
                    onClick={() => openItem(item.session)}
                  >
                    <span className="digest-dateline">{sessionLabel(item.session)}</span>
                    <span className="digest-headline">{item.headline}</span>
                    {item.why ? <span className="digest-why">{item.why}</span> : null}
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="digest-scroll">
          {sessionGroups.map((g) => {
            const open = openSessions.has(g.session);
            const newest = g.items[0];
            const groupUnseen = !!newest?.at && !seen.has(newest.at);
            const stamps = g.items.map((i) => i.at);
            return (
              <section key={g.session} className={"digest-session" + (groupUnseen ? " unseen" : "")}>
                <button className="digest-session-head" onClick={() => toggleSession(g.session, stamps)} aria-expanded={open}>
                  {groupUnseen && <span className="digest-dot" />}
                  <span className="digest-dateline">{sessionLabel(g.session)}</span>
                  {/* Collapsed: the newest briefing for this session. */}
                  <span className="digest-headline">{newest?.headline}</span>
                  {g.items.length > 1 && <span className="digest-count">{g.items.length}</span>}
                  <span className="digest-caret">{open ? "▾" : "▸"}</span>
                </button>
                {/* Expanded: the whole thread for this session, newest first,
                    each under its own dateline; the first is also a shortcut
                    into the live session. */}
                {open && (
                  <div className="digest-thread">
                    <button className="digest-open-session" onClick={() => openItem(g.session)}>
                      open {sessionLabel(g.session)} →
                    </button>
                    {g.items.map((item, i) => (
                      <div key={i} className={"digest-thread-item " + urgencyClass(item.urgency)}>
                        <span className="digest-when">{ago(item.at)}</span>
                        <span className="digest-headline">{item.headline}</span>
                        {item.why ? <span className="digest-why">{item.why}</span> : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};
