// Words for a check-back's trigger and state, as the daemon stores them
// (lib/checkbacks.js). Shared by the wall's check-back window.

export type CheckbackTrigger =
  | { kind: "at"; at: number }
  | { kind: "every"; everyMs: number; next: number; until?: number | null }
  | { kind: "idle"; afterMs?: number }
  | { kind: "file"; path: string; baselineMtime?: number | null }
  | { kind: "cmd"; command: string; everyMs?: number };

export type Checkback = {
  id: string;
  session: string;
  sessionName?: string;
  message: string;
  trigger: CheckbackTrigger;
  force?: boolean;
  createdBy?: string;
  createdAt?: number;
  status: "pending" | "delivered" | "cancelled";
  firedAt?: number | null;
  deliveredAt?: number | null;
  cancelledAt?: number | null;
  deliveries?: number;
  lastError?: string | null;
};

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** "in 12m", "in 2.5h", "3m ago" — the distance from now, in the coarsest unit that reads. */
export const relative = (ms: number, now: number): string => {
  const d = ms - now;
  const a = Math.abs(d);
  const s = a < MIN ? `${Math.max(1, Math.round(a / 1000))}s` : a < HOUR ? `${Math.round(a / MIN)}m` : a < DAY ? `${(a / HOUR).toFixed(a < 10 * HOUR ? 1 : 0)}h` : `${(a / DAY).toFixed(1)}d`;
  return d >= 0 ? `in ${s}` : `${s} ago`;
};

const clock = (ms: number): string => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return today ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
};

const period = (ms: number): string => (ms >= HOUR && ms % HOUR === 0 ? `${ms / HOUR}h` : ms >= HOUR ? `${(ms / HOUR).toFixed(1)}h` : `${Math.round(ms / MIN)}m`);

/** One line saying WHEN it fires, in the reader's words. */
export const describeTrigger = (t: CheckbackTrigger, now: number): string => {
  switch (t.kind) {
    case "at": return `at ${clock(t.at)} (${relative(t.at, now)})`;
    case "every": return `every ${period(t.everyMs)} · next ${relative(t.next, now)}${t.until ? ` · until ${clock(t.until)}` : ""}`;
    case "idle": return t.afterMs ? `when idle for ${period(t.afterMs)}` : "when the agent is next idle";
    case "file": return `when ${t.path} ${t.baselineMtime ? "changes" : "exists"}`;
    case "cmd": return `when \`${t.command}\` succeeds · checked every ${period(t.everyMs || MIN)}`;
    default: return "";
  }
};

/** The state line: waiting, fired and waiting for idle, delivered, cancelled. */
export const describeState = (cb: Checkback, now: number): string => {
  if (cb.status === "pending") return cb.firedAt ? "fired · waiting for the agent to be idle" : "waiting";
  if (cb.status === "delivered") return `typed ${cb.deliveredAt ? relative(cb.deliveredAt, now) : ""}`.trim();
  return `cancelled${cb.cancelledAt ? ` ${relative(cb.cancelledAt, now)}` : ""}`;
};

/** Pending first (soonest first), then the recent rest, newest first. */
export const orderForSession = (items: Checkback[], session: string): Checkback[] => {
  const mine = items.filter((c) => c.session === session);
  const nextOf = (c: Checkback) => (c.trigger.kind === "at" ? c.trigger.at : c.trigger.kind === "every" ? c.trigger.next : Number.MAX_SAFE_INTEGER);
  const pending = mine.filter((c) => c.status === "pending").sort((a, b) => nextOf(a) - nextOf(b));
  const done = mine.filter((c) => c.status !== "pending").sort((a, b) => ((b.deliveredAt || b.cancelledAt || b.createdAt || 0) - (a.deliveredAt || a.cancelledAt || a.createdAt || 0)));
  return [...pending, ...done];
};

