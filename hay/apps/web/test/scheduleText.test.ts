import { describe, expect, it } from "vitest";
import { conditionLabel, dayHeading, describeRrule } from "../src/utils/checkbackText";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("Codex automation schedules", () => {
  const now = at(2026, 10, 16, 12, 0);
  it("a one-shot (DTSTART + COUNT=1) runs at its start", () => {
    const r = describeRrule("DTSTART:20261017T040000Z\nRRULE:FREQ=DAILY;COUNT=1", now);
    expect(r.next).toBe(Date.UTC(2026, 9, 17, 4, 0, 0));
    expect(r.label).toMatch(/^at /);
  });
  it("an interval without a start says how often, with no next time", () => {
    expect(describeRrule("FREQ=HOURLY;INTERVAL=4", now)).toEqual({ label: "every 4h", next: null });
    expect(describeRrule("FREQ=MINUTELY;INTERVAL=15", now).label).toBe("every 15m");
  });
  it("a daily clock time finds today's or tomorrow's slot", () => {
    const r = describeRrule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", now);
    expect(r.label).toBe("daily at 9:00");
    expect(r.next).toBe(at(2026, 10, 17, 9, 0));
    expect(describeRrule("FREQ=DAILY;BYHOUR=8,18;BYMINUTE=30", now).next).toBe(at(2026, 10, 16, 18, 30));
  });
});

describe("reminder-list headings", () => {
  const now = at(2026, 10, 16, 12, 0);
  it("names today, tomorrow, and later days", () => {
    expect(dayHeading(at(2026, 10, 16, 18), now)).toBe("Today");
    expect(dayHeading(at(2026, 10, 17, 1), now)).toBe("Tomorrow");
    expect(dayHeading(at(2026, 10, 15, 9), now)).toBe("Overdue");
    expect(dayHeading(at(2026, 10, 20, 9), now)).not.toMatch(/Today|Tomorrow/);
  });
  it("labels a condition by what it waits on", () => {
    expect(conditionLabel({ kind: "cmd", command: "squeue -j 1 | grep -q DONE" })).toEqual({ tag: "on check", detail: "squeue -j 1 | grep -q DONE" });
    expect(conditionLabel({ kind: "file", path: "out.csv" }).tag).toBe("on file");
  });
});
