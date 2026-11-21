import { describe, expect, it } from "vitest";
import { preview, promptText, sourceLabel, sourceTag, tabOf, unreadByTab, type Answer } from "./answers";

const a = (over: Partial<Answer>): Answer => ({
  id: "x", session: "s", sessionName: "s", agent: "claude", question: "q", askedAt: 0, answer: "a", answeredAt: 1, readAt: null, ...over
});

describe("the Answers page's words", () => {
  it("files a turn by who started it, and says so", () => {
    expect(tabOf(a({}))).toBe("you");
    expect(tabOf(a({ from: "agents" }))).toBe("agents");
    expect(sourceLabel(a({}))).toBe("You asked");
    expect(sourceLabel(a({ source: "queued" }))).toBe("You (sent when the agent was free)");
    expect(sourceLabel(a({ from: "agents", source: "message", by: "pulse-bot" }))).toBe("Message from pulse-bot");
    expect(sourceLabel(a({ from: "agents", source: "scheduled", by: "coordinator" }))).toBe("Check-back set by coordinator");
    expect(sourceLabel(a({ from: "agents", source: "scheduled", by: "you" }))).toBe("Your check-back");
    expect(sourceLabel(a({ from: "agents", source: "repeat" }))).toBe("Repeated prompt (a schedule)");
    expect(sourceLabel(a({ from: "agents", source: "something-new" }))).toBe("Started by an agent");
    expect(sourceTag(a({}))).toBeNull();
    expect(sourceTag(a({ from: "agents", source: "message", by: "plotter" }))).toBe("plotter");
    expect(sourceTag(a({ from: "agents", source: "loop" }))).toBe("schedule");
  });

  it("previews one line, without hop's sender line or markdown marks", () => {
    expect(preview("[hop message from session \"plotter\" (a Claude agent, not your user). To answer…]  the **plot**\nmoved")).toBe("the plot moved");
    expect(preview("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
    expect(promptText("<pasted_content id=\"1\">[hop message from session \"plotter\" (a Claude agent, not your user). To answer…] the plot\nmoved</pasted_content id=\"1\">")).toBe("the plot\nmoved");
  });

  it("counts unread per tab", () => {
    expect(unreadByTab([a({}), a({ readAt: 5 }), a({ from: "agents" })])).toEqual({ you: 1, agents: 1 });
  });
});
