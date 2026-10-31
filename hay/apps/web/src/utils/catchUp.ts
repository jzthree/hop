// ⌘G, "catch up": the next session with news for you. A question (the agent
// is waiting on you, or rang the bell) comes before a finished turn you have
// not read; inside each, the newest first. Parked sessions and ports never
// count, nor does the one on screen. `skip` holds the ones this run of ⌘G
// already visited — their read markers land a moment later, and without it
// two unread sessions bounced back and forth.

export type CatchUpSession = {
  name: string;
  internalName?: string;
  type?: string;
  parked?: boolean;
  archived?: boolean;
  attentionReason?: string;
  bellUnseen?: boolean;
  agentPhase?: string | null;
  turnSeen?: boolean;
  lastActivityAt?: number;
};

const keyOf = (s: CatchUpSession) => s.internalName || s.name;

export const newsRank = (s: CatchUpSession): number =>
  s.attentionReason || s.bellUnseen ? 2 : s.agentPhase === "done" && !s.turnSeen ? 1 : 0;

export const nextSessionWithNews = <T extends CatchUpSession>(
  sessions: T[],
  current: string | null,
  skip: Set<string> = new Set()
): T | null => {
  const cur = (current || "").toLowerCase();
  const candidates = sessions.filter((s) =>
    s.type !== "port" && !s.parked && !s.archived && newsRank(s) > 0
    && keyOf(s).toLowerCase() !== cur && s.name.toLowerCase() !== cur
    && !skip.has(keyOf(s)));
  candidates.sort((a, b) => newsRank(b) - newsRank(a) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return candidates[0] ?? null;
};
