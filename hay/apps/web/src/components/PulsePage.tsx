import { useEffect, useMemo, useRef, useState } from "react";
import { dayLabel, pulseItemsFor, type Pulse, type PulseAction, type PulseFeed, type PulseSection } from "../utils/pulseFeed";
import { Prose, plainText } from "../utils/prose";

// mybot's pulse as a place beside the sidebar: a day's reading, laid out
// like a journal page — the title, the intro as its lede, what you may have
// overlooked as cards you can act on, then the ideas as short essays. One
// pulse per engine (Claude, GPT); earlier days are a step back (‹ ›, ← →).
//
// Acting on an item is one click, as on the phone: the session that already
// owns it gets a one-line message; else an earlier follow-up opens; else a
// new session starts in the item's folder and runs the command mybot
// prepared. "Discuss" continues in mybot's chat, with the question started
// on the clipboard.
//
// A session picked in the sidebar narrows the page to that session's share
// — the items it owns or that followed up into it, every day kept — as it
// narrows the briefing and Views; full screen, that is the session's Pulse
// tab.

type SessionInfo = { name: string; displayName?: string; internalName?: string };

type Props = {
  feed: PulseFeed | null;
  /** Names of the sessions that exist, so a follow-up already started reads "Open". */
  existing: Set<string>;
  onFollowUp: (action: PulseAction) => Promise<boolean>;
  sessions?: SessionInfo[];
  /** The sidebar's session: the page shows its items. */
  session?: string | null;
  onClearSession?: () => void;
  /** A session's Pulse tab: the tab names the page and the session. */
  inSession?: boolean;
  markSeen: () => void;
  onClose: () => void;
};

const ENGINE_KEY = "hop_pulse_engine";

