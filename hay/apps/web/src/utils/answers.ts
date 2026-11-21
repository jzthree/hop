// The Answers page's words and order: which tab a turn belongs on, who it
// says started it, the one-line previews of the list, and search. Pure, so
// it is tested without the page.

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
  /** Archived: out of the inbox, still found by search (hop keeps it a month). */
  archivedAt?: number | null;
  /** Its person moved it to the other tab. */
  movedAt?: number | null;
};

/** Which of a tab's turns the list shows. */
export type AnswerView = "inbox" | "unread" | "archived";

export type AnswerTab = "you" | "agents";

/** Which tab a turn is on. One kept before hop said is the person's. */
export const tabOf = (a: Answer): AnswerTab => (a.from === "agents" ? "agents" : "you");

/** Who started the turn, as the reading pane heads the prompt. */
export const sourceLabel = (a: Answer): string => {
  if (a.movedAt) return tabOf(a) === "agents" ? "Moved here by you (not your question)" : "Moved here by you";
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

/** Unread in each tab's inbox, for the tab labels. */
export const unreadByTab = (items: Answer[]): Record<AnswerTab, number> => {
  const out: Record<AnswerTab, number> = { you: 0, agents: 0 };
  for (const a of items) if (!a.readAt && !a.archivedAt) out[tabOf(a)] += 1;
  return out;
};

/** Whether a view shows this turn (search shows every view's). */
export const inView = (a: Answer, view: AnswerView): boolean =>
  view === "archived" ? !!a.archivedAt : !a.archivedAt && (view === "inbox" || !a.readAt);

/** A search's words, lowercased: every one must be found. */
export const searchTerms = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean);

/** What search looks through: its prompt, its reply, its session's name, who sent it. */
export const haystack = (a: Answer, sessionName: string): string => `${a.question}\n${a.answer}\n${sessionName}\n${a.by || ""}`.toLowerCase();

/** Does this turn hold every word? (`hay`: its haystack, when the page keeps them.) */
export const matches = (a: Answer, sessionName: string, terms: string[], hay?: string): boolean =>
  !terms.length || terms.every((t) => (hay ?? haystack(a, sessionName)).includes(t));

/** The preview of a text around the first word searched for, so the list shows why it matched. */
export const snippet = (text: string, terms: string[], max = 160): string => {
  const t = preview(text, 100_000);
  if (t.length <= max) return t;
  if (!terms.length) return `${t.slice(0, max - 1)}…`;
  const lc = t.toLowerCase();
  const at = terms.map((w) => lc.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined || at < max / 3) return `${t.slice(0, max - 1)}…`;
  const start = Math.max(0, at - Math.floor(max / 3));
  const piece = t.slice(start, start + max - 2);
  return `…${piece}${start + max - 2 < t.length ? "…" : ""}`;
};

/** A text cut where the searched words are, for <mark>: [plain, marked, plain, …]. */
export const markParts = (text: string, terms: string[]): { text: string; hit: boolean }[] => {
  if (!terms.length || !text) return [{ text, hit: false }];
  const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${esc.join("|")})`, "gi");
  return text.split(re).filter((x) => x !== "").map((x) => ({ text: x, hit: terms.includes(x.toLowerCase()) }));
};
