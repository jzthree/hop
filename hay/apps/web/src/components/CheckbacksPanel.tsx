import { useEffect, useRef, useState } from "react";
import { addDays, rruleOccurrences, startOfDay, triggerOccurrences, weekDays } from "../utils/calendar";
import {
  chipWhen, conditionLabel, dayHeading, describeRrule, describeState, describeTrigger, isTimed,
  nextOfTrigger, orderForAll, orderForSession, relative, timeOfDay, type Checkback, type CodexAutomation
} from "../utils/checkbackText";

// A session's CALENDAR: a week, day by day, with everything timed on it —
// hop's check-backs and the Codex automations aimed at the same
// conversation, a repeat on every day it runs (a frequent one as a band,
// "every 30m", rather than a column of times), and what was sent on the
// days it went. Picking an entry reads it in full below the week. The ones
// waiting on something rather than a time (a job, a file, idle) have no
// day: they are listed under the week. hop's own can be cancelled here;
// scheduling stays with `hop checkback` and the agent's MCP tool, and
// Codex's automations with Codex.

// session "*" is every session at once: the same list, each row naming
// whose it is, the session's name opening it.
export const ALL_CHECKBACKS = "*";

type Props = {
  session: string;
  sessionName: string;
  onClose: () => void;
  // The wall's chip count comes from the session list; a cancel here should
  // show there without waiting for the next poll.
  onChanged?: () => void;
  onOpenSession?: (internalName: string) => void;
  // "tab": a session's Scheduled tab, under its header (no backdrop);
  // otherwise the centred window.
  placement?: "modal" | "tab";
};

// One entry on one day: at a time, or a band (at null) across the day.
type Entry =
  | { key: string; source: "hop"; at: number | null; every?: number; cb: Checkback; past: boolean }
  | { key: string; source: "codex"; at: number | null; every?: number; auto: CodexAutomation; rule: string; past: boolean };

const every = (ms: number) => ms % 3_600_000 === 0 ? `every ${ms / 3_600_000}h` : `every ${Math.round(ms / 60_000)}m`;

