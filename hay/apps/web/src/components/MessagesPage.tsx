import { useEffect, useMemo, useRef, useState } from "react";
import { newestAt, OUTSIDE, statusLine, threadsOf, type AgentMessage, type Thread } from "../utils/messageThreads";

/** Enough of a session to say whether its agent is there to talk to. */
type SessionLite = {
  name: string;
  displayName?: string;
  internalName?: string;
  active?: boolean;
  agent?: string | null;
  agentPhase?: string | null;
  attentionReason?: string | null;
};

type Props = {
  sessions: SessionLite[];
  /** "page": beside the docked sidebar; "sheet": the whole window. */
  placement: "page" | "sheet";
  onClose: () => void;
  onOpenSession: (key: string) => void;
  /** The newest message time this page has shown (the strip's badge). */
  onSeen?: (at: number) => void;
  /** Tests: the clock, and the log without a fetch. */
  now?: number;
  initial?: AgentMessage[];
};

const POLL_MS = 10_000;
const LONG_TEXT = 900;

const presenceOf = (s: SessionLite | undefined): { cls: string; label: string } => {
  if (!s || s.active === false) return { cls: "off", label: "not running" };
  if (!s.agent) return { cls: "shell", label: "a shell" };
  if (s.attentionReason === "ask") return { cls: "ask", label: "waiting on its person" };
  if (s.agentPhase === "working") return { cls: "busy", label: "busy" };
  return { cls: "free", label: "free" };
};

const fmtTime = (at: number, now: number): string => {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};

const MessageText = ({ text }: { text: string }) => {
  const long = text.length > LONG_TEXT || text.split("\n").length > 14;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={"msg-text" + (long && !open ? " clamped" : "")}>{text}</div>
      {long && <button type="button" className="msg-more" onClick={() => setOpen((v) => !v)}>{open ? "Show less" : "Show all"}</button>}
    </>
  );
};

/**
 * Messages: what the agents in your sessions said to each other with hop
 * send, and what became of each message. Read-only — messaging is for
 * agents; you talk to a session in its terminal.
 */
