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
  cols?: number;
  rows?: number;
  createdBy?: "user" | "agent";
  // How the origin was determined: "mcp"/"hopa" are decisive agent
  // interfaces; "cli-agent-env" was inferred from the environment and can be
  // wrong in both directions.
  createdVia?: string | null;
  // Short human-readable line describing the session's work, written by
  // `hop ai tagline`. Absent unless the user has run it.
  tagline?: string;
  // Parked: hidden from the wall (still running unless also archived).
  parked?: boolean;
  // Archived: process stopped, but reopening resumes the conversation.
  archived?: boolean;
  // Folder the user filed this session under (Manual mode). Null = loose.
  folderId?: string | null;
  // A hop CLI is attached in a real terminal window on the host. The wall
  // must never resize such a session — that window's size is physical truth.
  hasLocalCli?: boolean;
};

export type SessionOriginScope = "user" | "agent" | "all";

// How the switcher orders sessions when not filtering:
//   recent  — attention-first tiers + project-grouped tail (the default)
//   project — every session grouped strictly by workdir
//   manual  — a flat, user-dragged order the client persists
export type SwitcherSortMode = "recent" | "project" | "manual";

export type SwitcherGroup = {
  label: string;
  rows: SwitcherSession[];
};

export type SwitcherFolder = { id: string; name: string };

export type SwitcherModel =
  | { mode: "tiers"; hero: SwitcherSession[]; groups: SwitcherGroup[]; currentInHero: boolean }
  | { mode: "filter"; rows: SwitcherSession[] }
  | { mode: "project"; groups: SwitcherGroup[] }
  | { mode: "manual"; rows: SwitcherSession[]; folders: Array<{ folder: SwitcherFolder; rows: SwitcherSession[] }> };

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

/**
 * Ranked filter matching: exact beats prefix beats substring, and the
 * home-shortened cwd the UI displays is first-class ("~" must rank sessions
 * whose workdir IS ~ above everything that merely lives under it).
 */
export const filterScore = (s: SwitcherSession, q: string): number => {
  const name = (s.displayName || s.name).toLowerCase();
  const cwdRaw = (s.cwd || "").toLowerCase();
  const cwdShort = s.cwd ? shortenForGroup(s.cwd).toLowerCase() : "";
  const proc = (s.foregroundProcess || "").toLowerCase();
  if (name === q) return 100;
  if (cwdShort === q) return 90; // exact workdir ("~", "~/code/hop2")
  if (name.startsWith(q)) return 80;
  const cwdBase = cwdShort.split("/").filter(Boolean).pop() || "";
  if (cwdBase === q) return 70; // project dir name typed exactly
  if (name.includes(q)) return 60;
  if (cwdShort.startsWith(q)) return 55; // workdir prefix ("~/code")
  if (cwdShort.includes(q) || cwdRaw.includes(q)) return 40;
  if (proc.includes(q)) return 30;
  return 0;
};

export const filterSessionsByOrigin = (
  sessions: SwitcherSession[],
  scope: SessionOriginScope
) => {
  if (scope === "all") return sessions;
  if (scope === "agent") return sessions.filter((session) => session.createdBy === "agent");
  return sessions.filter((session) => session.createdBy !== "agent");
};

/**
 * Group every session by workdir (ports last). Two orderings:
 * - stable (Project MODE): groups alphabetical, rows alphabetical — a map of
 *   your projects that never reshuffles as sessions chatter. Attention shows
 *   as dots/glow, not as position.
 * - recency (the Recent mode's tail): groups by latest activity, rows
 *   attention-first — there, movement IS the signal.
 */
const groupByProject = (sessions: SwitcherSession[], stable = false): SwitcherGroup[] => {
  const groupMap = new Map<string, SwitcherSession[]>();
  for (const s of sessions) {
    const label = s.type === "port" ? "Ports" : projectKey(s.cwd);
    const bucket = groupMap.get(label);
    if (bucket) bucket.push(s);
    else groupMap.set(label, [s]);
  }
  const byName = (a: SwitcherSession, b: SwitcherSession) =>
    (a.displayName || a.name).localeCompare(b.displayName || b.name);
  return Array.from(groupMap.entries())
    .map(([label, rows]) => ({ label, rows: rows.sort(stable ? byName : byAttentionThenRecency) }))
    .sort((a, b) => {
      // Ports sink to the bottom in both orderings.
      if (a.label === "Ports") return 1;
      if (b.label === "Ports") return -1;
      if (stable) return a.label.localeCompare(b.label);
      return Math.max(...b.rows.map(activity)) - Math.max(...a.rows.map(activity));
    });
};

