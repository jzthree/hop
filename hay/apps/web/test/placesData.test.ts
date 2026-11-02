import { describe, expect, it } from "vitest";
import { mergeEditions, readKeys, threadFor, unreadDecisions } from "../src/utils/briefingFeed";
import { dayLabel, parsePulseFeed, pulseItemsFor } from "../src/utils/pulseFeed";

describe("briefing feed", () => {
  const e1 = { generated_at: "2026-11-01T10:00:00Z", summary: "older", items: [] };
  const e2 = { generated_at: "2026-11-01T12:00:00Z", summary: "newest", items: [
    { session: "a", headline: "x", slot: "decide" as const },
    { session: "b", headline: "y", slot: "decide" as const },
    { session: "c", headline: "z", slot: "watch" as const }
  ] };
  it("puts a newer digest.json in front of the archive, and drops empty editions", () => {
    expect(mergeEditions({ editions: [e1] }, e2).map((e) => e.summary)).toEqual(["newest", "older"]);
    expect(mergeEditions({ editions: [e2, e1] }, e2).length).toBe(2);
    expect(mergeEditions(null, { generated_at: "t" })).toEqual([]);
  });
  it("counts decisions in the newest edition that nobody has read", () => {
    const read = readKeys({ [`${e2.generated_at}|a`]: { level: "read" }, [`${e2.generated_at}|b`]: { level: "glimpsed" } });
    expect(unreadDecisions([e2, e1], read)).toBe(1);
    expect(unreadDecisions([], read)).toBe(0);
  });
  it("threads a session's stories across editions, newest first", () => {
    const t = threadFor([e2, { ...e1, items: [{ session: "A", headline: "early" }] }], (id) => id.toLowerCase() === "a");
    expect(t.map((x) => [x.headline, x.at])).toEqual([["x", e2.generated_at], ["early", e1.generated_at]]);
  });
});

describe("pulse feed", () => {
  const json = {
    generated_at: "2026-11-01T06:00:00Z", discuss_url: "https://chat.example.org/dm",
    pulses: [{ engine: "claude", label: "Claude", date: "2026-11-01", title: "Morning pulse",
      sections: [{ id: "i", kind: "intro", body: "hello" }, { id: "o1", kind: "overlooked", body: "thing" }],
      actions: [{ id: "o1", label: "Follow up", cwd: "/w", session_name: "fu-1", command: "go", target_internal_name: "s_1", target_name: "owner", message: "note" },
                { id: "bad", label: "x" }] }],
    history: [{ date: "2026-10-31", pulses: [{ engine: "gpt", date: "2026-10-31", sections: [] }] }, { date: "2026-10-30", pulses: [] }]
  };
  it("reads today's pulses and the days before, keeping only complete actions", () => {
    const feed = parsePulseFeed(json)!;
    expect(feed.days.map((d) => d.date)).toEqual(["2026-11-01", "2026-10-31"]);
    expect(feed.discussUrl).toBe("https://chat.example.org/dm");
    const p = feed.days[0].pulses[0];
    expect(Object.keys(p.actions)).toEqual(["o1"]);
    expect(p.actions.o1).toMatchObject({ sessionName: "fu-1", targetName: "owner", message: "note" });
    expect(parsePulseFeed({ pulses: [] })).toBeNull();
  });
  it("finds a session's items by the session that owns them or followed up", () => {
    const feed = parsePulseFeed(json)!;
    expect(pulseItemsFor(feed, (id) => id === "s_1").map((x) => x.section.id)).toEqual(["o1"]);
    expect(pulseItemsFor(feed, (id) => id === "fu-1")).toHaveLength(1);
    expect(pulseItemsFor(feed, () => false)).toEqual([]);
    expect(pulseItemsFor(null, () => true)).toEqual([]);
  });
  it("names days as people do", () => {
    const now = new Date(2026, 10, 1, 9);
    expect(dayLabel("2026-11-01", now)).toBe("Today");
    expect(dayLabel("2026-10-31", now)).toBe("Yesterday");
    expect(dayLabel("2026-10-28", now)).toMatch(/Oct/);
  });
});
