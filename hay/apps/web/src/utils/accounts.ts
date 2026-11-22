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

// ---- Signing accounts in (Settings → Agent accounts → Sign in to accounts) ----

export const AGENT_TITLE: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity" };

/** A sign-in the host is running: the agent's own CLI, in a terminal of the daemon's. */
export type SignInJob = {
  id: string; agent: AgentKind; dir: string; label: string; startedAt: number;
  state: "running" | "done" | "failed" | "cancelled";
  /** The link to sign in at, once the CLI has printed it. */
  url: string | null;
  /** The CLI is asking for the code a sign-in page shows. */
  wantsCode: boolean;
  /** Its last lines, for anyone who wants to see what it says. */
  lines: string[];
  email: string | null;
  /** Another folder of the same agent holds this same login. */
  duplicateOf: string | null;
  message: string | null; endedAt: number | null;
};

/** Where a sign-in stands, in one line. */
export const signInStatus = (job: SignInJob): string => {
  if (job.state === "done") {
    const who = job.email ? `Signed in as ${job.email}` : "Signed in";
    return job.duplicateOf ? `${who} — the same login as ${job.duplicateOf}` : who;
  }
  if (job.state === "failed") return job.message || "The sign-in did not finish";
  if (job.state === "cancelled") return "Cancelled";
  if (job.wantsCode) {
    // Antigravity always hands back a code; Claude's page only when it cannot reach this Mac.
    if (job.agent === "antigravity") return "Waiting for the code Google shows: paste it below";
    if (job.agent === "claude") return "Finish in the browser, or paste the code the page shows below";
    return "Paste the code the sign-in page shows below";
  }
  if (job.url) return "Waiting for you to finish in the browser";
  return "Starting the sign-in…";
};

/** How many accounts are signed in, of how many. An account not yet read counts as not signed in. */
export const setupProgress = (agents: Partial<Record<AgentKind, Account[]>>): { signedIn: number; total: number } => {
  const all = Object.values(agents).flat().filter(Boolean) as Account[];
  return { signedIn: all.filter((a) => a.login?.loggedIn === true).length, total: all.length };
};

/** Folders of one agent signed in to the same login as another: dir → the other's name. */
export const sameLogins = (list: Account[]): Map<string, string> => {
  const out = new Map<string, string>();
  list.forEach((a, i) => {
    const email = a.login?.loggedIn ? a.login.email?.toLowerCase() : null;
    if (!email) return;
    const first = list.findIndex((b) => b.login?.loggedIn && b.login.email?.toLowerCase() === email);
    if (first !== i) out.set(a.dir, list[first].isDefault ? "default" : list[first].label);
  });
  return out;
};

/** What the host makes of a typed account name ("Work 2" → "work-2"); "" when nothing usable is left. */
export const accountSlug = (raw: string): string => {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return s === "default" ? "" : s;
};

/** The folder a new account gets: "~/.codex_work", "~/.gemini_work". */
export const accountFolder = (agent: AgentKind, slug: string): string =>
  `~/.${agent === "antigravity" ? "gemini" : agent}_${slug}`;
