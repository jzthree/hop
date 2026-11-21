import { useEffect, useMemo, useRef, useState } from "react";
import { Prose } from "../utils/prose";
import {
  haystack, inView, markParts, matches, promptText, searchTerms, snippet, sourceLabel, sourceTag, tabOf, unreadByTab,
  type Answer, type AnswerTab, type AnswerView
} from "../utils/answers";
import { SideHandle, SideScope, SideToggle, keyStartsInside } from "./SideColumn";

export type { Answer } from "../utils/answers";

type SessionLite = { name: string; displayName?: string; internalName?: string };

type Props = {
  sessions: SessionLite[];
  /**
   * page: beside the sidebar, every session's (or one's, from its header);
   * sheet: the whole window, where there is no sidebar; tab: a session's own
   * tab under its header; side: the column beside the session.
   */
  placement: "page" | "sheet" | "tab" | "side";
  /** One session's answers, or every session's. */
  scope: string | null;
  /** Page or sheet: the way out of one session's answers to all. */
  onScope?: (scope: string | null) => void;
  /** Column: the selected session's name, and the switch between its share and all. */
  scopeLabel?: string | null;
  onSideScope?: (all: boolean) => void;
  /** Page ⇄ column, and the column's width. */
  onToggleSide?: () => void;
  onResizeSide?: (w: number | null) => void;
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
const VIEWS: [AnswerView, string][] = [["inbox", "Inbox"], ["unread", "Unread"], ["archived", "Archived"]];
const TAB_NAME: Record<AnswerTab, string> = { you: "From you", agents: "From agents" };

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

/** A text with the searched words marked. */
const Marked = ({ text, terms }: { text: string; terms: string[] }) => (
  <>{markParts(text, terms).map((x, i) => (x.hit ? <mark key={i}>{x.text}</mark> : <span key={i}>{x.text}</span>))}</>
);

const ArchiveIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M10 13h4" />
  </svg>
);

/**
 * Answers, read like mail: each turn that ended with words stays in the
 * inbox, read or not, until you archive it — however much the agent has
 * done since. Two tabs: the questions you asked, and the turns something
 * else started (another session's message, a check-back, a loop). Search
 * looks through all of it, the archive too. A list on the left, the turn
 * on the right — one at a time where the screen is narrow. Like Views,
 * Briefing and Calendar it is a page about every session, a session's
 * own tab, or the column beside a session.
 */