/**
 * Order sessions by a saved list of keys (the user's manual drag order),
 * appending any session not yet in the saved order at the end.
 *
 * Manual means MANUAL: nothing here may reorder on activity. Sessions the
 * user has placed keep their saved index, and unplaced ones (brand new, or
 * never dragged) sort by name at the tail — stable, findable, and immune to
 * chatter. Ranking the tail by recency made a manual wall shuffle itself
 * every time a session printed a line, which defeats the point of arranging
 * it by hand.
 */
const orderManually = (sessions: SwitcherSession[], manualOrder: string[]): SwitcherSession[] => {
  const rank = new Map(manualOrder.map((key, i) => [key, i]));
  const byName = (a: SwitcherSession, b: SwitcherSession) =>
    (a.displayName || a.name).localeCompare(b.displayName || b.name);
  return [...sessions].sort((a, b) => {
    const ra = rank.get(sessionKey(a));
    const rb = rank.get(sessionKey(b));
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1; // placed sessions before unplaced
    if (rb !== undefined) return 1;
    return byName(a, b); // both unplaced → stable, not recency
  });
};

/**
 * Split sessions into the user's folders plus everything still loose.
 * Folders belong to MANUAL mode only: Recent is ordered by the machine and
 * Project by the filesystem, so a hand-authored grouping would contradict
 * both. Empty folders are kept — a folder you made is a place you intend to
 * put things, and silently hiding it would make new folders look broken.
 */
const splitIntoFolders = (
  sessions: SwitcherSession[],
  folders: SwitcherFolder[],
  manualOrder: string[]
) => {
  const byId = new Map(folders.map((f) => [f.id, [] as SwitcherSession[]]));
  const loose: SwitcherSession[] = [];
  for (const s of sessions) {
    const bucket = s.folderId ? byId.get(s.folderId) : undefined;
    if (bucket) bucket.push(s);
    else loose.push(s);
  }
  return {
    folders: folders.map((folder) => ({
      folder,
      rows: orderManually(byId.get(folder.id) || [], manualOrder)
    })),
    loose: orderManually(loose, manualOrder)
  };
};

export const buildSwitcherModel = (
  sessions: SwitcherSession[],
  currentRoom: string | null,
  filter: string,
  sortMode: SwitcherSortMode = "recent",
  manualOrder: string[] = [],
  folders: SwitcherFolder[] = []
): SwitcherModel => {
  const query = filter.trim();
  if (query) {
    const q = query.toLowerCase();
    const matches = sessions.filter((s) => filterScore(s, q) > 0);
    // Manual mode: filtering NARROWS the wall, it never re-ranks it. Keeping
    // the user's own order in the filtered view is what makes "find it, then
    // drag it" work — you can see where a card sits relative to the other
    // matches, and a drop means "put this one next to that one", which stays
    // well-defined in the full order even though the sessions between them
    // are hidden. Score-ranking here would reorder the wall under the user's
    // hands at the exact moment they were trying to arrange it.
    if (sortMode === "manual") {
      // Filtering narrows within folders too, so a search never pretends a
      // session left the folder you filed it in.
      const split = splitIntoFolders(matches, folders, manualOrder);
      return { mode: "manual", rows: split.loose, folders: split.folders };
    }
    const rows = matches
      .map((s) => ({ s, score: filterScore(s, q) }))
      .sort((a, b) => b.score - a.score || byAttentionThenRecency(a.s, b.s))
      .map((x) => x.s);
    return { mode: "filter", rows };
  }

  // Search overrides sort mode; otherwise honor the chosen organization.
  if (sortMode === "project") {
    return { mode: "project", groups: groupByProject(sessions, true) };
  }
  if (sortMode === "manual") {
    const split = splitIntoFolders(sessions, folders, manualOrder);
    return { mode: "manual", rows: split.loose, folders: split.folders };
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

  // The tail continues the SAME ordering as the hero cards: recency. It used
  // to be grouped by workdir, which quietly turned the bottom half of Recent
  // into a directory view — answering a question the mode had not been asked,
  // and duplicating what Project mode exists to do. Recent is now recency all
  // the way down, and a session's position means one thing everywhere in it.
  const tail = sessions
    .filter((s) => !heroKeys.has(sessionKey(s)))
    .sort(byAttentionThenRecency);
  const groups = tail.length > 0 ? [{ label: "", rows: tail }] : [];

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
