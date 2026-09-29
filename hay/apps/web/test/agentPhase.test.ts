import { describe, expect, it } from "vitest";
import { cardPhase, phaseLabel } from "../src/utils/agentPhase";

describe("cardPhase — the wall's three agent colours come from the daemon's verdict", () => {
  it("working while a turn is in flight", () => {
    expect(cardPhase({ agentPhase: "working", turnSeen: true })).toBe("working");
  });
  it("done and unread until a human has opened it since the turn ended", () => {
    expect(cardPhase({ agentPhase: "done", turnSeen: false })).toBe("done-unread");
    expect(cardPhase({ agentPhase: "done", turnSeen: true })).toBe("done-read");
  });
  it("nothing for a plain shell or an agent that has not finished a turn", () => {
    expect(cardPhase({ agentPhase: null })).toBe(null);
    expect(cardPhase({})).toBe(null);
  });
  it("labels", () => {
    expect(phaseLabel("working")).toBe("WORKING");
    expect(phaseLabel("done-unread")).toBe("DONE");
    expect(phaseLabel("done-read")).toBe("READ");
    expect(phaseLabel(null)).toBe("");
  });
});
