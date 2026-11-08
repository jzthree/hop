import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { currentNames, renamer, threadFor, type BriefingItem, type Edition } from "../utils/briefingFeed";
import { createReadWitness, wordCount } from "../utils/readWitness";
import { Prose } from "../utils/prose";
import { useSavedScroll } from "../utils/savedScroll";
type SessionInfo = { name: string; displayName?: string; internalName?: string };
import { menuIsOpen } from "./ContextMenu";
import { SideHandle, SideScope, SideToggle, keyStartsInside } from "./SideColumn";

// The briefing as a place beside the sidebar: one edition at a time, read
// like the front page of a lab notebook — the summary as its lede, then
// what wants a decision, what to watch, what finished, and a roll-up of the
// rest. Earlier editions are a step back (‹ ›, ← →). With a session — its
// Briefing tab — the page is that session's thread across editions.
//
// A story opens its session; a reply chip types that answer into it (and
// presses Enter) without leaving the page. Reading is witnessed as on the
// wall and the phone — dwell on a visible story reports it read — so a story
// read here is not "new" on any device.

type Props = {
  editions: Edition[];
  read: Set<string>;
  sessions: SessionInfo[];
  /** A session's tab: the page shows its thread. */
  session?: string | null;
  /** A session's Briefing tab: the tab names the page and the session. */
  inSession?: boolean;
  /** In the column beside the session (see SideColumn). */
  side?: boolean;
  /** Between the page (or tab) and the column. */
  onToggleSide?: () => void;
  onResizeSide?: (w: number | null) => void;
  /** In the column: the selected session, offered as the scope, and the way to switch. */
  scopeLabel?: string | null;
  onScope?: (all: boolean) => void;
  onOpenSession: (key: string) => void;
  /** True once typed in; "queued" when the agent is busy and hop will type it when the turn ends. */
  onReply?: (key: string, text: string) => Promise<boolean | "queued">;
  markSeen: (stamp?: string) => void;
  markRead: (edition: string, session: string) => void;
  onClose: () => void;
};

// An ask passed over without an answer: it folds away (here, and on reload
// in this browser) and counts as handled — read — everywhere.
const SKIP_KEY = "hop_brief_skipped";
const SKIP_CAP = 300;
const loadSkipped = (): Set<string> => {
  try { const a = JSON.parse(localStorage.getItem(SKIP_KEY) || "[]"); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); }
};
const saveSkipped = (set: Set<string>) => {
  try { localStorage.setItem(SKIP_KEY, JSON.stringify([...set].slice(-SKIP_CAP))); } catch { /* per-browser only */ }
};

const EARLIER_SHOWN = 3;

const SLOTS: Array<[NonNullable<BriefingItem["slot"]>, string, string]> = [
  ["decide", "Decide", "Waiting on you"],
  ["watch", "Watch", "Moving, worth a look"],
  ["done", "Done", "Finished"]
];

