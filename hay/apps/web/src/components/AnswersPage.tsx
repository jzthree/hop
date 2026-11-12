import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Prose } from "../utils/prose";

/** A question its person asked a session, with the reply at that turn's end. */
export type Answer = {
  id: string;
  session: string;
  sessionName: string;
  agent: string | null;
  question: string;
  askedAt: number;
  answer: string;
  answeredAt: number;
  readAt: number | null;
};

type SessionLite = { name: string; displayName?: string; internalName?: string };

type Props = {
  sessions: SessionLite[];
  placement: "page" | "sheet";
  /** One session's answers (from its header), or every session's. */
  scope: string | null;
  onScope: (scope: string | null) => void;
  onClose: () => void;
  onOpenSession: (key: string) => void;
  /** Read marks changed: the session list's counts follow. */
  onChanged?: () => void;
  /** Tests: the clock, and the answers without a fetch. */
  now?: number;
  initial?: Answer[];
};

const POLL_MS = 10_000;
const AGENT = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" } as Record<string, string>;

const ago = (at: number, now: number): string => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
};

const Long = ({ children, lines, className }: { children: ReactNode; lines: number; className: string }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [tall, setTall] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el) setTall(el.scrollHeight > el.clientHeight + 4);
  }, [children]);
  return (
    <>
      <div ref={ref} className={className + (tall && !open ? " clamped" : "")} style={open ? undefined : { maxHeight: `${lines * 1.55}em` }}>{children}</div>
      {(tall || open) && <button type="button" className="ans-more" onClick={() => setOpen((v) => !v)}>{open ? "Show less" : "Show all"}</button>}
    </>
  );
};

/**
 * Answers: each question you asked a session, with what its agent said at
 * the end of that turn — kept here until you have read it, however much
 * the agent has done since.
 */
export const AnswersPage = (p: Props) => {
  const sheet = p.placement === "sheet";
  const [items, setItems] = useState<Answer[] | null>(p.initial ?? null);
  const [failed, setFailed] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const now = p.now ?? Date.now();

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);
  const load = () => fetch("/api/answers", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d) => { if (d && Array.isArray(d.answers)) { setItems(d.answers); setFailed(false); } })
    .catch(() => setFailed(true));
  useEffect(() => {
    if (p.initial) return;
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [p.initial]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      p.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = (a: Answer) => {
    const s = p.sessions.find((x) => (x.internalName || x.name) === a.session);
    return s?.displayName || a.sessionName || a.session;
  };
  const inScope = useMemo(() => (items ?? []).filter((a) => !p.scope || a.session === p.scope), [items, p.scope]);
  const unread = inScope.filter((a) => !a.readAt);
  // Unread first when there is any as the page opens; the choice then
  // holds (reading the last one says "Nothing unread", not a new list).
  useEffect(() => {
    if (items !== null && unreadOnly === null) setUnreadOnly(unread.length > 0);
  }, [items === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const showUnread = unreadOnly ?? unread.length > 0;
  const shown = showUnread ? unread : inScope;
  const scopeName = p.scope ? (p.sessions.find((x) => (x.internalName || x.name) === p.scope)?.displayName || inScope[0]?.sessionName || p.scope) : null;

  const markRead = (body: object, ids: string[]) => {
    const at = Date.now();
    setItems((list) => (list ?? []).map((a) => (ids.includes(a.id) && !a.readAt ? { ...a, readAt: at } : a)));
    if (p.initial) { p.onChanged?.(); return; }
    void fetch("/api/answers/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(() => p.onChanged?.()).catch(() => {});
  };
  const readOne = (a: Answer) => markRead({ ids: [a.id] }, [a.id]);
  const readAll = () => {
    const ids = unread.map((a) => a.id);
    if (!ids.length) return;
    markRead(p.scope ? { session: p.scope } : { ids }, ids);
  };

  return (
    <div className={"place-page answers-page" + (sheet ? " sheet" : "")} role={sheet ? "dialog" : "region"} aria-label="Answers" tabIndex={-1} ref={rootRef}>
      <header className="place-head">
        <span className="place-title">Answers</span>
        {scopeName && (
          <span className="ans-scope">
            from <strong>{scopeName}</strong>
            <button type="button" className="ans-scope-x" aria-label="Every session's answers" title="Every session" onClick={() => p.onScope(null)}>×</button>
          </span>
        )}
        <span className="place-spacer" />
        <button type="button" className="views-close" aria-label="Close answers" onClick={p.onClose}>×</button>
      </header>
      <div className="place-col ans-col">
        <div className="ans-bar">
          <div className="ans-seg" role="tablist" aria-label="Which answers">
            <button type="button" role="tab" aria-selected={showUnread} onClick={() => setUnreadOnly(true)}>Unread{unread.length ? ` ${unread.length}` : ""}</button>
            <button type="button" role="tab" aria-selected={!showUnread} onClick={() => setUnreadOnly(false)}>All</button>
          </div>
          <span className="place-spacer" />
          {unread.length > 0 && <button type="button" className="ans-readall" onClick={readAll}>Mark all read</button>}
        </div>
        {items === null && !failed && <p className="ans-empty">Loading…</p>}
        {failed && items === null && <p className="ans-empty">Couldn't load the answers. hop tries again in a few seconds.</p>}
        {items !== null && shown.length === 0 && (
          <div className="ans-empty">
            <p>{showUnread ? "Nothing unread." : "No answers yet."}</p>
            <p>When you ask {scopeName ? scopeName : "a session"} something, its reply shows up here when the turn ends. It stays here until you've read it, however much the agent does afterwards.</p>
          </div>
        )}
        <ol className="ans-list">
          {shown.map((a) => (
            <li key={a.id} className={"ans-card" + (a.readAt ? "" : " unread")}>
              <div className="ans-meta">
                {!p.scope && (
                  <button type="button" className="ans-session" title={`Open ${nameOf(a)}`} onClick={() => { readOne(a); p.onOpenSession(a.session); }}>{nameOf(a)}</button>
                )}
                {a.agent && <span className="ans-agent">{AGENT[a.agent] || a.agent}</span>}
                <time dateTime={new Date(a.answeredAt).toISOString()} title={new Date(a.answeredAt).toLocaleString()}>answered {ago(a.answeredAt, now)}</time>
              </div>
              <div className="ans-q">
                <span className="ans-q-label">You asked</span>
                <Long lines={4} className="ans-q-text">{a.question}</Long>
              </div>
              <Long lines={18} className="ans-a">
                {a.answer.trim() ? <Prose text={a.answer} /> : <p className="ans-none">The turn ended without words. Open the session to see what it did.</p>}
              </Long>
              <div className="ans-acts">
                {!a.readAt && <button type="button" className="ans-btn primary" onClick={() => readOne(a)}>Mark read</button>}
                <button type="button" className="ans-btn" onClick={() => { readOne(a); p.onOpenSession(a.session); }}>Open session</button>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
};
