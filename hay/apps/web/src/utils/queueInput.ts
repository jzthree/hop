// "Send what is typed when the agent's turn ends": Codex does it with Tab;
// hop gives Claude Code and Antigravity the same Tab (and ⌘⌥⏎ everywhere).
// The daemon takes the text out of the input box and queues it
// (/api/sessions/queue-input); with Tab, anything else — the agent is free
// after all, the box is empty — is a plain Tab, passed on.

type Key = { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean };

/** Agents whose own Tab does not queue: hop's does, while they work. */
const TAB_QUEUES_FOR = new Set(["claude", "antigravity"]);

/**
 * Is this Tab hop's "queue it" (a bare Tab, in a Claude or Antigravity session
 * that is working)? `working` may be a function: it is asked only for a Tab.
 */
export const tabQueues = (ev: Key, agent: string | null | undefined, working: boolean | (() => boolean)): boolean =>
  ev.key === "Tab" && !ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.isComposing
  && !!agent && TAB_QUEUES_FOR.has(agent) && (typeof working === "function" ? working() : working);

/**
 * A turn in flight, by the foot of the terminal itself — fresher than the
 * session list, which is read every few seconds (a Tab in a turn's first
 * seconds went to the agent as a plain Tab, and did nothing). Claude's footer
 * says "esc to interrupt" only while it works; agy shows a braille spinner
 * over its box (as the daemon's lib/agent-phase.js reads them). Only the foot:
 * the conversation above may quote either.
 */
export const footSaysWorking = (lines: string[]): boolean => {
  const shown = lines.map((l) => l.trimEnd());
  while (shown.length && !shown[shown.length - 1].trim()) shown.pop();
  if (/esc to interrupt/i.test(shown.slice(-3).join("\n"))) return true;
  return /^[ \t]*[\u2801-\u28ff][ \t]+\S[^\n]*?(?:\.\.\.|…)/m.test(shown.slice(-12).join("\n"));
};

type TermLike = { rows: number; buffer: { active: { baseY: number; getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined } } };
/** footSaysWorking, on what an xterm terminal shows now. */
export const terminalSaysWorking = (t: TermLike | null | undefined): boolean => {
  if (!t) return false;
  try {
    const buf = t.buffer.active;
    const lines: string[] = [];
    for (let i = buf.baseY; i < buf.baseY + t.rows; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    return footSaysWorking(lines);
  } catch { return false; }
};

/** Queue what is typed in `room`'s input box; says what happened in a notice. Resolves the status. */
export async function queueTypedInput(room: string, opts: { viaTab?: boolean; notice: (m: string) => void; fetchImpl?: typeof fetch }): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f("/api/sessions/queue-input", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: room, ...(opts.viaTab ? { key: "tab" } : {}) })
    });
    const data = await res.json().catch(() => ({})) as { status?: string; error?: string; warning?: string };
    if (!res.ok) { opts.notice(data.error || "Couldn't queue it"); return null; }
    if (data.status === "empty") opts.notice("Nothing typed to send later");
    else if (data.status === "queued-in-agent") opts.notice("Queued in Codex: it goes when this turn ends");
    else if (data.status === "queued") opts.notice(data.warning ? `Queued. ${data.warning}` : "Queued: it goes when this turn ends");
    // "sent": the agent was free, so it went as Enter would send it.
    // "passed": a plain Tab, typed for you.
    return data.status ?? null;
  } catch {
    opts.notice("Couldn't queue it");
    return null;
  }
}
