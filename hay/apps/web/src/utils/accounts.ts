// The Accounts page's words: who an account is, how full a limit is and when
// it resets, and what the rotation is waiting for. Pure, so it is tested
// without the page.

export type AgentKind = "claude" | "codex" | "antigravity";
export type UsageMeter = {
  id: string; label: string; window: string; percent: number; resetsAt: number | null;
  model?: string | null; models?: string[] | null; idle?: boolean;
};
export type AccountUsage = { plan?: string | null; available?: boolean; meters: UsageMeter[]; resets?: number | null };
export type Account = {
  agent: AgentKind; dir: string; label: string; isDefault: boolean;
  login: { loggedIn: boolean; email: string | null } | null;
  plan: string | null; usage: AccountUsage | null; usageAt: number | null;
  /** Whether a stopped session may be moved here; null where there is no rotation. */
  pooled: boolean | null;
  sessions: number;
};
export type AccountWaiting = { session: string; name: string; agent: string; reason: string; until: number | null };
export type AccountAction = { at: number; kind: "move" | "resume"; name: string; agent: string; from: string; to: string; why: string | null };
export type AccountsOverview = {
  autoSwitch: boolean;
  agents: Record<AgentKind, Account[]>;
  waiting: AccountWaiting[];
  actions: AccountAction[];
};

/** "max_20x" → "Max 20x", "pro" → "Pro". */
export const planName = (plan?: string | null): string =>
  (plan || "").split(/[_\s]+/).filter(Boolean).map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");

/** Who an account is: "a@b.org · Max 20x", "Signed out", or what is known. */
export const accountLine = (a: Account): string => {
  if (a.login && !a.login.loggedIn) return "Signed out";
  return [a.login?.email, planName(a.plan)].filter(Boolean).join(" · ");
};

/** A clock time today, a weekday and time this week, a date beyond. */
export const resetTime = (at: number, now: number): string => {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at - now < 20 * 3600_000 && d.toDateString() === new Date(now).toDateString()) return time;
  if (at - now < 6 * 86400_000) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Beside a meter's bar: "42% · resets 3:10 PM", "not started", "100% · resets Thu 4:00 PM". */
export const meterNote = (m: UsageMeter, now: number): string => {
  if (m.idle) return "not started";
  // A window that has already reset is empty until something is spent in it.
  if (m.resetsAt !== null && m.resetsAt <= now) return "0% · reset";
  const pct = `${Math.min(100, Math.round(m.percent))}%`;
  return m.resetsAt ? `${pct} · resets ${resetTime(m.resetsAt, now)}` : pct;
};

/** What the rotation is waiting for, in one line; "" when nothing waits. */
export const waitingLine = (waiting: AccountWaiting[], now: number): string => {
  if (!waiting.length) return "";
  const n = waiting.length;
  const who = n === 1 ? `${waiting[0].name} is` : `${n} sessions are`;
  const untils = waiting.map((w) => w.until || 0).filter((t) => t > now);
  const first = untils.length ? Math.min(...untils) : 0;
  return `${who} stopped at a limit with no account to move to${first ? ` — the first limit resets ${resetTime(first, now)}` : ""}.`;
};

/** For a menu that lists accounts: " · 5-hour 42% · Week 12%" from a reading hop already has. */
export const usageHint = (usage: AccountUsage | null | undefined, now: number): string => {
  const meters = (usage?.meters || []).filter((m) => !m.idle && (m.resetsAt === null || m.resetsAt > now));
  if (!meters.length) return "";
  // The account-wide limits, and any scoped one that is nearly spent.
  const shown = meters.filter((m) => (!m.model && !m.models) || m.percent >= 80).slice(0, 3);
  return shown.map((m) => `${m.label} ${Math.min(100, Math.round(m.percent))}%`).join(" · ");
};