export const MessagesPage = (p: Props) => {
  const sheet = p.placement === "sheet";
  const [messages, setMessages] = useState<AgentMessage[] | null>(p.initial ?? null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => sheet || (typeof window !== "undefined" && window.innerWidth < 760));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const now = p.now ?? Date.now();

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (sheet) return;
    const onResize = () => setNarrow(window.innerWidth < 760);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [sheet]);

  useEffect(() => {
    if (p.initial) return;
    let alive = true;
    const load = () => fetch("/api/messages", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive && d && Array.isArray(d.messages)) { setMessages(d.messages); setFailed(false); } })
      .catch(() => { if (alive) setFailed(true); });
    load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, [p.initial]);

  const threads = useMemo(() => threadsOf(messages ?? []), [messages]);
  // Wide: a conversation is always open (the newest, until you pick one).
  const current: Thread | undefined = threads.find((t) => t.key === picked) ?? (narrow ? undefined : threads[0]);

  const newest = messages ? newestAt(messages) : 0;
  useEffect(() => { if (newest) p.onSeen?.(newest); }, [newest]); // eslint-disable-line react-hooks/exhaustive-deps
  // A conversation opens at its newest message.
  useEffect(() => { threadEndRef.current?.scrollIntoView?.({ block: "end" }); }, [current?.key, current?.count]);

  // Esc: out of a conversation (narrow), else out of the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      if (narrow && picked) setPicked(null);
      else p.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, picked, p.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const sessionBy = (key: string) => p.sessions.find((s) => (s.internalName || s.name) === key);
  const nameIn = (t: Thread, key: string) => sessionBy(key)?.displayName || t.names[key] || key;
  const fmt = (at: number) => fmtTime(at, now);

  const who = (t: Thread, key: string) => {
    if (key === OUTSIDE) return <span className="msg-party outside">{t.names[key]}</span>;
    const pres = presenceOf(sessionBy(key));
    return (
      <button type="button" className="msg-party" title={`Open ${nameIn(t, key)} (${pres.label})`} onClick={() => p.onOpenSession(key)}>
        <span className={`msg-dot ${pres.cls}`} aria-label={pres.label} />
        {nameIn(t, key)}
      </button>
    );
  };

  const list = (
    <nav className="msg-list" aria-label="Conversations">
      {threads.map((t) => {
        const last = t.messages[t.messages.length - 1];
        const lastWords = last.replyAt && last.replyAt >= last.at
          ? `${nameIn(t, last.to)}: ${last.reply || "(answered)"}`
          : `${last.from ? nameIn(t, last.from) : t.names[OUTSIDE]}: ${last.text}`;
        return (
          <button key={t.key} type="button" className={"msg-row" + (current?.key === t.key ? " on" : "")}
                  aria-current={current?.key === t.key ? "true" : undefined} onClick={() => setPicked(t.key)}>
            <span className="msg-row-top">
              <span className="msg-row-names">{nameIn(t, t.a)} <span className="msg-row-and" aria-label="and">⇄</span> {nameIn(t, t.b)}</span>
              <time className="msg-row-time">{fmt(t.lastAt)}</time>
            </span>
            <span className="msg-row-last">{lastWords}</span>
            <span className="msg-row-count">{t.count === 1 ? "1 message" : `${t.count} messages`}</span>
          </button>
        );
      })}
    </nav>
  );

  const thread = current && (
    <section className="msg-thread" aria-label={`${nameIn(current, current.a)} and ${nameIn(current, current.b)}`}>
      <header className="msg-thread-head">
        {narrow && <button type="button" className="msg-back" aria-label="All conversations" onClick={() => setPicked(null)}>‹</button>}
        {who(current, current.a)}
        <span className="msg-row-and" aria-hidden="true">⇄</span>
        {who(current, current.b)}
      </header>
      <ol className="msg-items">
        {current.messages.map((m) => {
          const side = (m.from ?? OUTSIDE) === current.a ? "left" : "right";
          const sender = m.from ? nameIn(current, m.from) : current.names[OUTSIDE];
          return (
            <li key={m.id} className="msg-pair">
              <div className={`msg-item ${side} st-${m.status}`}>
                <div className="msg-meta">
                  <span className="msg-who">{sender}</span>
                  <time dateTime={new Date(m.at).toISOString()}>{fmt(m.at)}</time>
                  {m.scheduled && <span className="msg-tag">check-back</span>}
                  {m.replyHere && <span className="msg-tag">waits for the answer</span>}
                </div>
                <div className="msg-bubble"><MessageText text={m.text} /></div>
                <div className="msg-status">{statusLine({ ...m, toName: nameIn(current, m.to) }, fmt)}</div>
              </div>
              {m.replyAt && (
                <div className={`msg-item ${side === "left" ? "right" : "left"} reply`}>
                  <div className="msg-meta">
                    <span className="msg-who">{nameIn(current, m.to)}</span>
                    <time dateTime={new Date(m.replyAt).toISOString()}>{fmt(m.replyAt)}</time>
                    <span className="msg-tag">its turn's answer</span>
                  </div>
                  <div className="msg-bubble"><MessageText text={m.reply || "(the turn ended without words)"} /></div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div ref={threadEndRef} />
    </section>
  );

  const empty = messages !== null && threads.length === 0;
  return (
    <div className={"place-page messages-page" + (sheet ? " sheet" : "") + (narrow ? " narrow" : "")}
         role={sheet ? "dialog" : "region"} aria-label="Messages" tabIndex={-1} ref={rootRef}>
      <header className="place-head">
        <span className="place-title">Messages</span>
        <span className="msg-head-note">between your sessions' agents</span>
        <span className="place-spacer" />
        <button type="button" className="views-close" aria-label="Close messages" onClick={p.onClose}>×</button>
      </header>
      {messages === null && !failed && <p className="msg-empty">Loading…</p>}
      {failed && messages === null && <p className="msg-empty">Couldn't load the messages. hop tries again in a few seconds.</p>}
      {empty && (
        <div className="msg-empty">
          <p>No messages between sessions yet.</p>
          <p>When an agent reaches another session with <code>hop send</code>, their conversation shows here: who wrote, what, and whether it got through.</p>
        </div>
      )}
      {threads.length > 0 && (
        <div className="msg-body">
          {(!narrow || !current) && list}
          {thread}
        </div>
      )}
      {threads.length > 0 && (
        <p className="msg-foot">Read-only. Agents write to each other with <code>hop send</code>; you talk to a session in its terminal.</p>
      )}
    </div>
  );
};