export const AnswersPage = (p: Props) => {
  const { placement } = p;
  const sheet = placement === "sheet";
  const side = placement === "side";
  const inSession = placement === "tab";
  const narrowScreen = useNarrow(p.narrow);
  const narrow = side || narrowScreen;
  const [items, setItems] = useState<Answer[] | null>(p.initial ?? null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<AnswerTab>("you");
  const [view, setView] = useState<AnswerView>("inbox");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // Narrow: the list, or one turn.
  const [reading, setReading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const revRef = useRef<string | null>(null);
  const tabChosen = useRef(false);
  const now = p.now ?? Date.now();

  useEffect(() => { if (!side) rootRef.current?.focus({ preventScroll: true }); }, [side]);
  // The whole list only when something changed since the one on show.
  const load = () => fetch(`/api/answers${revRef.current ? `?rev=${encodeURIComponent(revRef.current)}` : ""}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d) => {
      if (!d) return;
      if (typeof d.rev === "string") revRef.current = d.rev;
      if (Array.isArray(d.answers)) setItems(d.answers);
      setFailed(false);
    })
    .catch(() => setFailed(true));
  useEffect(() => {
    if (p.initial) return;
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [p.initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameOfKey = (key: string, fallback?: string) => {
    const s = p.sessions.find((x) => (x.internalName || x.name) === key);
    return s?.displayName || fallback || key;
  };
  const nameOf = (a: Answer) => nameOfKey(a.session, a.sessionName);
  const inScope = useMemo(() => (items ?? [])
    .filter((a) => !p.scope || a.session === p.scope)
    .sort((a, b) => b.answeredAt - a.answeredAt), [items, p.scope]);
  const hays = useMemo(() => new Map(inScope.map((a) => [a.id, haystack(a, nameOf(a))])), [inScope, p.sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const terms = useMemo(() => searchTerms(query), [query]);
  const searching = terms.length > 0;
  const found = useMemo(() => (searching ? inScope.filter((a) => matches(a, "", terms, hays.get(a.id))) : inScope), [inScope, terms, hays, searching]);
  const unreadCounts = useMemo(() => unreadByTab(inScope), [inScope]);
  const foundCounts = useMemo(() => {
    const out: Record<AnswerTab, number> = { you: 0, agents: 0 };
    for (const a of found) out[tabOf(a)] += 1;
    return out;
  }, [found]);
  const inTab = found.filter((a) => tabOf(a) === tab);
  // Opening on the tab that has unread answers, yours first. The choice then holds.
  useEffect(() => {
    if (items === null || tabChosen.current) return;
    tabChosen.current = true;
    setTab(unreadCounts.you || !unreadCounts.agents ? "you" : "agents");
  }, [items === null]); // eslint-disable-line react-hooks/exhaustive-deps
  // Search looks through every view; otherwise the view says. The one being
  // read stays in the Unread list once read (it would vanish under you).
  const shown = searching ? inTab : inTab.filter((a) => inView(a, view) || (view === "unread" && a.id === selected && !a.archivedAt));
  const current = shown.find((a) => a.id === selected) || (!narrow ? shown[0] : undefined) || null;
  const inboxUnread = inTab.filter((a) => !a.readAt && !a.archivedAt);
  const inboxRead = inTab.filter((a) => a.readAt && !a.archivedAt);
  const scopeName = p.scope ? nameOfKey(p.scope, inScope[0]?.sessionName) : null;
  const tabHasAny = inScope.some((a) => tabOf(a) === tab);

  // Changes show at once; hop is told, and the next poll brings its word.
  const act = (path: "read" | "archive" | "move", body: object, change: (a: Answer) => Answer, ids: string[]) => {
    setItems((list) => (list ?? []).map((a) => (ids.includes(a.id) ? change(a) : a)));
    if (p.initial) { p.onChanged?.(); return; }
    void fetch(`/api/answers/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); p.onChanged?.(); })
      .catch(() => { revRef.current = null; void load(); });
  };
  const markRead = (ids: string[]) => {
    const at = Date.now();
    if (ids.length) act("read", { ids }, (a) => (a.readAt ? a : { ...a, readAt: at }), ids);
  };
  const readOne = (a: Answer) => { if (!a.readAt) markRead([a.id]); };
  // After a turn leaves the list (archived, moved): the next one, as a mail app does.
  const leave = (a: Answer) => {
    if (current?.id !== a.id) return;
    const i = shown.findIndex((x) => x.id === a.id);
    const next = shown[i + 1] || shown[i - 1] || null;
    if (narrow) { setReading(false); setSelected(null); return; }
    setSelected(next ? next.id : null);
    if (next) readOne(next);
  };
  const archive = (list: Answer[], archived = true) => {
    const ids = list.map((a) => a.id);
    if (!ids.length) return;
    const at = Date.now();
    if (list.length === 1 && !searching) leave(list[0]);
    act("archive", { ids, archived }, (a) => ({ ...a, archivedAt: archived ? at : null, readAt: a.readAt || (archived ? at : a.readAt) }), ids);
  };
  const move = (a: Answer) => {
    const to: AnswerTab = tabOf(a) === "you" ? "agents" : "you";
    leave(a);
    act("move", { ids: [a.id], from: to }, (x) => ({ ...x, from: to, movedAt: Date.now() }), [a.id]);
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
  };
  const switchView = (v: AnswerView) => {
    setView(v);
    setSelected(null);
    setReading(false);
  };

  // Escape: out of the search, back to the list (narrow), or closed.
  // ↑/↓ (or k/j) move through the list; e archives (or puts back); / searches.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (side && !keyStartsInside(rootRef.current, e)) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.key === "Escape") {
        if (typing && t === searchRef.current) {
          e.preventDefault();
          if (query) setQuery(""); else searchRef.current?.blur();
          return;
        }
        if (typing) return;
        e.preventDefault();
        if (narrow && reading) setReading(false); else p.onClose();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === "e" && current && (!narrow || reading)) { e.preventDefault(); archive([current], !current.archivedAt); return; }
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

  const emptyText = (): [string, string] => {
    if (searching) return [`Nothing in ${TAB_NAME[tab]} matches “${query.trim()}”.`, foundCounts[tab === "you" ? "agents" : "you"] ? `${foundCounts[tab === "you" ? "agents" : "you"]} in ${TAB_NAME[tab === "you" ? "agents" : "you"]}.` : "Search looks through the questions, the replies and the archive."];
    if (!tabHasAny) return tab === "you"
      ? ["No answers yet.", `When you ask ${scopeName || "a session"} something, its reply shows up here when the turn ends. It stays until you archive it, however much the agent does afterwards.`]
      : ["Nothing from agents yet.", "Turns that another session's message, a check-back or a loop started show up here, apart from your own questions."];
    if (view === "unread") return ["Nothing unread.", "Read answers stay in the Inbox until you archive them."];
    if (view === "archived") return ["Nothing archived.", "Archive an answer (e) once you're done with it; it stays findable here for a month."];
    return ["Inbox empty.", "Everything here is archived: it's under Archived, and search finds it."];
  };

  const listPane = (
    <div className="ans-inbox" aria-label={tab === "you" ? "Your questions" : "Turns agents started"}>
      {items === null && !failed && <p className="ans-empty">Loading…</p>}
      {failed && items === null && <p className="ans-empty">Couldn't load the answers. hop tries again in a few seconds.</p>}
      {items !== null && shown.length === 0 && (() => {
        const [head, body] = emptyText();
        return <div className="ans-empty"><p>{head}</p><p>{body}</p></div>;
      })()}
      <ol className="ans-rows" ref={listRef}>
        {shown.map((a) => {
          const tag = sourceTag(a);
          const isCurrent = current?.id === a.id && (!narrow || reading);
          return (
            <li key={a.id} className="ans-li">
              <button type="button" data-id={a.id} className={"ans-row" + (a.readAt ? "" : " unread") + (isCurrent ? " current" : "")}
                      aria-current={isCurrent ? "true" : undefined} onClick={() => open(a)}>
                <span className="ans-row-top">
                  <span className="ans-row-dot" aria-label={a.readAt ? undefined : "Unread"} />
                  {!p.scope && <span className="ans-row-session"><Marked text={nameOf(a)} terms={terms} /></span>}
                  {tag && <span className="ans-row-tag">{tag}</span>}
                  {searching && a.archivedAt ? <span className="ans-row-tag archived">Archived</span> : null}
                  <span className="ans-row-spacer" />
                  <time dateTime={new Date(a.answeredAt).toISOString()}>{ago(a.answeredAt, now)}</time>
                </span>
                <span className="ans-row-q"><Marked text={snippet(a.question, terms)} terms={terms} /></span>
                <span className="ans-row-a">{a.answer.trim() ? <Marked text={snippet(a.answer, terms, 120)} terms={terms} /> : "Ended without words"}</span>
              </button>
              {!narrow && (
                <button type="button" className="ans-row-archive" aria-label={a.archivedAt ? "Move to inbox" : "Archive"}
                        title={a.archivedAt ? "Move to inbox" : "Archive (e)"} onClick={() => archive([a], !a.archivedAt)}>
                  {a.archivedAt ? "↩" : <ArchiveIcon />}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );

  const readerPane = current ? (
    <article className="ans-reader" aria-label={`${nameOf(current)}: ${sourceLabel(current)}`}>
      {narrow && <button type="button" className="ans-back" onClick={() => setReading(false)}>‹ {searching ? "Results" : tab === "you" ? "Your questions" : "From agents"}</button>}
      <header className="ans-reader-head">
        <button type="button" className="ans-session" title={`Open ${nameOf(current)}`} onClick={() => { readOne(current); p.onOpenSession(current.session); }}>{nameOf(current)}</button>
        {current.agent && <span className="ans-agent">{AGENT[current.agent] || current.agent}</span>}
        {current.archivedAt ? <span className="ans-agent">Archived</span> : null}
        <span className="ans-row-spacer" />
        <time dateTime={new Date(current.answeredAt).toISOString()} title={new Date(current.answeredAt).toLocaleString()}>answered {ago(current.answeredAt, now)}</time>
      </header>
      <section className={"ans-q" + (tabOf(current) === "agents" ? " agents" : "")}>
        <span className="ans-q-label">{sourceLabel(current)}</span>
        <div className="ans-q-text"><Marked text={promptText(current.question)} terms={terms} /></div>
      </section>
      <div className="ans-a">
        {current.answer.trim() ? <Prose text={current.answer} /> : <p className="ans-none">The turn ended without words. Open the session to see what it did.</p>}
      </div>
      <div className="ans-acts">
        {current.archivedAt
          ? <button type="button" className="ans-btn primary" onClick={() => archive([current], false)}>Move to inbox</button>
          : <button type="button" className="ans-btn primary" title="Archive (e)" onClick={() => archive([current])}><ArchiveIcon /> Archive</button>}
        <button type="button" className="ans-btn" onClick={() => { readOne(current); p.onOpenSession(current.session); }}>Open session</button>
        <button type="button" className="ans-btn quiet" title={tabOf(current) === "you" ? "Not your question: a loop, a schedule, an agent" : "Your own question"}
                onClick={() => move(current)}>
          {tabOf(current) === "you" ? "Move to From agents" : "Move to From you"}
        </button>
      </div>
    </article>
  ) : (
    <div className="ans-reader ans-reader-empty">{shown.length ? "Pick one on the left to read it." : ""}</div>
  );

  const search = (
    <label className="ans-search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input ref={searchRef} type="search" value={query} placeholder="Search answers" aria-label="Search answers"
             onChange={(e) => { setQuery(e.target.value); setSelected(null); setReading(false); }} />
    </label>
  );

  return (
    <div className={"place-page answers-page" + (sheet ? " sheet" : "") + (inSession ? " in-session" : "") + (side ? " side" : "") + (narrow ? " narrow" : "")}
         role={inSession ? "tabpanel" : side ? "complementary" : sheet ? "dialog" : "region"} aria-label="Answers" tabIndex={-1} ref={rootRef}>
      {side && p.onResizeSide && <SideHandle label="Resize Answers" onResize={p.onResizeSide} />}
      {/* A session's tab has no head of its own: the tab names it. */}
      {!inSession && (
        <header className="place-head">
          <span className="place-title">Answers</span>
          {side && p.scopeLabel && p.onSideScope && <SideScope label={p.scopeLabel} all={!p.scope} onScope={p.onSideScope} />}
          {!side && scopeName && (
            <span className="ans-scope">
              from <strong>{scopeName}</strong>
              {p.onScope && <button type="button" className="ans-scope-x" aria-label="Every session's answers" title="Every session" onClick={() => p.onScope?.(null)}>×</button>}
            </span>
          )}
          <span className="place-spacer" />
          {p.onToggleSide && <SideToggle side={side} onToggle={p.onToggleSide} />}
          <button type="button" className="views-close" aria-label="Close answers" onClick={p.onClose}>×</button>
        </header>
      )}
      <div className="ans-bar">
        <div className="ans-tabs" role="tablist" aria-label="Who started it">
          {(["you", "agents"] as const).map((t) => {
            const n = searching ? foundCounts[t] : unreadCounts[t];
            return (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => switchTab(t)}>
                {TAB_NAME[t]}{n ? <> <span className={"ans-tab-count" + (searching ? " found" : "")}>{n}</span></> : null}
              </button>
            );
          })}
        </div>
        {search}
        {inSession && p.onToggleSide && <SideToggle side={false} onToggle={p.onToggleSide} />}
        <span className="ans-bar-break" />
        {!searching && (
          <div className="ans-seg" role="radiogroup" aria-label="Which answers">
            {VIEWS.map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => switchView(v)}>{label}</button>
            ))}
          </div>
        )}
        {searching && <span className="ans-found">{inTab.length} {inTab.length === 1 ? "match" : "matches"}, the archive included</span>}
        <span className="place-spacer" />
        {!searching && view !== "archived" && inboxUnread.length > 0 && <button type="button" className="ans-readall" onClick={() => markRead(inboxUnread.map((a) => a.id))}>Mark all read</button>}
        {!searching && view === "inbox" && inboxRead.length > 0 && (
          <button type="button" className="ans-readall" title="Archive every read answer on this tab" onClick={() => archive(inboxRead)}>Archive read ({inboxRead.length})</button>
        )}
      </div>
      <div className={"ans-split" + (narrow ? (reading && current ? " reading" : " listing") : "")}>
        {(!narrow || !reading || !current) && listPane}
        {(!narrow || (reading && current)) && readerPane}
      </div>
    </div>
  );
};
