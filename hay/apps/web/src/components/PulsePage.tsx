import { useEffect, useMemo, useRef, useState } from "react";
import { dayLabel, pulseItemsFor, type Pulse, type PulseAction, type PulseFeed, type PulseSection } from "../utils/pulseFeed";
import { Prose, plainText } from "../utils/prose";
import { useSavedScroll } from "../utils/savedScroll";
import { menuIsOpen } from "./ContextMenu";

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
const MYBOT_URL = "https://github.com/jzhoulab/mybot#readme";
export const MYBOT_INSTALL = "curl -fsSL https://raw.githubusercontent.com/jzhoulab/mybot/main/install.sh | sh";
// An item passed over: it folds to a line, in this browser, and can come back.
const SKIP_KEY = "hop_pulse_skipped";
const SKIP_CAP = 300;
const EARLIER_SHOWN = 3;
const loadSkipped = (): Set<string> => {
  try { const a = JSON.parse(localStorage.getItem(SKIP_KEY) || "[]"); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); }
};
const saveSkipped = (set: Set<string>) => {
  try { localStorage.setItem(SKIP_KEY, JSON.stringify([...set].slice(-SKIP_CAP))); } catch { /* per-browser only */ }
};

export const PulsePage = ({ feed, existing, onFollowUp, sessions = [], session, onClearSession, inSession = false, markSeen, onClose }: Props) => {
  // The day being read survives a refresh (this browser tab).
  const [dayIndex, setDayIndex] = useState(() => { try { return Number(sessionStorage.getItem("hop_pulse_day") || 0) || 0; } catch { return 0; } });
  useEffect(() => { try { sessionStorage.setItem("hop_pulse_day", String(dayIndex)); } catch { /* private window */ } }, [dayIndex]);
  const [engine, setEngine] = useState(() => { try { return localStorage.getItem(ENGINE_KEY) || "claude"; } catch { return "claude"; } });
  const [launching, setLaunching] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(loadSkipped);
  const [allEarlier, setAllEarlier] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const colRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { panelRef.current?.focus(); }, []);
  useSavedScroll(panelRef, `hop_pulse_scroll:${inSession ? "tab:" : ""}${session || ""}`, !!feed);
  // Today's pulse read whole counts as seen; one session's share doesn't.
  useEffect(() => { if (feed && !session) markSeen(); }, [feed, session, markSeen]);
  // A new day or engine opens at its top.
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) { firstLayout.current = false; return; }   // a refresh keeps its place
    colRef.current?.scrollTo?.({ top: 0 }); panelRef.current?.scrollTo?.({ top: 0 });
  }, [dayIndex, engine]);

  const days = feed?.days || [];
  const day = days[Math.min(dayIndex, Math.max(0, days.length - 1))];
  const pulses = day?.pulses || [];
  const pulse: Pulse | undefined = pulses.find((p) => p.engine === engine) || pulses[0];
  const chooseEngine = (e: string) => { setEngine(e); try { localStorage.setItem(ENGINE_KEY, e); } catch { /* per-browser only */ } };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menuIsOpen()) return;
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

  const skipKey = (section: PulseSection, p: Pulse) => `${p.date}|${p.engine}|${section.id}`;
  const setSkip = (k: string, on: boolean) => setSkipped((prev) => {
    const next = new Set(prev);
    if (on) next.add(k); else next.delete(k);
    saveSkipped(next);
    return next;
  });
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
        {action && (
          <button type="button" className="pulse-quiet" title="Pass on this one: nothing is started, and it folds away"
                  onClick={() => setSkip(skipKey(section, p), true)}>Skip</button>
        )}
      </div>
    );
  };

  // One item — the same card on the day's page, a session's share, and its
  // Pulse tab; in a share it says which day and pulse it came from.
  const card = (section: PulseSection, p: Pulse, opts: { when?: boolean } = {}) => {
    const k = skipKey(section, p);
    const when = opts.when ? <span className="brief-thread-when">{dayLabel(p.date)} · {p.label}</span> : null;
    if (skipped.has(k)) {
      return (
        <article key={k} className="pulse-card skipped">
          <span className="brief-skipped-head">{section.title || plainText(section.body).slice(0, 90)}</span>
          <button type="button" className="brief-skip" onClick={() => setSkip(k, false)} title="Bring it back">Skipped · Undo</button>
        </article>
      );
    }
    if (section.kind === "article") {
      return (
        <article key={k} className="pulse-article">
          {when}
          <h3 className="pulse-article-title">{section.title}</h3>
          {controls(section, p)}
          <Prose text={section.body} figures={section.figures} />
        </article>
      );
    }
    return (
      <article key={k} className="pulse-card">
        {when}
        {section.title && <h3 className="brief-headline">{section.title}</h3>}
        <Prose text={section.body} figures={section.figures} />
        {controls(section, p)}
      </article>
    );
  };
  const sectionsOf = (items: Array<{ section: PulseSection; pulse: Pulse }>, opts: { when?: boolean } = {}) => {
    const over = items.filter((x) => x.section.kind !== "article");
    const ideas = items.filter((x) => x.section.kind === "article");
    return (
      <>
        {over.length > 0 && (
          <section className="pulse-overlooked">
            <h2 className="brief-slot-head"><span>You may have overlooked</span><span className="brief-slot-n">{over.length}</span></h2>
            {over.map((x) => card(x.section, x.pulse, opts))}
          </section>
        )}
        {ideas.length > 0 && (
          <section className="pulse-ideas">
            <h2 className="brief-slot-head"><span>Ideas</span><span className="brief-slot-n">{ideas.length}</span></h2>
            {ideas.map((x) => card(x.section, x.pulse, opts))}
          </section>
        )}
      </>
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
            {mine.length > 0 && (() => {
              // The newest day with anything for this session, laid out as
              // that day's page is; then earlier days, a few at a time.
              const latest = mine.filter((x) => x.date === mine[0].date);
              const earlier = mine.filter((x) => x.date !== mine[0].date);
              const shown = allEarlier ? earlier : earlier.slice(0, EARLIER_SHOWN);
              return (
                <>
                  <p className="place-dateline">{dayLabel(mine[0].date)}</p>
                  {sectionsOf(latest, { when: new Set(latest.map((x) => x.pulse.engine)).size > 1 })}
                  {earlier.length > 0 && (
                    <section className="brief-slot slot-earlier">
                      <h2 className="brief-slot-head"><span>Earlier</span><span className="brief-slot-n">{earlier.length}</span></h2>
                      {shown.map((x) => card(x.section, x.pulse, { when: true }))}
                      {shown.length < earlier.length && (
                        <button type="button" className="brief-more" onClick={() => setAllEarlier(true)}>Show {earlier.length - shown.length} more</button>
                      )}
                    </section>
                  )}
                </>
              );
            })()}
          </>
        ) : !pulse ? (
          <div className="place-empty pulse-get">
            <p className="place-lede">A pulse each morning, from mybot.</p>
            <p>mybot reads your Claude Code and Codex sessions on this machine and writes a short page every morning: ideas worth pursuing, and the things that slipped through the cracks — each one a click from the session it came from. It lands here, on your phone, and in its menu app.</p>
            <p>Install it with one line (it runs locally and asks what it may read):</p>
            <button type="button" className="update-pop-cmd" onClick={() => copy("install", MYBOT_INSTALL)} title="Copy the command">
              <code>{MYBOT_INSTALL}</code><span>{copied === "install" ? "copied" : "copy"}</span>
            </button>
            <p className="place-empty-line">Already installed? The first pulse arrives the next morning — <a href={MYBOT_URL} target="_blank" rel="noreferrer">about mybot ↗</a></p>
          </div>
        ) : (
          <>
            <p className="place-dateline">{dayLabel(pulse.date)} · {pulse.label}</p>
            <h1 className="pulse-title">{pulse.title}</h1>
            {pulse.sections.filter((s) => s.kind === "intro").map((s) => <Prose key={s.id} className="place-lede" text={s.body} figures={s.figures} />)}
            {pulse.sections.filter((s) => s.kind === "note").map((s) => <Prose key={s.id} className="pulse-note" text={s.body} figures={s.figures} />)}
            {sectionsOf([...overlooked, ...articles].map((section) => ({ section, pulse: pulse! })))}
          </>
        )}
      </div>
    </div>
  );
};
