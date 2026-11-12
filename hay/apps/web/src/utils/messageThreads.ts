// Messages between sessions (GET /api/messages), as conversations: one per
// pair of sessions, newest first, each told in the order it happened.

export type AgentMessage = {
  id: string;
  /** The sending session; null for an agent outside hop. */
  from: string | null;
  fromName: string | null;
  fromAgent?: string | null;
  to: string;
  toName: string;
  text: string;
  at: number;
  status: "waiting" | "delivered" | "failed" | "cancelled" | "refused" | "held";
  reason?: string;
  /** A check-back set for another session (it goes at a time or event). */
  scheduled?: boolean;
  /** The sender read the answer off the recipient's turn. */
  replyHere?: boolean;
  deliveredAt?: number;
  reply?: string;
  replyAt?: number;
};

export const OUTSIDE = "(outside)";

export type Thread = {
  key: string;
  /** The two sides, in a stable order: the conversation's left and right. */
  a: string;
  b: string;
  names: Record<string, string>;
  messages: AgentMessage[];
  lastAt: number;
  /** Messages and send-and-wait answers. */
  count: number;
};

const sideOf = (m: AgentMessage) => m.from ?? OUTSIDE;

/** Conversations, newest first; names as the newest message has them. */
export function threadsOf(messages: AgentMessage[]): Thread[] {
  const by = new Map<string, Thread>();
  for (const m of [...messages].sort((x, y) => x.at - y.at)) {
    const [a, b] = [sideOf(m), m.to].sort();
    const key = `${a}\u0000${b}`;
    const t = by.get(key) ?? { key, a, b, names: {}, messages: [], lastAt: 0, count: 0 };
    t.names[sideOf(m)] = m.from ? (m.fromName || m.from) : "an agent outside hop";
    t.names[m.to] = m.toName || m.to;
    t.messages.push(m);
    t.count += m.replyAt ? 2 : 1;
    t.lastAt = Math.max(t.lastAt, m.at, m.replyAt ?? 0);
    by.set(key, t);
  }
  return [...by.values()].sort((x, y) => y.lastAt - x.lastAt);
}

/** What became of a message, in a few words. */
export function statusLine(m: AgentMessage, fmt: (at: number) => string): string {
  switch (m.status) {
    case "waiting": return m.reason ? `Waiting: ${m.reason}` : `Waiting for ${m.toName} to finish its turn`;
    case "delivered": return m.deliveredAt && m.deliveredAt - m.at > 60_000 ? `Delivered ${fmt(m.deliveredAt)}` : "Delivered";
    case "failed": return `Not delivered${m.reason ? `: ${m.reason}` : ""}`;
    case "cancelled": return "Cancelled before it was delivered";
    case "refused": return `Turned away${m.reason ? `: ${m.reason}` : ""}`;
    case "held": return `Stopped${m.reason ? `: ${m.reason}` : ""}`;
    default: return "";
  }
}

/** The newest moment in the log: a message, or an answer read off a turn. */
export const newestAt = (messages: AgentMessage[]): number =>
  messages.reduce((n, m) => Math.max(n, m.at, m.replyAt ?? 0), 0);
