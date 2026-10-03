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
