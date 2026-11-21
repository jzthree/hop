// The Answers page's words and order: which tab a turn belongs on, who it
// says started it, and the one-line previews of the list. Pure, so it is
// tested without the page.

/** A turn that ended with words: a question of yours, or one something else started. */
export type Answer = {
  id: string;
  session: string;
  sessionName: string;
  agent: string | null;
  /** "you": its person asked; "agents": another session, a check-back, a loop, a schedule. */
  from?: "you" | "agents";
  /** you, queued, message, scheduled, loop, repeat, typed, or the agent app's own word. */
  source?: string | null;
  /** Who sent or set it, when hop knows: a session's name, "pulse-bot", "CEO". */
  by?: string | null;
  question: string;
  askedAt: number;
  answer: string;
  answeredAt: number;
  readAt: number | null;
};

export type AnswerTab = "you" | "agents";

/** Which tab a turn is on. One kept before hop said is the person's. */
export const tabOf = (a: Answer): AnswerTab => (a.from === "agents" ? "agents" : "you");

/** Who started the turn, as the reading pane heads the prompt. */
export const sourceLabel = (a: Answer): string => {
  const by = a.by && a.by.trim() ? a.by.trim() : null;
  switch (a.source) {
    case "queued": return "You (sent when the agent was free)";
    case "message": return by ? `Message from ${by}` : "Message from an agent";
    case "scheduled": return by === "you" ? "Your check-back" : by ? `Check-back set by ${by}` : "Scheduled run";
    case "loop": return "The session's loop";
    case "repeat": return "Repeated prompt (a schedule)";
    case "typed": return by ? `Typed by ${by}` : "Typed by an agent";
    case "peer": case "coordinator": return "Message from another session";
    case "task-notification": case "task_notification": return "A background task's notice";
    case "auto-continuation": case "auto_continuation": return "The agent continuing on its own";
    default: return tabOf(a) === "agents" ? "Started by an agent" : "You asked";
  }
};

/** The short tag in the list for an agents' turn: "plotter", "check-back", "loop". */
export const sourceTag = (a: Answer): string | null => {
  if (tabOf(a) === "you") return a.source === "queued" ? "sent when free" : null;
  if (a.source === "message" || a.source === "typed") return a.by || "agent";
  if (a.source === "scheduled") return a.by && a.by !== "you" ? `check-back · ${a.by}` : "check-back";
  if (a.source === "loop" || a.source === "repeat") return "schedule";
  return a.source || "agent";
};

/** A prompt as the reading pane shows it: without hop's sender line (the label says who sent it) or paste wrappers. */
export const promptText = (text: string): string => String(text || "")
  .replace(/<\/?pasted_content[^>]*>/g, "")
  .replace(/^\s*\[hop message from [^\]]*\]\s*/, "")
  .trim();

/** One line of a text for the list: hop's sender line and wrappers dropped, whitespace folded. */
export const preview = (text: string, max = 160): string => {
  const t = String(text || "")
    .replace(/<\/?pasted_content[^>]*>/g, " ")
    .replace(/^\s*\[hop message from [^\]]*\]\s*/, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Unread per tab, for the tab labels. */
export const unreadByTab = (items: Answer[]): Record<AnswerTab, number> => {
  const out: Record<AnswerTab, number> = { you: 0, agents: 0 };
  for (const a of items) if (!a.readAt) out[tabOf(a)] += 1;
  return out;
};
