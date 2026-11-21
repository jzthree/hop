import { useEffect, useMemo, useRef, useState } from "react";
import { Prose } from "../utils/prose";
import { preview, promptText, sourceLabel, sourceTag, tabOf, unreadByTab, type Answer, type AnswerTab } from "../utils/answers";

export type { Answer } from "../utils/answers";

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
  /** Tests: the clock, the answers without a fetch, and the width. */
  now?: number;
  initial?: Answer[];
  narrow?: boolean;
};

const POLL_MS = 10_000;
const NARROW_PX = 760;
const AGENT = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" } as Record<string, string>;

const ago = (at: number, now: number): string => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
};

const useNarrow = (forced?: boolean) => {
  const query = `(max-width: ${NARROW_PX}px)`;
  const [narrow, setNarrow] = useState(() => forced ?? (typeof window !== "undefined" && !!window.matchMedia?.(query).matches));
  useEffect(() => {
    if (forced !== undefined || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [forced, query]);
  return forced ?? narrow;
};

/**
 * Answers: each turn that ended with words, kept until you have read it,
 * however much the agent has done since. Two tabs: the questions you asked,
 * and the turns something else started (another session's message, a
 * check-back, a loop). A list on the left, the turn on the right — one at a
 * time where the screen is narrow.
 */
export const AnswersPage = (p: Props) => {
  const sheet = p.placement === "sheet";
  const narrow = useNarrow(p.narrow);
  const [items, setItems] = useState<Answer[] | null>(p.initial ?? null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<AnswerTab>("you");
  const [unreadOnly, setUnreadOnly] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Narrow: the list, or one turn.
  const [reading, setReading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
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

  const nameOf = (a: Answer) => {
    const s = p.sessions.find((x) => (x.internalName || x.name) === a.session);
    return s?.displayName || a.sessionName || a.session;
  };
  const inScope = useMemo(() => (items ?? []).filter((a) => !p.scope || a.session === p.scope), [items, p.scope]);
  const unreadCounts = useMemo(() => unreadByTab(inScope), [inScope]);
  const inTab = inScope.filter((a) => tabOf(a) === tab);
  const unread = inTab.filter((a) => !a.readAt);
  // Opening on the tab that has unread answers, yours first; unread first
  // when there is any. The choices then hold.
  useEffect(() => {
    if (items === null || unreadOnly !== null) return;
    const first: AnswerTab = unreadCounts.you || !unreadCounts.agents ? "you" : "agents";
    setTab(first);
    setUnreadOnly(unreadCounts[first] > 0);
  }, [items === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const showUnread = unreadOnly ?? unread.length > 0;
  // The one being read stays in the list once read (it would vanish under you).
  const shown = showUnread ? inTab.filter((a) => !a.readAt || a.id === selected) : inTab;
  const current = shown.find((a) => a.id === selected) || (!narrow ? shown[0] : undefined) || null;
  const scopeName = p.scope ? (p.sessions.find((x) => (x.internalName || x.name) === p.scope)?.displayName || inScope[0]?.sessionName || p.scope) : null;

  const markRead = (body: object, ids: string[]) => {
    const at = Date.now();
    setItems((list) => (list ?? []).map((a) => (ids.includes(a.id) && !a.readAt ? { ...a, readAt: at } : a)));
    if (p.initial) { p.onChanged?.(); return; }
    void fetch("/api/answers/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(() => p.onChanged?.()).catch(() => {});
  };
  const readOne = (a: Answer) => { if (!a.readAt) markRead({ ids: [a.id] }, [a.id]); };
  const readAll = () => {
    const ids = unread.map((a) => a.id);
    if (ids.length) markRead({ ids }, ids);
  };
  // Opening one reads it, as in a mail app.
  const open = (a: Answer) => {
    setSelected(a.id);
    setReading(true);
    readOne(a);
  };
  const switchTab = (t: AnswerTab) => {
    if (t === tab) return;
    setTab(t);
    setSelected(null);
    setReading(false);
    setUnreadOnly(unreadCounts[t] > 0);
  };

  // Escape closes (or, narrow and reading, goes back to the list); ↑/↓ (or k/j) move through the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (narrow && reading) setReading(false); else p.onClose();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
      if (!step || !shown.length || (narrow && !reading && e.key.startsWith("Arrow"))) return;
      e.preventDefault();
      const i = current ? shown.findIndex((a) => a.id === current.id) : -1;
      const next = shown[Math.max(0, Math.min(shown.length - 1, i + step))];
      if (next) {
        open(next);
        listRef.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.scrollIntoView?.({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // every render: it reads the current list

  const listPane = (
    <div className="ans-inbox" aria-label={tab === "you" ? "Your questions" : "Turns agents started"}>
      {items === null && !failed && <p className="ans-empty">Loading…</p>}
      {failed && items === null && <p className="ans-empty">Couldn't load the answers. hop tries again in a few seconds.</p>}
      {items !== null && shown.length === 0 && (
        <div className="ans-empty">
          <p>{showUnread ? "Nothing unread." : tab === "you" ? "No answers yet." : "Nothing from agents yet."}</p>
          <p>{tab === "you"
            ? `When you ask ${scopeName || "a session"} something, its reply shows up here when the turn ends. It stays here until you've read it, however much the agent does afterwards.`
            : "Turns that another session's message, a check-back or a loop started show up here, apart from your own questions."}</p>
        </div>
      )}
      <ol className="ans-rows" ref={listRef}>
        {shown.map((a) => {
          const tag = sourceTag(a);
          const isCurrent = current?.id === a.id && (!narrow || reading);
          return (
            <li key={a.id}>
              <button type="button" data-id={a.id} className={"ans-row" + (a.readAt ? "" : " unread") + (isCurrent ? " current" : "")}
                      aria-current={isCurrent ? "true" : undefined} onClick={() => open(a)}>
                <span className="ans-row-top">
                  <span className="ans-row-dot" aria-label={a.readAt ? undefined : "Unread"} />
                  {!p.scope && <span className="ans-row-session">{nameOf(a)}</span>}
                  {tag && <span className="ans-row-tag">{tag}</span>}
                  <span className="ans-row-spacer" />
                  <time dateTime={new Date(a.answeredAt).toISOString()}>{ago(a.answeredAt, now)}</time>
                </span>
                <span className="ans-row-q">{preview(a.question)}</span>
                <span className="ans-row-a">{a.answer.trim() ? preview(a.answer, 120) : "Ended without words"}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );

  const readerPane = current ? (
    <article className="ans-reader" aria-label={`${nameOf(current)}: ${sourceLabel(current)}`}>
      {narrow && <button type="button" className="ans-back" onClick={() => setReading(false)}>‹ {tab === "you" ? "Your questions" : "From agents"}</button>}
      <header className="ans-reader-head">
        <button type="button" className="ans-session" title={`Open ${nameOf(current)}`} onClick={() => { readOne(current); p.onOpenSession(current.session); }}>{nameOf(current)}</button>
        {current.agent && <span className="ans-agent">{AGENT[current.agent] || current.agent}</span>}
        <span className="ans-row-spacer" />
        <time dateTime={new Date(current.answeredAt).toISOString()} title={new Date(current.answeredAt).toLocaleString()}>answered {ago(current.answeredAt, now)}</time>
      </header>
      <section className={"ans-q" + (tabOf(current) === "agents" ? " agents" : "")}>
        <span className="ans-q-label">{sourceLabel(current)}</span>
        <div className="ans-q-text">{promptText(current.question)}</div>
      </section>
      <div className="ans-a">
        {current.answer.trim() ? <Prose text={current.answer} /> : <p className="ans-none">The turn ended without words. Open the session to see what it did.</p>}
      </div>
      <div className="ans-acts">
        {!current.readAt && <button type="button" className="ans-btn primary" onClick={() => readOne(current)}>Mark read</button>}
        <button type="button" className="ans-btn" onClick={() => { readOne(current); p.onOpenSession(current.session); }}>Open session</button>
      </div>
    </article>
  ) : (
    <div className="ans-reader ans-reader-empty">{shown.length ? "Pick one on the left to read it." : ""}</div>
  );

  return (
    <div className={"place-page answers-page" + (sheet ? " sheet" : "") + (narrow ? " narrow" : "")} role={sheet ? "dialog" : "region"} aria-label="Answers" tabIndex={-1} ref={rootRef}>
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
      <div className="ans-bar">
        <div className="ans-tabs" role="tablist" aria-label="Who started it">
          {([["you", "From you"], ["agents", "From agents"]] as const).map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => switchTab(t)}>
              {label}{unreadCounts[t] ? <> <span className="ans-tab-count">{unreadCounts[t]}</span></> : null}
            </button>
          ))}
        </div>
        <span className="place-spacer" />
        <div className="ans-seg" role="radiogroup" aria-label="Which answers">
          <button type="button" role="radio" aria-checked={showUnread} onClick={() => setUnreadOnly(true)}>Unread</button>
          <button type="button" role="radio" aria-checked={!showUnread} onClick={() => setUnreadOnly(false)}>All</button>
        </div>
        {unread.length > 0 && <button type="button" className="ans-readall" onClick={readAll}>Mark all read</button>}
      </div>
      <div className={"ans-split" + (narrow ? (reading && current ? " reading" : " listing") : "")}>
        {(!narrow || !reading || !current) && listPane}
        {(!narrow || (reading && current)) && readerPane}
      </div>
    </div>
  );
};
