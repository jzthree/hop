import { describe, expect, it } from "vitest";
import { inView, markParts, matches, preview, promptText, searchTerms, snippet, sourceLabel, sourceTag, tabOf, unreadByTab, type Answer } from "./answers";

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

  it("counts unread per tab, in the inbox", () => {
    expect(unreadByTab([a({}), a({ readAt: 5 }), a({ from: "agents" }), a({ archivedAt: 9 })])).toEqual({ you: 1, agents: 1 });
    expect(sourceLabel(a({ from: "agents", movedAt: 3 }))).toBe("Moved here by you (not your question)");
  });

  it("views: the inbox keeps read ones until archived", () => {
    expect([inView(a({}), "inbox"), inView(a({ readAt: 2 }), "inbox"), inView(a({ readAt: 2, archivedAt: 3 }), "inbox")]).toEqual([true, true, false]);
    expect([inView(a({}), "unread"), inView(a({ readAt: 2 }), "unread")]).toEqual([true, false]);
    expect([inView(a({}), "archived"), inView(a({ archivedAt: 3 }), "archived")]).toEqual([false, true]);
  });

  it("search: every word, anywhere in the turn or its session's name; the snippet shows where", () => {
    const t = searchTerms("  GPU  util ");
    expect(t).toEqual(["gpu", "util"]);
    expect(matches(a({ answer: "GPU util is 97%" }), "s", t)).toBe(true);
    expect(matches(a({ answer: "GPU is busy" }), "s", t)).toBe(false);
    expect(matches(a({}), "trainer", searchTerms("train"))).toBe(true);
    const long = `${"filler words ".repeat(30)}the needle is here ${"more ".repeat(30)}`;
    expect(snippet(long, ["needle"], 60).startsWith("…")).toBe(true);
    expect(snippet(long, ["needle"], 60)).toContain("needle");
    expect(snippet("short one", ["needle"], 60)).toBe("short one");
    expect(snippet("a short text whose needle is late but fits", ["needle"], 60)).toBe("a short text whose needle is late but fits");
    expect(markParts("GPU util, gpu", ["gpu"])).toEqual([{ text: "GPU", hit: true }, { text: " util, ", hit: false }, { text: "gpu", hit: true }]);
    expect(markParts("a (b)", ["(b)"])).toEqual([{ text: "a ", hit: false }, { text: "(b)", hit: true }]);
  });
});