export const CheckbacksPanel = ({ session, sessionName, onClose, onChanged, onOpenSession, placement = "modal" }: Props) => {
  const asTab = placement === "tab";
  // A tab takes the keyboard once, as it opens (Esc goes back).
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (asTab) panelRef.current?.focus(); }, [asTab]);
  const all = session === ALL_CHECKBACKS;
  const [items, setItems] = useState<Checkback[] | null>(null);
  const [automations, setAutomations] = useState<CodexAutomation[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // The week shown starts here (local midnight); today by default.
  const [weekStart, setWeekStart] = useState(() => startOfDay(Date.now()));
  // The entry being read below the week.
  const [picked, setPicked] = useState<string | null>(null);
  const now = Date.now();

  const load = () => {
    fetch(all ? "/api/checkbacks" : `/api/checkbacks?session=${encodeURIComponent(session)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        setItems(Array.isArray(d?.items) ? d.items : []);
        setAutomations(Array.isArray(d?.automations) ? d.automations : []);
        setFailed(false);
      })
      .catch(() => { setFailed(true); setItems([]); });
  };
  useEffect(() => { load(); }, [session]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (picked) setPicked(null); else onClose(); return; }
      // ← → a week back / on, t today — from inside the calendar only.
      if (!panelRef.current?.contains(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWeekStart((w) => addDays(w, e.key === "ArrowLeft" ? -7 : 7)); }
      else if (e.key === "t") setWeekStart(startOfDay(Date.now()));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, picked]);

  const cancel = async (id: string) => {
    setBusy(id);
    try {
      await fetch("/api/checkbacks/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    } finally {
      setBusy(null);
      load();
      onChanged?.();
    }
  };

  const rows = items ? (all ? orderForAll(items) : orderForSession(items, session)) : [];
  const pending = rows.filter((c) => c.status === "pending");
  const past = rows.filter((c) => c.status !== "pending").slice(0, 12);
  // A one-shot Codex automation whose time has passed is not upcoming:
  // Codex keeps it ACTIVE whether or not it ran (some never arrive), so it
  // folds away under "Past due" instead of heading the list as "Overdue".
  const autoTimes = automations.map((auto) => ({ auto, r: describeRrule(auto.rrule, now) }));
  const isPastDue = (r: { next: number | null }, rule: string) => /COUNT=1/.test(rule) && r.next !== null && r.next < now;
  const activeAutos = autoTimes.filter(({ auto, r }) => auto.status === "ACTIVE" && !isPastDue(r, auto.rrule)).map(({ auto }) => auto);
  const pastDueAutos = autoTimes.filter(({ auto, r }) => auto.status === "ACTIVE" && isPastDue(r, auto.rrule));
  const pausedAutos = automations.filter((a) => a.status !== "ACTIVE");

  // The week: each day's entries, hop's and Codex's together, in time
  // order with bands first. Sent ones sit on the day they went; one due
  // but not yet typed (the agent was busy) stays on today until it goes.
  const today = startOfDay(now);
  const timedPending = pending.filter((c) => isTimed(c.trigger));
  const sent = rows.filter((c) => c.status === "delivered");
  const week = weekDays(weekStart).map((day) => {
    const from = day, to = addDays(day, 1);
    const list: Entry[] = [];
    for (const cb of timedPending) {
      const o = triggerOccurrences(cb.trigger, from, to);
      if (o.band) list.push({ key: `${cb.id}~${day}`, source: "hop", at: null, every: o.band, cb, past: false });
      for (const at of o.times) list.push({ key: `${cb.id}@${at}`, source: "hop", at, cb, past: false });
      const due = nextOfTrigger(cb.trigger);
      if (day === today && cb.trigger.kind === "at" && due !== null && due < today) list.push({ key: `${cb.id}@due`, source: "hop", at: due, cb, past: false });
    }
    for (const auto of activeAutos.concat(pastDueAutos.map(({ auto }) => auto))) {
      const o = rruleOccurrences(auto.rrule, from, to);
      const rule = describeRrule(auto.rrule, now).label;
      if (o.band) list.push({ key: `${auto.id}~${day}`, source: "codex", at: null, every: o.band, auto, rule, past: false });
      for (const at of o.times) list.push({ key: `${auto.id}@${at}`, source: "codex", at, auto, rule, past: at < now });
    }
    for (const cb of sent) {
      const at = cb.deliveredAt ?? cb.firedAt ?? nextOfTrigger(cb.trigger);
      if (at && at >= from && at < to) list.push({ key: `${cb.id}@sent`, source: "hop", at, cb, past: true });
    }
    list.sort((a, b) => (a.at ?? -1) - (b.at ?? -1));
    return { day, list };
  });
  const pickedEntry = picked ? week.flatMap((d) => d.list).find((e) => e.key === picked) ?? null : null;
  const waiting = pending.filter((c) => !isTimed(c.trigger));
  const nothing = timedPending.length === 0 && waiting.length === 0 && activeAutos.length === 0;
  const rangeLabel = (() => {
    const a = new Date(weekStart), b = new Date(addDays(weekStart, 6));
    const md = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });
    return a.getMonth() === b.getMonth() ? `${md(a)} – ${b.getDate()}` : `${md(a)} – ${md(b)}`;
  })();

  const message = (key: string, text: string) => (
    <div className={"sched-message" + (open === key ? " open" : "")}
         onClick={() => setOpen((o) => (o === key ? null : key))}
         title={open === key ? "" : "Click to read it all"}>{text}</div>
  );
  const who = (c: Checkback) => (c.createdBy === "agent" ? "the agent" : "you");
  // In the all-sessions list, whose it is — and the way there.
  const whose = (c: Checkback) => all ? (
    <button type="button" className="sched-session" onClick={() => onOpenSession?.(c.session)}>{c.sessionName || c.session}</button>
  ) : null;

  return (
    <>
      {!asTab && <div className="views-backdrop" onClick={onClose} />}
      <div className={"views-panel checkbacks-panel" + (asTab ? " page in-session" : "")} role={asTab ? "tabpanel" : "dialog"}
           aria-label={`Calendar for ${sessionName}`} tabIndex={-1}
           ref={panelRef}>
        <div className="views-head">
          <span className="views-badge">Calendar</span>
          {!asTab && <span className="checkbacks-session">{all ? "all sessions" : sessionName}</span>}
          <span className="cal-nav">
            <button type="button" aria-label="Previous week" title="Previous week (←)" onClick={() => setWeekStart((w) => addDays(w, -7))}>‹</button>
            <button type="button" className="cal-today" disabled={weekStart === today} title="This week (t)" onClick={() => setWeekStart(today)}>Today</button>
            <button type="button" aria-label="Next week" title="Next week (→)" onClick={() => setWeekStart((w) => addDays(w, 7))}>›</button>
            <span className="cal-range">{rangeLabel}</span>
          </span>
          <span className="views-head-spacer" />
          <button type="button" className="views-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {items === null ? (
          <p className="checkbacks-empty">Loading…</p>
        ) : failed ? (
          <p className="checkbacks-empty">Could not load what is scheduled.</p>
        ) : (
          <div className="checkbacks-list">
            {nothing && <p className="checkbacks-empty">{all ? "Nothing scheduled." : "Nothing scheduled on this session."}</p>}

            <div className="cal-week" role="grid" aria-label={`Week of ${rangeLabel}`}>
              {week.map(({ day, list }) => {
                const d = new Date(day);
                return (
                  <div key={day} role="gridcell" className={"cal-day" + (day === today ? " today" : "") + (day < today ? " before" : "")}>
                    <div className="cal-day-head">
                      <span className="cal-dow">{d.toLocaleDateString([], { weekday: "short" })}</span>
                      <span className="cal-date">{d.getDate()}</span>
                    </div>
                    {list.map((e) => (
                      <button key={e.key} type="button"
                              className={"cal-entry " + e.source + (e.at === null ? " band" : "") + (e.past ? " past" : "") + (picked === e.key ? " on" : "")}
                              onClick={() => setPicked((p) => (p === e.key ? null : e.key))}>
                        <span className="cal-when">
                          {e.at === null ? every(e.every!) : timeOfDay(e.at)}
                          {all && e.source === "hop" ? <span className="cal-who"> · {e.cb.sessionName || e.cb.session}</span> : null}
                        </span>
                        <span className="cal-what">{e.source === "hop" ? e.cb.message.split("\n")[0] : e.auto.name}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>

            {pickedEntry && (pickedEntry.source === "hop" ? (
              <div className={"sched-row cal-detail" + (pickedEntry.past ? " past" : "") + (pickedEntry.cb.firedAt && !pickedEntry.past ? " fired" : "")}>
                <div className="sched-time">{pickedEntry.at === null ? every(pickedEntry.every!) : timeOfDay(pickedEntry.at)}</div>
                <div className="sched-body">
                  {whose(pickedEntry.cb)}
                  <div className="sched-message open">{pickedEntry.cb.message}</div>
                  <div className="sched-meta">
                    {pickedEntry.past ? describeState(pickedEntry.cb, now)
                      : <>{pickedEntry.cb.trigger.kind === "every" ? describeTrigger(pickedEntry.cb.trigger, now) : chipWhen(nextOfTrigger(pickedEntry.cb.trigger) ?? now, now)}
                          {pickedEntry.cb.firedAt ? " · due, waiting for the agent to be idle" : ""}
                          {pickedEntry.cb.force ? " · typed even mid-turn" : ""} · by {who(pickedEntry.cb)}</>}
                  </div>
                </div>
                {!pickedEntry.past && (
                  <button type="button" className="checkback-cancel" disabled={busy === pickedEntry.cb.id}
                          onClick={() => { setPicked(null); void cancel(pickedEntry.cb.id); }}>Cancel</button>
                )}
              </div>
            ) : (
              <div className="sched-row codex cal-detail">
                <div className="sched-time">{pickedEntry.at === null ? every(pickedEntry.every!) : timeOfDay(pickedEntry.at)}</div>
                <div className="sched-body">
                  <div className="sched-title">{pickedEntry.auto.name}</div>
                  <div className="sched-message open">{pickedEntry.auto.prompt}</div>
                  <div className="sched-meta">Codex automation · {pickedEntry.rule}{pickedEntry.past ? " · past" : ""}</div>
                </div>
                <span className="sched-owner" title="Codex runs this one; manage it in Codex">Codex</span>
              </div>
            ))}

            {waiting.length > 0 && (
              <section className="sched-day">
                <div className="sched-day-head">When something happens — no day of its own</div>
                {waiting.map((c) => {
                  const cond = conditionLabel(c.trigger);
                  return (
                    <div key={c.id} className={"sched-row" + (c.firedAt ? " fired" : "")}>
                      <div className="sched-time tag">{cond.tag}</div>
                      <div className="sched-body">
                        {whose(c)}
                        {message(c.id, c.message)}
                        <div className="sched-meta">
                          <code className="sched-cond" title={cond.detail}>{cond.detail}</code>
                        </div>
                        <div className="sched-meta">
                          {c.firedAt ? "happened · waiting for the agent to be idle" : c.trigger.kind === "cmd" ? describeTrigger(c.trigger, now).replace(/^when `.*` succeeds · /, "") : "watching"}
                          {c.lastError && !c.firedAt ? ` · ${c.lastError}` : ""} · by {who(c)}
                        </div>
                      </div>
                      <button type="button" className="checkback-cancel" disabled={busy === c.id} onClick={() => cancel(c.id)}>Cancel</button>
                    </div>
                  );
                })}
              </section>
            )}

            {pastDueAutos.length > 0 && (
              <details className="sched-fold">
                <summary>Past due Codex automations ({pastDueAutos.length})</summary>
                <p className="checkbacks-hint">Codex still lists these as active, but a one-shot follow-up is not always delivered — check the session before counting on it.</p>
                {pastDueAutos.map(({ auto, r }) => (
                  <div key={auto.id} className="sched-row codex past">
                    <div className="sched-time tag">was due</div>
                    <div className="sched-body">
                      <div className="sched-title">{auto.name}</div>
                      <div className="sched-meta">{r.next ? `${dayHeading(r.next, now) === "Due now" ? new Date(r.next).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : timeOfDay(r.next)} · ${relative(r.next, now)}` : r.label}</div>
                    </div>
                  </div>
                ))}
              </details>
            )}

            {pausedAutos.length > 0 && (
              <details className="sched-fold">
                <summary>Paused Codex automations ({pausedAutos.length})</summary>
                {pausedAutos.map((a) => (
                  <div key={a.id} className="sched-row codex past">
                    <div className="sched-time tag">paused</div>
                    <div className="sched-body">
                      <div className="sched-title">{a.name}</div>
                      <div className="sched-meta">{describeRrule(a.rrule, now).label}</div>
                    </div>
                  </div>
                ))}
              </details>
            )}

            {past.length > 0 && (
              <details className="sched-fold">
                <summary>Recent ({past.length})</summary>
                {past.map((c) => (
                  <div key={c.id} className={"sched-row past " + c.status}>
                    <div className="sched-time tag">{c.status === "delivered" ? "sent" : "cancelled"}</div>
                    <div className="sched-body">
                      {whose(c)}
                      {message(c.id, c.message)}
                      <div className="sched-meta">{describeState(c, now)}</div>
                    </div>
                  </div>
                ))}
              </details>
            )}

            <p className="checkbacks-hint">
              hop types these into the session when they come due and the agent is idle. Schedule with <code>hop checkback</code> or
              the agent's <code>hop_checkback</code> tool; Codex automations are run by Codex.
            </p>
          </div>
        )}
      </div>
    </>
  );
};
