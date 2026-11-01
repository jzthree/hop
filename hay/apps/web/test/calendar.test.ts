import { describe, expect, it } from "vitest";
import { addDays, rruleOccurrences, startOfDay, triggerOccurrences, weekDays } from "../src/utils/calendar";

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime(); // Nov 2026, local

describe("calendar", () => {
  it("a week is seven local midnights", () => {
    const w = weekDays(at(1, 15));
    expect(w).toHaveLength(7);
    expect(w[0]).toBe(startOfDay(at(1, 15)));
    expect(new Date(w[6]).getDate()).toBe(7);
    expect(addDays(at(1, 0), 1)).toBe(at(2, 0));
  });

  it("hop: a one-off on its day; a slow repeat as its times; a fast one as a band", () => {
    expect(triggerOccurrences({ kind: "at", at: at(3, 9) }, at(3, 0), at(4, 0)).times).toEqual([at(3, 9)]);
    expect(triggerOccurrences({ kind: "at", at: at(3, 9) }, at(4, 0), at(5, 0)).times).toEqual([]);
    const sixHourly = triggerOccurrences({ kind: "every", everyMs: 6 * 3_600_000, next: at(2, 3) }, at(2, 0), at(3, 0));
    expect(sixHourly.times).toEqual([at(2, 3), at(2, 9), at(2, 15), at(2, 21)]);
    const fast = { kind: "every" as const, everyMs: 30 * 60_000, next: at(2, 12), until: at(3, 12) };
    expect(triggerOccurrences(fast, at(1, 0), at(2, 0)).band).toBeNull(); // not started
    expect(triggerOccurrences(fast, at(2, 0), at(3, 0)).band).toBe(30 * 60_000);
    expect(triggerOccurrences(fast, at(4, 0), at(5, 0)).band).toBeNull(); // over
  });

  it("Codex: daily hours on every day, a one-shot once, a fast interval as a band", () => {
    expect(rruleOccurrences("FREQ=DAILY;BYHOUR=9,17;BYMINUTE=30", at(5, 0), at(6, 0)).times).toEqual([at(5, 9, 30), at(5, 17, 30)]);
    const one = rruleOccurrences("DTSTART:20261103T100000\nRRULE:FREQ=DAILY;COUNT=1", at(1, 0), at(8, 0));
    expect(one.times).toEqual([at(3, 10)]);
    expect(rruleOccurrences("FREQ=MINUTELY;INTERVAL=15", at(1, 0), at(2, 0))).toEqual({ times: [], band: 15 * 60_000 });
  });
});
