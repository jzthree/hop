import { describe, expect, it } from "vitest";
import { describeState, describeTrigger, orderForSession, relative, type Checkback } from "../src/utils/checkbackText";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const M = 60_000, H = 3_600_000;

describe("words for a check-back", () => {
  it("relative distances read in the coarsest unit", () => {
    expect(relative(NOW + 20_000, NOW)).toBe("in 20s");
    expect(relative(NOW + 12 * M, NOW)).toBe("in 12m");
    expect(relative(NOW + 2.5 * H, NOW)).toBe("in 2.5h");
    expect(relative(NOW - 3 * M, NOW)).toBe("3m ago");
  });
  it("each trigger kind has a line", () => {
    expect(describeTrigger({ kind: "every", everyMs: 2 * H, next: NOW + 30 * M }, NOW)).toBe("every 2h · next in 30m");
    expect(describeTrigger({ kind: "idle" }, NOW)).toBe("when the agent is next idle");
    expect(describeTrigger({ kind: "idle", afterMs: 15 * M }, NOW)).toBe("when idle for 15m");
    expect(describeTrigger({ kind: "file", path: "/x/out.csv" }, NOW)).toBe("when /x/out.csv exists");
    expect(describeTrigger({ kind: "file", path: "/x/out.csv", baselineMtime: 1 }, NOW)).toBe("when /x/out.csv changes");
    expect(describeTrigger({ kind: "cmd", command: "test -f a", everyMs: 5 * M }, NOW)).toBe("when `test -f a` succeeds · checked every 5m");
    expect(describeTrigger({ kind: "at", at: NOW + 10 * M }, NOW)).toMatch(/^at .* \(in 10m\)$/);
  });
  it("state lines", () => {
    const base: Checkback = { id: "c", session: "s", message: "m", trigger: { kind: "idle" }, status: "pending" };
    expect(describeState(base, NOW)).toBe("waiting");
    expect(describeState({ ...base, firedAt: NOW }, NOW)).toBe("fired · waiting for the agent to be idle");
    expect(describeState({ ...base, status: "delivered", deliveredAt: NOW - 5 * M }, NOW)).toBe("typed 5m ago");
    expect(describeState({ ...base, status: "cancelled" }, NOW)).toBe("cancelled");
  });
  it("orders a session's check-backs: pending soonest first, then the recent rest newest first", () => {
    const items: Checkback[] = [
      { id: "1", session: "s", message: "a", trigger: { kind: "at", at: NOW + 2 * H }, status: "pending" },
      { id: "2", session: "other", message: "x", trigger: { kind: "idle" }, status: "pending" },
      { id: "3", session: "s", message: "b", trigger: { kind: "at", at: NOW + 10 * M }, status: "pending" },
      { id: "4", session: "s", message: "c", trigger: { kind: "idle" }, status: "delivered", deliveredAt: NOW - H },
      { id: "5", session: "s", message: "d", trigger: { kind: "idle" }, status: "cancelled", cancelledAt: NOW - 10 * M }
    ];
    expect(orderForSession(items, "s").map((c) => c.id)).toEqual(["3", "1", "5", "4"]);
  });
});
