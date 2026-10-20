import { useEffect, useMemo, useRef, useState } from "react";
import { createReadWitness, wordCount } from "../utils/readWitness";
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
  // The chief-of-staff page: decide / watch / done, and an "also" roll-up
  // of headline-only items. Older editions have no slot and render flat.
  slot?: "decide" | "watch" | "done" | "also";
  recommendation?: string;
  replies?: string[];
};
const SLOT_LABEL: Record<string, string> = { decide: "Decide", watch: "Watch", done: "Done" };
const SLOT_ORDER = ["decide", "watch", "done"];

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

// The phone page's unread state, per story: which sessions have been opened
// from which edition ("<stamp>|a,b,c"), like the app's digestReadLedger.
const OPENED_KEY = "hop_digest_opened";
const loadOpened = (): { stamp: string; names: Set<string> } => {
  try {
    const raw = localStorage.getItem(OPENED_KEY) || "";
    const [stamp, rest] = [raw.split("|")[0] || "", raw.split("|").slice(1).join("|")];
    return { stamp, names: new Set(rest.split(",").filter(Boolean)) };
  } catch { return { stamp: "", names: new Set() }; }
};

// The app's story glyphs (exclamationmark.bubble / hand.raised /
// checkmark.circle / info.circle), drawn small and filled.
const StoryGlyph = ({ urgency }: { urgency?: string }) => {
  const k = urgencyClass(urgency);
  return (
    <svg className={"pdigest-glyph " + k} width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      {k === "needs" ? (
        <><path d="M3 1.5h10A2 2 0 0 1 15 3.5v6.5a2 2 0 0 1-2 2H8l-3.5 3v-3H3a2 2 0 0 1-2-2V3.5a2 2 0 0 1 2-2z" fill="currentColor" />
          <path d="M8 4v3.6" stroke="var(--panel)" strokeWidth="1.8" strokeLinecap="round" /><circle cx="8" cy="9.8" r="1" fill="var(--panel)" /></>
      ) : k === "blocked" ? (
        <path d="M5 8V3.2a1 1 0 0 1 2 0V7V2.2a1 1 0 0 1 2 0V7V2.8a1 1 0 0 1 2 0V8V4.6a1 1 0 0 1 2 0v5.2A5.2 5.2 0 0 1 7.8 15h-.4a4.6 4.6 0 0 1-3.7-1.9L1.6 10.2a1 1 0 0 1 1.5-1.3L5 10.5z" fill="currentColor" />
      ) : k === "done" ? (
        <><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M4.8 8.2l2.2 2.2 4.2-4.6" fill="none" stroke="var(--panel)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></>
      ) : (
        <><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="8" cy="4.9" r="0.9" fill="currentColor" /></>
      )}
    </svg>
  );
};