// Codex's own scheduled jobs ("automations"), as the daemon reads them from
// ~/.codex/automations for the thread a session runs. Codex runs them; hop
// only shows them beside its own.
export type CodexAutomation = {
  id: string;
  name: string;
  kind: string;
  status: string;
  prompt: string;
  rrule: string;
  thread: string;
  updatedAt?: number | null;
};

const PERIOD_MS: Record<string, number> = { MINUTELY: MIN, HOURLY: HOUR, DAILY: DAY, WEEKLY: 7 * DAY };

const parseDtstart = (v: string): number | null => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  return z
    ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
    : new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
};

/** An RRULE (with optional DTSTART) as words, and its next run when that can be known. */
export const describeRrule = (rrule: string, now: number): { label: string; next: number | null } => {
  let start: number | null = null;
  const parts: Record<string, string> = {};
  for (const line of rrule.split(/\r?\n/)) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":");
    if (key === "DTSTART") start = parseDtstart(value);
    else for (const kv of (key === "RRULE" ? value : line).split(";")) {
      const [k, v] = kv.split("=");
      if (k && v !== undefined) parts[k.trim()] = v.trim();
    }
  }
  const freq = parts.FREQ || "";
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const count = Number(parts.COUNT) || 0;
  if (count === 1 && start !== null) return { label: `at ${clock(start)}`, next: start };
  const step = PERIOD_MS[freq] ? PERIOD_MS[freq] * interval : 0;
  if (parts.BYHOUR !== undefined && (freq === "DAILY" || freq === "WEEKLY")) {
    // Floating local times, one or more hours a day.
    const hours = parts.BYHOUR.split(",").map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const minute = Number(parts.BYMINUTE) || 0;
    let next: number | null = null;
    for (let dayOffset = 0; dayOffset < 2 && next === null; dayOffset++) {
      for (const h of hours) {
        const d = new Date(now);
        d.setDate(d.getDate() + dayOffset);
        d.setHours(h, minute, 0, 0);
        if (d.getTime() > now) { next = d.getTime(); break; }
      }
    }
    const mm = String(minute).padStart(2, "0");
    const label = hours.length > 3 ? `${hours.length}× a day` : `daily at ${hours.map((h) => `${h}:${mm}`).join(", ")}`;
    return { label, next };
  }
  if (step) {
    const label = `every ${period(step)}`;
    if (start === null) return { label, next: null };
    const k = now <= start ? 0 : Math.ceil((now - start) / step);
    return { label, next: start + k * step };
  }
  return { label: freq ? freq.toLowerCase() : "scheduled", next: start };
};

/** "Today" / "Tomorrow" / "Mon, Oct 19" — the day heading a time sits under. */
export const dayHeading = (ms: number, now: number): string => {
  const startOf = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((startOf(ms) - startOf(now)) / DAY);
  if (days < 0) return "Overdue";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
};

/** The clock time alone ("4:30 PM"), for the left column of a day's list. */
export const timeOfDay = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Short words for the chip: "in 12m" under an hour, else the clock time (with the day when not today). */
export const chipWhen = (ms: number, now: number): string =>
  ms - now < HOUR && ms > now ? relative(ms, now) : clock(ms);

/** A condition trigger in a few words, for the "when something happens" list. */
export const conditionLabel = (t: CheckbackTrigger): { tag: string; detail: string } => {
  switch (t.kind) {
    case "cmd": return { tag: "on check", detail: t.command };
    case "file": return { tag: t.baselineMtime ? "on change" : "on file", detail: t.path };
    case "idle": return { tag: "on idle", detail: t.afterMs ? `after ${period(t.afterMs)} idle` : "the next time the agent is idle" };
    default: return { tag: "", detail: "" };
  }
};

export const isTimed = (t: CheckbackTrigger) => t.kind === "at" || t.kind === "every";
export const nextOfTrigger = (t: CheckbackTrigger): number | null =>
  t.kind === "at" ? t.at : t.kind === "every" ? t.next : null;
