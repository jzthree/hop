import { describe, expect, it } from "vitest";
import { nextSessionWithNews } from "../src/utils/catchUp";

const s = (name: string, o: Record<string, unknown> = {}) => ({ name, internalName: name, lastActivityAt: 0, ...o });

describe("nextSessionWithNews", () => {
  const fleet = [
    s("quiet"),
    s("done-old", { agentPhase: "done", turnSeen: false, lastActivityAt: 10 }),
    s("done-new", { agentPhase: "done", turnSeen: false, lastActivityAt: 20 }),
    s("read", { agentPhase: "done", turnSeen: true, lastActivityAt: 99 }),
    s("asking", { attentionReason: "waiting for input", lastActivityAt: 1 }),
    s("parked", { attentionReason: "x", parked: true }),
    s("port", { attentionReason: "x", type: "port" })
  ];
  it("puts a question first, then unread finished turns, newest first", () => {
    expect(nextSessionWithNews(fleet, null)?.name).toBe("asking");
    expect(nextSessionWithNews(fleet, "asking")?.name).toBe("done-new");
  });
  it("walks forward past the ones this run already visited", () => {
    expect(nextSessionWithNews(fleet, "done-new", new Set(["asking"]))?.name).toBe("done-old");
    expect(nextSessionWithNews(fleet, "done-old", new Set(["asking", "done-new"]))).toBeNull();
  });
});
