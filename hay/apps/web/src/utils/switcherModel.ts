// Tiered model for the mobile session switcher. Pure data shaping so it can be
// unit-tested without the DOM: the component just renders what this returns.
//
// Tier logic: sessions that *want you* (unseen bell, then unread output) plus
// the current session and the most recent ones become full preview cards; the
// long tail becomes compact rows auto-grouped by project directory. A filter
// query collapses everything into one flat ranked list.

export type SwitcherSession = {
  name: string;
  displayName: string;
  active: boolean;
  starting: boolean;
  type?: "terminal" | "port";
  port?: number;
  cwd?: string;
  internalName?: string;
  lastActivityAt?: number;
  bellSeq?: number;
  unread?: boolean;
  bellUnseen?: boolean;
  foregroundProcess?: string;
  agentPermitted?: boolean;
};

export type SwitcherGroup = {
  label: string;
  rows: SwitcherSession[];
};

export type SwitcherModel =
  | { mode: "tiers"; hero: SwitcherSession[]; groups: SwitcherGroup[]; currentInHero: boolean }
  | { mode: "filter"; rows: SwitcherSession[] };

// Minimum hero-card count (including the current session). All attention
// sessions are always hero cards — attention must never be buried in the tail.
const HERO_MIN = 4;

const sessionKey = (s: SwitcherSession) => s.internalName || s.name;

const isCurrent = (s: SwitcherSession, currentRoom: string | null) =>
  currentRoom !== null && (s.internalName === currentRoom || s.name === currentRoom);

const activity = (s: SwitcherSession) => s.lastActivityAt || 0;

// Attention-first, then recency. Bells outrank unread output.
const attentionRank = (s: SwitcherSession) => (s.bellUnseen ? 2 : s.unread ? 1 : 0);

const byAttentionThenRecency = (a: SwitcherSession, b: SwitcherSession) => {
  const rank = attentionRank(b) - attentionRank(a);
  if (rank !== 0) return rank;
  return activity(b) - activity(a);
};

/** Shorten a path for grouping/display: home dir becomes ~. */
const shortenForGroup = (cwdPath: string) => {
  const homeMatch = cwdPath.match(/^(\/(?:Users|home)\/[^/]+)(\/.*)?$/);
  if (homeMatch) return "~" + (homeMatch[2] || "");
  if (cwdPath === "/root") return "~";
  if (cwdPath.startsWith("/root/")) return "~" + cwdPath.slice(5);
  return cwdPath;
};

/**
 * Project key for auto-grouping: first three path segments of the shortened
 * cwd ("~/Code/hop2"), so sessions in a project root and its subdirectories
 * land in the same group without any manual folder management.
 */
export const projectKey = (cwd?: string) => {
  if (!cwd) return "Other";
  const shortened = shortenForGroup(cwd);
  const lead = shortened.startsWith("~") ? "~" : "";
  const parts = shortened.replace(/^~\/?/, "").split("/").filter(Boolean);
  const kept = parts.slice(0, lead ? 2 : 3);
  if (kept.length === 0) return lead || "/";
  return (lead ? lead + "/" : "/") + kept.join("/");
};

const matchesFilter = (s: SwitcherSession, query: string) => {
  const q = query.toLowerCase();
  return (
    (s.displayName || s.name).toLowerCase().includes(q) ||
    (s.cwd || "").toLowerCase().includes(q) ||
    (s.foregroundProcess || "").toLowerCase().includes(q)
  );
};

export const buildSwitcherModel = (
  sessions: SwitcherSession[],
  currentRoom: string | null,
  filter: string
): SwitcherModel => {
  const query = filter.trim();
  if (query) {
    const rows = sessions.filter((s) => matchesFilter(s, query)).sort(byAttentionThenRecency);
    return { mode: "filter", rows };
  }

  const current = sessions.find((s) => isCurrent(s, currentRoom)) ?? null;
  const heroKeys = new Set<string>();
  const hero: SwitcherSession[] = [];
  const pushHero = (s: SwitcherSession) => {
    const key = sessionKey(s);
    if (heroKeys.has(key)) return;
    heroKeys.add(key);
    hero.push(s);
  };

  if (current) pushHero(current);
  // Every attention session is a hero card, bells first.
  sessions
    .filter((s) => (s.bellUnseen || s.unread) && !isCurrent(s, currentRoom))
    .sort(byAttentionThenRecency)
    .forEach(pushHero);
  // Fill with the most recent live terminal sessions up to the minimum. Port
  // sessions never fill hero slots — they have no screen to preview and no
  // bells to ring.
  sessions
    .filter((s) => s.type !== "port" && (s.active || s.starting))
    .sort((a, b) => activity(b) - activity(a))
    .forEach((s) => {
      if (hero.length < HERO_MIN) pushHero(s);
    });

  const tail = sessions.filter((s) => !heroKeys.has(sessionKey(s)));
  const groupMap = new Map<string, SwitcherSession[]>();
  for (const s of tail) {
    const label = s.type === "port" ? "Ports" : projectKey(s.cwd);
    const bucket = groupMap.get(label);
    if (bucket) bucket.push(s);
    else groupMap.set(label, [s]);
  }
  const groups: SwitcherGroup[] = Array.from(groupMap.entries())
    .map(([label, rows]) => ({ label, rows: rows.sort(byAttentionThenRecency) }))
    .sort((a, b) => {
      // Ports sink to the bottom; other groups by most recent activity.
      if (a.label === "Ports") return 1;
      if (b.label === "Ports") return -1;
      return Math.max(...b.rows.map(activity)) - Math.max(...a.rows.map(activity));
    });

  return { mode: "tiers", hero, groups, currentInHero: current !== null };
};

/** Compact "time since" for card/row metadata. */
export const relativeTime = (ts: number, nowMs: number) => {
  if (!ts) return "";
  const s = Math.floor((nowMs - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