export const DigestCard = ({ sessions, onOpen, phone = false, onReply }: {
  sessions: SwitcherSession[];
  onOpen: (session: SwitcherSession) => void;
  /** The iOS app's front page instead of the desktop's timeline. */
  phone?: boolean;
  /** Types a decision reply into the session (+ Enter); true when delivered. */
  onReply?: (session: SwitcherSession, text: string) => Promise<boolean>;
}) => {
  const [editions, setEditions] = useState<Edition[]>([]);
  // The read witness: dwell on a visible story, with the human present,
  // reports glimpsed/read to the daemon; opening a session from a story
  // reports acted. The daemon's union across devices feeds the "new"
  // badge below and tells the generator what may be told as a delta.
  const witnessRef = useRef<ReturnType<typeof createReadWitness> | null>(null);
  if (!witnessRef.current) {
    witnessRef.current = createReadWitness((reads) => {
      fetch("/api/digest/reads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reads }), keepalive: true })
        .catch(() => { /* offline: the next batch carries it */ });
    });
  }
  useEffect(() => () => { witnessRef.current?.dispose(); witnessRef.current = null; }, []);
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
  // Phone page: story-level read state (opened here, or read/acted on any
  // device per the daemon), reply chips in flight / delivered, Earlier fold.
  const [opened, setOpened] = useState(() => loadOpened());
  const [serverRead, setServerRead] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [earlierOpen, setEarlierOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      // The archive carries every edition (newest first) and its [0] IS the
      // current one, so it alone is enough; digest.json is the fallback for
      // the very first briefing, before an archive exists.
      Promise.all([
        fetch("/assets/digest-archive.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/assets/digest.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/digest/reads", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      ]).then(([archive, latest, serverReads]: [{ editions?: Edition[] } | null, Edition | null, { editionsSeen?: string[]; reads?: Record<string, { level?: string }> } | null]) => {
        if (cancelled) return;
        // Read or acted anywhere clears a story's dot; a glimpse doesn't.
        if (serverReads?.reads && typeof serverReads.reads === "object") {
          setServerRead(new Set(Object.entries(serverReads.reads)
            .filter(([, r]) => r?.level === "read" || r?.level === "acted").map(([k]) => k)));
        }
        // Editions any device has witnessed are not "new" here either.
        const seenElsewhere = Array.isArray(serverReads?.editionsSeen) ? serverReads!.editionsSeen! : [];
        if (seenElsewhere.length) setSeen((prev) => { const next = new Set(prev); for (const x of seenElsewhere) next.add(x); saveSeen(next); return next; });
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

  const openItem = (session: string, edition?: string) => {
    if (edition) witnessRef.current?.acted(edition, session);
    const t = find(session);
    if (t) onOpen(t);
  };

  const setModePersist = (m: "timeline" | "session") => {
    setMode(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ok */ }
  };

  // One edition's page. New editions carry slots: Decide, Watch, Done as
  // sections, then "Also" as a row of session chips — the roll-up that keeps
  // a tap into each session without a paragraph each. Older editions (no
  // slot) render as the flat list they were written as.
  const renderItem = (item: DigestItem, s?: string) => (
    <button
      key={item.session + item.headline}
      ref={witnessRef.current!.ref({ edition: s || "", item: item.session, words: wordCount(item.headline + " " + (item.why || "") + " " + (item.recommendation || "")) })}
      className={"digest-item " + urgencyClass(item.urgency)}
      onClick={() => openItem(item.session, s)}
    >
      <span className="digest-dateline">{sessionLabel(item.session)}</span>
      <span className="digest-headline">{item.headline}</span>
      {item.why ? <span className="digest-why">{item.why}</span> : null}
      {item.recommendation ? (
        <span className="digest-reco"><span className="digest-reco-label">Suggested</span>{item.recommendation}</span>
      ) : null}
      {item.replies?.length ? (
        // The ways the agent offered to go — words, not buttons: the card
        // opens the session, where the answer is given.
        <span className="digest-replies">
          <span className="digest-replies-label">Options</span>
          {item.replies.map((r, i) => <span key={r} className="digest-reply">{i > 0 ? " · " : ""}{r}</span>)}
        </span>
      ) : null}
    </button>
  );
  const renderEdition = (ed: Edition, s?: string) => {
    const items = ed.items || [];
    if (!items.some((it) => it.slot)) return items.map((it) => renderItem(it, s));
    const also = items.filter((it) => it.slot === "also");
    return (
      <>
        {SLOT_ORDER.map((slot) => {
          const rows = items.filter((it) => it.slot === slot);
          if (!rows.length) return null;
          return (
            <div key={slot} className={"digest-slot slot-" + slot}>
              <div className="digest-slot-head">{SLOT_LABEL[slot]}<span className="digest-slot-count">{rows.length}</span></div>
              {rows.map((it) => renderItem(it, s))}
            </div>
          );
        })}
        {also.length ? (
          <div className="digest-also">
            <span className="digest-slot-head">Also</span>
            {also.map((it) => (
              <button
                key={it.session}
                ref={witnessRef.current!.ref({ edition: s || "", item: it.session, words: wordCount(it.headline) })}
                className="digest-also-chip"
                title={it.headline}
                onClick={() => openItem(it.session, s)}
              >
                <span className="digest-also-name">{sessionLabel(it.session)}</span>
                <span className="digest-also-head">{it.headline}</span>
              </button>
            ))}
          </div>
        ) : null}
      </>
    );
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

  if (phone) {
    const isRead = (edition: string, session: string) =>
      serverRead.has(edition + "|" + session) || (opened.stamp === edition && opened.names.has(session));
    const openStory = (session: string, edition: string) => {
      const names = new Set(opened.stamp === edition ? opened.names : []);
      names.add(session);
      const next = { stamp: edition, names };
      setOpened(next);
      try { localStorage.setItem(OPENED_KEY, edition + "|" + [...names].sort().join(",")); } catch { /* ok */ }
      openItem(session, edition);
    };
    const reply = async (item: DigestItem, edition: string, text: string) => {
      const key = edition + "|" + item.session + "|" + text;
      const t = find(item.session);
      if (!t || !onReply || sending || sent.has(key)) return;
      setSending(key);
      const ok = await onReply(t, text);
      setSending(null);
      if (ok) {
        setSent((prev) => new Set(prev).add(key));
        witnessRef.current?.acted(edition, item.session);
      }
    };
    const story = (item: DigestItem, edition: string) => {
      const answered = [...sent].some((k) => k.startsWith(edition + "|" + item.session + "|"));
      return (
        <div key={edition + item.session + item.headline} className="pdigest-story">
          <button
            type="button"
            ref={witnessRef.current!.ref({ edition, item: item.session, words: wordCount(item.headline + " " + (item.why || "")) })}
            className="pdigest-open"
            onClick={() => openStory(item.session, edition)}
          >
            <StoryGlyph urgency={item.urgency} />
            <span className="pdigest-text">
              <span className="pdigest-dateline">
                {!isRead(edition, item.session) && <span className="pdigest-unread" aria-label="Unread" />}
                <span className={"pdigest-name " + urgencyClass(item.urgency)}>{sessionLabel(item.session)}</span>
              </span>
              <span className={"pdigest-headline" + (isRead(edition, item.session) ? " read" : "")}>{item.headline}</span>
              {item.why ? <span className="pdigest-why">{item.why}</span> : null}
              {item.recommendation ? <span className="pdigest-reco">→ {item.recommendation}</span> : null}
            </span>
            <span className="pdigest-chev" aria-hidden="true">›</span>
          </button>
          {/* The replies are ANSWERS: a tap types that reply into the
              session and presses Enter, as on the phone app. */}
          {item.replies?.length && onReply ? (
            <div className="pdigest-replies">
              {item.replies.map((r) => {
                const key = edition + "|" + item.session + "|" + r;
                return (
                  <button key={r} type="button"
                          className={"pdigest-reply" + (sent.has(key) ? " sent" : "")}
                          disabled={!!sending || answered}
                          aria-label={sent.has(key) ? `Sent: ${r}` : `Reply ${r} to ${sessionLabel(item.session)}`}
                          onClick={() => void reply(item, edition, r)}>
                    {sent.has(key) ? "✓ " : sending === key ? "… " : ""}{r}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      );
    };
    const page = (ed: Edition, edition: string) => {
      const items = ed.items || [];
      if (!items.some((it) => it.slot)) return items.map((it) => story(it, edition));
      return (
        <>
          {[...SLOT_ORDER, "also"].map((slot) => {
            const rows = items.filter((it) => it.slot === slot);
            if (!rows.length) return null;
            return (
              <div key={slot} className={"pdigest-slot slot-" + slot}>
                <div className="pdigest-slot-label">{slot.toUpperCase()}</div>
                {slot === "also" ? rows.map((it) => (
                  <button key={it.session} type="button" className="pdigest-also"
                          ref={witnessRef.current!.ref({ edition, item: it.session, words: wordCount(it.headline) })}
                          onClick={() => openStory(it.session, edition)}>
                    <span className="pdigest-also-name">{sessionLabel(it.session)}</span>
                    <span className="pdigest-also-head">{it.headline}</span>
                    <span className="pdigest-chev" aria-hidden="true">›</span>
                  </button>
                )) : rows.map((it) => story(it, edition))}
              </div>
            );
          })}
        </>
      );
    };
    const earlier = editions.slice(1);
    return (
      <div className="pdigest-card">
        <div className="pdigest-head">
          <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" fill="currentColor" /></svg>
          <span className="pdigest-badge">Briefing</span>
          <span className="pdigest-spacer" />
          <button type="button" className="pdigest-dismiss" aria-label="Dismiss briefing"
                  onClick={() => { setDismissed(stamp); try { localStorage.setItem(DISMISS_KEY, stamp); } catch { /* ok */ } }}>✕</button>
        </div>
        <p className="pdigest-summary">{editions[0].summary}</p>
        {page(editions[0], stamp)}
        {earlier.length > 0 && (
          <div className="pdigest-earlier">
            <button type="button" className="pdigest-earlier-toggle" aria-expanded={earlierOpen}
                    onClick={() => setEarlierOpen((v) => !v)}>
              <span aria-hidden="true">{earlierOpen ? "▾" : "▸"}</span> Earlier · {earlier.length}
            </button>
            {earlierOpen && earlier.map((ed) => {
              const s2 = ed.generated_at || "";
              const open = openEditions.has(s2);
              return (
                <div key={s2} className="pdigest-edition">
                  <button type="button" className="pdigest-edition-head" aria-expanded={open} onClick={() => toggleEdition(s2)}>
                    <span className="pdigest-when">{ago(s2)}</span>
                    <span className={"pdigest-edition-summary" + (open ? " open" : "")}>{ed.summary}</span>
                    <span className="pdigest-chev" aria-hidden="true">{open ? "⌄" : "›"}</span>
                  </button>
                  {open && <div className="pdigest-edition-body">{page(ed, s2)}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

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
                {open && renderEdition(ed, s)}
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
                    <button className="digest-open-session" onClick={() => openItem(g.session, newest?.at)}>
                      open {sessionLabel(g.session)} →
                    </button>
                    {g.items.map((item, i) => (
                      <div key={i} ref={witnessRef.current!.ref({ edition: item.at || "", item: g.session, words: wordCount(item.headline + " " + (item.why || "")) })} className={"digest-thread-item " + urgencyClass(item.urgency)}>
                        <span className="digest-when">{ago(item.at)}</span>
                        <span className="digest-headline">{item.headline}</span>
                        {item.why ? <span className="digest-why">{item.why}</span> : null}
                        {item.recommendation ? (
                          <span className="digest-reco"><span className="digest-reco-label">Suggested</span>{item.recommendation}</span>
                        ) : null}
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
