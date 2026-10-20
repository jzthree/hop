import { useEffect, useState } from "react";
import {
  chipWhen, conditionLabel, dayHeading, describeRrule, describeState, describeTrigger, isTimed,
  nextOfTrigger, orderForAll, orderForSession, relative, timeOfDay, type Checkback, type CodexAutomation
} from "../utils/checkbackText";

// What is scheduled on a session, read like a reminders list: the timed ones
// under their day, the ones waiting on something (a job, a file, idle) in a
// list of their own, the Codex automations aimed at the same conversation
// beside hop's, and the recent past folded away. Opened from a card's chip.
// hop's own can be cancelled here; scheduling stays with `hop checkback` and
// the agent's MCP tool, and Codex's automations with Codex.

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
};

type Timed =
  | { source: "hop"; at: number; cb: Checkback }
  | { source: "codex"; at: number; auto: CodexAutomation; rule: string };

export const CheckbacksPanel = ({ session, sessionName, onClose, onChanged, onOpenSession }: Props) => {
  const all = session === ALL_CHECKBACKS;
  const [items, setItems] = useState<Checkback[] | null>(null);
  const [automations, setAutomations] = useState<CodexAutomation[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

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

  // Everything with a clock time, hop's and Codex's together, soonest first.
  const timed: Timed[] = [
    ...pending.filter((c) => isTimed(c.trigger)).map((cb) => ({ source: "hop" as const, at: nextOfTrigger(cb.trigger) ?? now, cb })),
    ...activeAutos.map((auto) => { const r = describeRrule(auto.rrule, now); return { source: "codex" as const, at: r.next ?? Number.MAX_SAFE_INTEGER, auto, rule: r.label }; })
  ].sort((a, b) => a.at - b.at);
  const days: Array<[string, Timed[]]> = [];
  for (const t of timed) {
    const head = t.at === Number.MAX_SAFE_INTEGER ? "Repeating" : dayHeading(t.at, now);
    const last = days[days.length - 1];
    if (last && last[0] === head) last[1].push(t); else days.push([head, [t]]);
  }
  const waiting = pending.filter((c) => !isTimed(c.trigger));
  const nothing = timed.length === 0 && waiting.length === 0;

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
      <div className="views-backdrop" onClick={onClose} />
      <div className="views-panel checkbacks-panel" role="dialog" aria-label={`Scheduled for ${sessionName}`}>
        <div className="views-head">
          <span className="views-badge">Scheduled</span>
          <span className="checkbacks-session">{all ? "all sessions" : sessionName}</span>
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

            {days.map(([head, list]) => (
              <section key={head} className="sched-day">
                <div className="sched-day-head">{head}</div>
                {list.map((t) => t.source === "hop" ? (
                  <div key={t.cb.id} className={"sched-row" + (t.cb.firedAt ? " fired" : "")}>
                    <div className="sched-time">{t.at === Number.MAX_SAFE_INTEGER ? "—" : timeOfDay(t.at)}</div>
                    <div className="sched-body">
                      {whose(t.cb)}
                      {message(t.cb.id, t.cb.message)}
                      <div className="sched-meta">
                        {t.cb.trigger.kind === "every" ? describeTrigger(t.cb.trigger, now) : chipWhen(t.at, now)}
                        {t.cb.firedAt ? " · due, waiting for the agent to be idle" : ""}
                        {t.cb.force ? " · typed even mid-turn" : ""} · by {who(t.cb)}
                      </div>
                    </div>
                    <button type="button" className="checkback-cancel" disabled={busy === t.cb.id} onClick={() => cancel(t.cb.id)}>Cancel</button>
                  </div>
                ) : (
                  <div key={"codex-" + t.auto.id} className="sched-row codex">
                    <div className="sched-time">{t.at === Number.MAX_SAFE_INTEGER ? "—" : timeOfDay(t.at)}</div>
                    <div className="sched-body">
                      <div className="sched-title">{t.auto.name}</div>
                      {message("codex-" + t.auto.id, t.auto.prompt)}
                      <div className="sched-meta">Codex automation · {t.rule}{t.at !== Number.MAX_SAFE_INTEGER && t.at < now ? " · past due" : ""}</div>
                    </div>
                    <span className="sched-owner" title="Codex runs this one; manage it in Codex">Codex</span>
                  </div>
                ))}
              </section>
            ))}

            {waiting.length > 0 && (
              <section className="sched-day">
                <div className="sched-day-head">When something happens</div>
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