export const PulsePage = ({ feed, existing, onFollowUp, sessions = [], session, onClearSession, inSession = false, markSeen, onClose }: Props) => {
  const [dayIndex, setDayIndex] = useState(0);
  const [engine, setEngine] = useState(() => { try { return localStorage.getItem(ENGINE_KEY) || "claude"; } catch { return "claude"; } });
  const [launching, setLaunching] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const colRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { panelRef.current?.focus(); }, []);
  // Today's pulse read whole counts as seen; one session's share doesn't.
  useEffect(() => { if (feed && !session) markSeen(); }, [feed, session, markSeen]);
  // A new day or engine opens at its top.
  useEffect(() => { colRef.current?.scrollTo?.({ top: 0 }); panelRef.current?.scrollTo?.({ top: 0 }); }, [dayIndex, engine]);

  const days = feed?.days || [];
  const day = days[Math.min(dayIndex, Math.max(0, days.length - 1))];
  const pulses = day?.pulses || [];
  const pulse: Pulse | undefined = pulses.find((p) => p.engine === engine) || pulses[0];
  const chooseEngine = (e: string) => { setEngine(e); try { localStorage.setItem(ENGINE_KEY, e); } catch { /* per-browser only */ } };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      const el = document.activeElement as HTMLElement | null;
      if (!panelRef.current?.contains(el) || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || "") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); setDayIndex((i) => Math.min(days.length - 1, i + 1)); }
      if (e.key === "ArrowRight") { e.preventDefault(); setDayIndex((i) => Math.max(0, i - 1)); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, days.length]);

  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    }).catch(() => {});
  };
  const follow = async (action: PulseAction) => {
    setLaunching(action.id);
    setFailed(null);
    const ok = await onFollowUp(action);
    setLaunching(null);
    if (!ok) setFailed(action.id);
  };
  const actionTitle = (a: PulseAction) =>
    a.targetName ? `Send to ${a.targetName}` : existing.has(a.sessionName) ? "Open follow-up" : a.label;

  const controls = (section: PulseSection, p: Pulse) => {
    const action = p.actions[section.id];
    const subject = section.title || plainText(section.body).slice(0, 70) + "…";
    return (
      <div className="pulse-controls">
        {action && (
          <button type="button" className="pulse-act" disabled={launching === action.id}
                  title={action.targetName ? `Type a one-line note into ${action.targetName}` : `In ${action.cwd || "a new session"}: ${action.command}`}
                  onClick={() => void follow(action)}>
            {launching === action.id ? "Starting…" : actionTitle(action)}<span aria-hidden="true"> →</span>
          </button>
        )}
        {action && failed === action.id && <span className="pulse-failed">hop didn't take it — try again</span>}
        <span className="place-spacer" />
        {feed?.discussUrl && (
          <button type="button" className="pulse-quiet" title="Continue in mybot's chat (the question is copied, ready to paste)"
                  onClick={() => { copy("discuss-" + section.id, `About “${subject}” (${p.label} pulse, ${p.date}): `); window.open(feed.discussUrl, "_blank", "noopener"); }}>
            {copied === "discuss-" + section.id ? "Paste in chat" : "Discuss"}
          </button>
        )}
        <button type="button" className="pulse-quiet" onClick={() => copy(section.id, plainText(section.title ? `${section.title}\n\n${section.body}` : section.body))}>
          {copied === section.id ? "Copied" : "Copy"}
        </button>
      </div>
    );
  };

  const find = (id: string) => {
    const lc = id.toLowerCase();
    return sessions.find((x) => [x.internalName, x.name, x.displayName].some((n) => (n || "").toLowerCase() === lc));
  };
  const keyOf = (id: string) => { const x = find(id); return x ? (x.internalName || x.name) : id; };
  const sessionKey = session ? keyOf(session) : null;
  const sessionLabel = sessionKey ? (find(sessionKey)?.displayName || find(sessionKey)?.name || sessionKey) : "";
  const mine = useMemo(() => (sessionKey ? pulseItemsFor(feed, (id) => keyOf(id) === sessionKey) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed, sessionKey, sessions]);

  const overlooked = pulse?.sections.filter((s) => s.kind === "overlooked") || [];
  const articles = pulse?.sections.filter((s) => s.kind === "article") || [];

  return (
    <div className={"place-page pulse-page" + (inSession ? " in-session" : "")} role={inSession ? "tabpanel" : "region"} aria-label="Pulse" tabIndex={-1} ref={panelRef}>
      {!inSession && <header className="place-head">
        <span className="place-title"><span className="place-sun" aria-hidden="true" />Pulse</span>
        {sessionKey && onClearSession && (
          <span className="views-scope-chip">
            {sessionLabel}
            <button type="button" aria-label="Show the whole pulse" title="The whole pulse" onClick={onClearSession}>×</button>
          </span>
        )}
        {!sessionKey && pulses.length > 1 && (
          <span className="views-scope-toggle" role="tablist" aria-label="Engine">
            {pulses.map((p) => (
              <button key={p.engine} type="button" role="tab" aria-selected={p.engine === pulse?.engine}
                      className={p.engine === pulse?.engine ? "on" : ""} onClick={() => chooseEngine(p.engine)}>{p.label}</button>
            ))}
          </span>
        )}
        <span className="place-spacer" />
        {!sessionKey && days.length > 1 && (
          <span className="place-nav">
            <button type="button" aria-label="Previous day" title="Previous day (←)" disabled={dayIndex >= days.length - 1}
                    onClick={() => setDayIndex((i) => Math.min(days.length - 1, i + 1))}>‹</button>
            <select aria-label="Day" value={dayIndex} onChange={(e) => setDayIndex(Number(e.target.value))}>
              {days.map((d, i) => <option key={d.date} value={i}>{dayLabel(d.date)}</option>)}
            </select>
            <button type="button" aria-label="Next day" title="Next day (→)" disabled={dayIndex === 0}
                    onClick={() => setDayIndex((i) => Math.max(0, i - 1))}>›</button>
          </span>
        )}
        <button type="button" className="views-close" aria-label="Close pulse" onClick={onClose}>×</button>
      </header>}
      <div className="place-col" ref={colRef}>
        {sessionKey ? (
          <>
            <p className="place-dateline">Everything the pulse raised for {sessionLabel} · {mine.length} {mine.length === 1 ? "item" : "items"}</p>
            {!mine.length && <p className="place-empty-line">The pulse hasn't raised anything for this session.</p>}
            {mine.map(({ date, pulse: p, section: s }) => (
              <article key={date + p.engine + s.id} className={s.kind === "article" ? "pulse-article" : "pulse-card"}>
                <span className="brief-thread-when">{dayLabel(date)} · {p.label}{s.kind === "article" ? " · idea" : ""}</span>
                {s.title && <h3 className={s.kind === "article" ? "pulse-article-title" : "brief-headline"}>{s.title}</h3>}
                <Prose text={s.body} />
                {controls(s, p)}
              </article>
            ))}
          </>
        ) : !pulse ? (
          <div className="place-empty">
            <p className="place-lede">No pulse yet.</p>
            <p>mybot writes one each morning: ideas, and the things that may have slipped through the cracks.</p>
          </div>
        ) : (
          <>
            <p className="place-dateline">{dayLabel(pulse.date)} · {pulse.label}</p>
            <h1 className="pulse-title">{pulse.title}</h1>
            {pulse.sections.filter((s) => s.kind === "intro").map((s) => <Prose key={s.id} className="place-lede" text={s.body} />)}
            {pulse.sections.filter((s) => s.kind === "note").map((s) => <Prose key={s.id} className="pulse-note" text={s.body} />)}
            {overlooked.length > 0 && (
              <section className="pulse-overlooked">
                <h2 className="brief-slot-head"><span>You may have overlooked</span><span className="brief-slot-n">{overlooked.length}</span></h2>
                {overlooked.map((s) => (
                  <article key={s.id} className="pulse-card">
                    {s.title && <h3 className="brief-headline">{s.title}</h3>}
                    <Prose text={s.body} />
                    {controls(s, pulse)}
                  </article>
                ))}
              </section>
            )}
            {articles.length > 0 && (
              <section className="pulse-ideas">
                <h2 className="brief-slot-head"><span>Ideas</span><span className="brief-slot-n">{articles.length}</span></h2>
                {articles.map((s) => (
                  <article key={s.id} className="pulse-article">
                    <h3 className="pulse-article-title">{s.title}</h3>
                    {controls(s, pulse)}
                    <Prose text={s.body} />
                  </article>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
};