const editionWhen = (iso?: string): string => {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return "";
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
};
const ago = (iso?: string): string => {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

export const BriefingPage = ({ editions, read, sessions, session, inSession = false, side = false, onToggleSide, onResizeSide, scopeLabel, onScope, onOpenSession, onReply, markSeen, markRead, onClose }: Props) => {
  // The edition being read survives a refresh (this browser tab).
  const [index, setIndex] = useState(() => { try { return Number(sessionStorage.getItem("hop_brief_index") || 0) || 0; } catch { return 0; } });
  useEffect(() => { try { sessionStorage.setItem("hop_brief_index", String(index)); } catch { /* private window */ } }, [index]);
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  // Answers hop is holding until the agent's turn ends (shown ⧗, not ✓).
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [allEarlier, setAllEarlier] = useState(false);
  const [skipped, setSkipped] = useState<Set<string>>(loadSkipped);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const witnessRef = useRef<ReturnType<typeof createReadWitness> | null>(null);
  if (!witnessRef.current) {
    witnessRef.current = createReadWitness((reads) => {
      fetch("/api/digest/reads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reads }), keepalive: true })
        .catch(() => { /* the next batch carries it */ });
    });
  }
  useEffect(() => () => { witnessRef.current?.dispose(); witnessRef.current = null; }, []);
  useEffect(() => { panelRef.current?.focus(); }, []);
  useSavedScroll(panelRef, `hop_brief_scroll:${side ? "side:" : inSession ? "tab:" : ""}${session || ""}`, editions.length > 0);

  const ed = editions[Math.min(index, Math.max(0, editions.length - 1))];
  const stamp = ed?.generated_at || "";
  // An edition on screen a moment counts as seen.
  useEffect(() => {
    if (!stamp || session) return;
    const t = window.setTimeout(() => markSeen(stamp), 1200);
    return () => window.clearTimeout(t);
  }, [stamp, session, markSeen]);

  const find = (key: string) => sessions.find((s) => (s.internalName || s.name) === key)
    || sessions.find((s) => (s.internalName || s.name).toLowerCase() === key.toLowerCase()
      || (s.displayName || "").toLowerCase() === key.toLowerCase());
  const label = (key: string) => { const s = find(key); return s ? (s.displayName || s.name) : key; };
  // The prose names sessions as they were called when it was written (or by
  // id); it reads in the names they have now.
  const say = useMemo(() => renamer(currentNames(sessions)), [sessions]);
  const keyOf = (key: string) => { const s = find(key); return s ? (s.internalName || s.name) : key; };
  const isRead = (edition: string, key: string) => read.has(edition + "|" + key);

  const open = (key: string, edition: string) => {
    witnessRef.current?.acted(edition, key);
    markRead(edition, key);
    onOpenSession(keyOf(key));
  };
  const reply = async (item: BriefingItem, edition: string, text: string) => {
    const k = edition + "|" + item.session + "|" + text;
    if (!onReply || sending || sent.has(k)) return;
    setSending(k);
    const ok = await onReply(keyOf(item.session), text);
    setSending(null);
    if (ok) {
      setSent((prev) => new Set(prev).add(k));
      if (ok === "queued") setQueued((prev) => new Set(prev).add(k));
      witnessRef.current?.acted(edition, item.session);
      markRead(edition, item.session);
    }
  };

  const skip = (item: BriefingItem, edition: string) => {
    const k = edition + "|" + item.session;
    witnessRef.current?.acted(edition, item.session);
    markRead(edition, item.session);
    setSkipped((prev) => { const next = new Set(prev).add(k); saveSkipped(next); return next; });
  };
  const unskip = (item: BriefingItem, edition: string) => {
    setSkipped((prev) => { const next = new Set(prev); next.delete(edition + "|" + item.session); saveSkipped(next); return next; });
  };

  // The sidebar's session: its thread, newest first, across every edition.
  const sessionKey = session ? keyOf(session) : null;
  const thread = useMemo(() => {
    if (!sessionKey) return [];
    return threadFor(editions, (id) => keyOf(id) === sessionKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editions, sessionKey, sessions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menuIsOpen()) return;
      if (side && !keyStartsInside(panelRef.current, e)) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      const el = document.activeElement as HTMLElement | null;
      if (!panelRef.current?.contains(el) || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || "") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); setIndex((i) => Math.min(editions.length - 1, i + 1)); }
      if (e.key === "ArrowRight") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, editions.length, side]);

  // What the story asks of you, answered in a click — or skipped. A story
  // with nothing to answer can still be skipped when it wants a decision.
  const actions = (item: BriefingItem, edition: string) => {
    const ask = !!item.replies?.length || item.slot === "decide";
    if (!ask) return null;
    const answered = [...sent].some((k) => k.startsWith(edition + "|" + item.session + "|"));
    return (
      <div className="brief-replies" role="group" aria-label="Answer">
        {(item.replies || []).map((r) => {
          const k = edition + "|" + item.session + "|" + r;
          return onReply ? (
            <button key={r} type="button" className={"brief-reply" + (sent.has(k) ? " sent" : "")}
                    disabled={!!sending || answered}
                    title={queued.has(k) ? `Queued: hop types “${r}” into ${label(item.session)} when its turn ends` : `Type “${r}” into ${label(item.session)}`}
                    onClick={() => void reply(item, edition, r)}>
              {queued.has(k) ? "⧗ " : sent.has(k) ? "✓ " : sending === k ? "… " : ""}{r}
            </button>
          ) : <span key={r} className="brief-reply static">{r}</span>;
        })}
        {!answered && (
          <button type="button" className="brief-skip" title="Pass on this one: nothing is sent, and it counts as handled"
                  onClick={() => skip(item, edition)}>Skip</button>
        )}
      </div>
    );
  };

  // One story card — the same on the front page, a session's thread, and
  // its Briefing tab. In a thread the card says when it ran instead of
  // whose it is, and only the newest edition's asks can be answered.
  const story = (item: BriefingItem, edition: string, opts: { thread?: boolean; answerable?: boolean; tag?: boolean } = {}) => {
    const unread = !isRead(edition, item.session);
    const answerable = opts.answerable ?? true;
    if (skipped.has(edition + "|" + item.session)) {
      return (
        <article key={edition + item.session + item.headline} className="brief-story skipped">
          <span className="brief-skipped-head">{opts.thread ? "" : label(item.session) + " · "}{item.headline}</span>
          <button type="button" className="brief-skip" onClick={() => unskip(item, edition)} title="Bring it back">Skipped · Undo</button>
        </article>
      );
    }
    return (
      <article key={edition + item.session + item.headline}
               ref={witnessRef.current!.ref({ edition, item: item.session, words: wordCount(`${item.headline} ${item.why || ""} ${item.recommendation || ""}`) })}
               className={"brief-story" + (unread ? " unread" : "")}>
        <div className="brief-story-head">
          {unread && <span className="brief-dot" aria-label="New" />}
          {opts.thread ? (
            <span className="brief-thread-when" title={editionWhen(edition)}>{ago(edition)}{opts.tag && item.slot ? ` · ${item.slot}` : ""}</span>
          ) : (
            <button type="button" className="brief-session" onClick={() => open(item.session, edition)} title="Open this session">
              {label(item.session)}<span aria-hidden="true"> ↗</span>
            </button>
          )}
        </div>
        <h3 className="brief-headline">{say(item.headline)}</h3>
        {item.why && <Prose className="brief-why" text={say(item.why)} />}
        {item.recommendation && (
          <div className="brief-reco"><span className="brief-reco-label">Suggested</span><Prose text={say(item.recommendation)} /></div>
        )}
        {answerable && actions(item, edition)}
      </article>
    );
  };

  const editionBody = (e: Edition, edition: string, opts: { thread?: boolean; answerable?: boolean } = {}): ReactNode => {
    const items = e.items || [];
    if (!items.some((it) => it.slot)) return <section className="brief-slot">{items.map((it) => story(it, edition, opts))}</section>;
    const also = items.filter((it) => it.slot === "also");
    if (opts.thread && also.length) {
      const rest = items.filter((it) => it.slot !== "also");
      return (
        <>
          {rest.length > 0 && editionBody({ ...e, items: items.filter((it) => it.slot !== "also") }, edition, opts)}
          <section className="brief-slot slot-also">
            <h2 className="brief-slot-head"><span>Also</span><span className="brief-slot-n">{also.length}</span></h2>
            {also.map((it) => story(it, edition, opts))}
          </section>
        </>
      );
    }
    return (
      <>
        {SLOTS.map(([slot, name, hint]) => {
          const rows = items.filter((it) => it.slot === slot);
          if (!rows.length) return null;
          return (
            <section key={slot} className={"brief-slot slot-" + slot}>
              <h2 className="brief-slot-head"><span>{name}</span><span className="brief-slot-n">{rows.length}</span><span className="brief-slot-hint">{hint}</span></h2>
              {rows.map((it) => story(it, edition, opts))}
            </section>
          );
        })}
        {also.length > 0 && (
          <section className="brief-slot slot-also">
            <h2 className="brief-slot-head"><span>Also</span><span className="brief-slot-n">{also.length}</span></h2>
            <div className="brief-also">
              {also.map((it) => (
                <button key={it.session} type="button" className={"brief-also-row" + (isRead(edition, it.session) ? "" : " unread")}
                        ref={witnessRef.current!.ref({ edition, item: it.session, words: wordCount(it.headline) })}
                        onClick={() => open(it.session, edition)}>
                  <span className="brief-also-name">{label(it.session)}</span>
                  <span className="brief-also-head">{say(it.headline)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </>
    );
  };

  return (
    <div className={"place-page briefing-page" + (inSession ? " in-session" : "") + (side ? " side" : "")} role={inSession ? "tabpanel" : side ? "complementary" : "region"} aria-label="Briefing" tabIndex={-1} ref={panelRef}>
      {side && onResizeSide && <SideHandle label="Resize Briefing" onResize={onResizeSide} />}
      {/* A tab has no head of its own (the tab names it): its way to the column floats at the top. */}
      {inSession && onToggleSide && <div className="place-tab-acts"><SideToggle side={false} onToggle={onToggleSide} /></div>}
      {!inSession && <header className="place-head">
        <span className="place-title"><span className="place-spark" aria-hidden="true">✦</span>Briefing</span>
        {side && scopeLabel && onScope && <SideScope label={scopeLabel} all={!sessionKey} onScope={onScope} />}
        <span className="place-spacer" />
        {side && onToggleSide && <SideToggle side onToggle={onToggleSide} />}
        {side && <button type="button" className="views-close" aria-label="Close briefing" onClick={onClose}>×</button>}
        {/* In the column the edition picker is a line of its own. */}
        {side && !sessionKey && editions.length > 1 && <span className="place-break" />}
        {!sessionKey && editions.length > 1 && (
          <span className="place-nav">
            <button type="button" aria-label="Earlier edition" title="Earlier (←)" disabled={index >= editions.length - 1}
                    onClick={() => setIndex((i) => Math.min(editions.length - 1, i + 1))}>‹</button>
            <select aria-label="Edition" value={index} onChange={(e) => setIndex(Number(e.target.value))}>
              {editions.map((x, i) => <option key={x.generated_at || i} value={i}>{i === 0 ? "Latest · " : ""}{editionWhen(x.generated_at)}</option>)}
            </select>
            <button type="button" aria-label="Later edition" title="Later (→)" disabled={index === 0}
                    onClick={() => setIndex((i) => Math.max(0, i - 1))}>›</button>
          </span>
        )}
        {!side && onToggleSide && <SideToggle side={false} onToggle={onToggleSide} />}
        {!side && <button type="button" className="views-close" aria-label="Close briefing" onClick={onClose}>×</button>}
      </header>}
      <div className="place-col">
        {!editions.length ? (
          <div className="place-empty">
            <p className="place-lede">No briefing yet.</p>
            <p>The host agent writes one as your sessions work: what wants a decision, what to watch, what finished.</p>
          </div>
        ) : sessionKey ? (
          <>
            <p className="place-dateline">Everything the briefing said about {label(sessionKey)} · {thread.length} {thread.length === 1 ? "note" : "notes"}</p>
            {!thread.length && <p className="place-empty-line">The briefing hasn't mentioned this session.</p>}
            {thread.length > 0 && (() => {
              const newest = editions[0]?.generated_at || "";
              const latestAt = thread[0].at;
              const latest = thread.filter((it) => it.at === latestAt);
              // Editions restate a story while it lasts: a run of the same
              // headline is one card, and the past opens a few at a time.
              const earlier = thread.filter((it, i) => it.at !== latestAt && it.headline !== thread[i - 1]?.headline);
              const shown = allEarlier ? earlier : earlier.slice(0, EARLIER_SHOWN);
              const latestEdition: Edition = { generated_at: latestAt, items: latest };
              return (
                <>
                  {editionBody(latestEdition, latestAt, { thread: true, answerable: latestAt === newest })}
                  {earlier.length > 0 && (
                    <section className="brief-slot slot-earlier">
                      <h2 className="brief-slot-head"><span>Earlier</span><span className="brief-slot-n">{earlier.length}</span></h2>
                      {shown.map((it) => story(it, it.at, { thread: true, answerable: false, tag: true }))}
                      {shown.length < earlier.length && (
                        <button type="button" className="brief-more" onClick={() => setAllEarlier(true)}>Show {earlier.length - shown.length} more</button>
                      )}
                    </section>
                  )}
                </>
              );
            })()}
          </>
        ) : ed ? (
          <>
            <p className="place-dateline">{editionWhen(stamp)}{index === 0 ? ` · ${ago(stamp)}` : ""}</p>
            <p className="place-lede">{say(ed.summary)}</p>
            {editionBody(ed, stamp)}
          </>
        ) : null}
      </div>
    </div>
  );
};
