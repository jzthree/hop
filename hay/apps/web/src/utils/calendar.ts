import type { CheckbackTrigger } from "./checkbackText";

// The calendar's arithmetic: which days a week shows, and when something
// timed happens inside them. Repeats are expanded to every occurrence in
// range; one that repeats more often than every few hours is not a list of
// times but a band ("every 30m") across the days it runs.

const HOUR = 3_600_000, DAY = 86_400_000;
const PERIOD_MS: Record<string, number> = { MINUTELY: 60_000, HOURLY: HOUR, DAILY: DAY, WEEKLY: 7 * DAY };
// More often than this, the times would crowd the day out.
export const BAND_UNDER_MS = 3 * HOUR;
const CAP = 200;

export const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Local midnight `n` days after `t`'s (DST-safe: by the calendar, not by 24h). */
export const addDays = (t: number, n: number) => { const d = new Date(startOfDay(t)); d.setDate(d.getDate() + n); return d.getTime(); };
/** Seven local midnights from the day of `first`. */
export const weekDays = (first: number): number[] => Array.from({ length: 7 }, (_, i) => addDays(first, i));

const parseDtstart = (v: string): number | null => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  return z ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) : new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
};

type Rule = { start: number | null; step: number; count: number; hours: number[] | null; minute: number; until: number | null };
const parseRule = (rrule: string): Rule => {
  let start: number | null = null;
  const parts: Record<string, string> = {};
  for (const line of rrule.split(/\r?\n/)) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":");
    if (key === "DTSTART") start = parseDtstart(value);
    else for (const kv of (key === "RRULE" ? value : line).split(";")) {
      const [k, v] = kv.split("=");
      if (k && v !== undefined) parts[k.trim()] = v.trim();
    }
  }
  const freq = parts.FREQ || "";
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const hours = parts.BYHOUR !== undefined && (freq === "DAILY" || freq === "WEEKLY")
    ? parts.BYHOUR.split(",").map(Number).filter(Number.isFinite).sort((a, b) => a - b) : null;
  return {
    start, hours, minute: Number(parts.BYMINUTE) || 0, count: Number(parts.COUNT) || 0,
    step: PERIOD_MS[freq] ? PERIOD_MS[freq] * interval : 0,
    until: parts.UNTIL ? parseDtstart(parts.UNTIL) : null
  };
};

/** Occurrences in [from, to): exact times, or a band (with its period) when too frequent to list. */
export type Occurrences = { times: number[]; band: number | null };

export const rruleOccurrences = (rrule: string, from: number, to: number): Occurrences => {
  const r = parseRule(rrule);
  const end = r.until !== null ? Math.min(to, r.until + 1) : to;
  if (r.count === 1) return { times: r.start !== null && r.start >= from && r.start < end ? [r.start] : [], band: null };
  if (r.hours) {
    // Floating local times, these hours every day (WEEKLY: on DTSTART's weekday).
    if (r.hours.length > 24 * HOUR / BAND_UNDER_MS) return { times: [], band: end > from && (r.start === null || r.start < end) ? DAY / r.hours.length : null };
    const times: number[] = [];
    for (let day = startOfDay(from); day < end && times.length < CAP; day = addDays(day, 1)) {
      if (r.step === 7 * DAY && r.start !== null && new Date(day).getDay() !== new Date(r.start).getDay()) continue;
      for (const h of r.hours) {
        const d = new Date(day); d.setHours(h, r.minute, 0, 0);
        const t = d.getTime();
        if (t >= from && t < end && (r.start === null || t >= r.start)) times.push(t);
      }
    }
    return { times, band: null };
  }
  if (r.step) {
    if (r.step < BAND_UNDER_MS || r.start === null) return { times: [], band: end > from && (r.start === null || r.start < end) ? r.step : null };
    const times: number[] = [];
    let k = from <= r.start ? 0 : Math.ceil((from - r.start) / r.step);
    for (let t = r.start + k * r.step; t < end && times.length < CAP; t = r.start + (++k) * r.step) times.push(t);
    return { times, band: null };
  }
  return { times: r.start !== null && r.start >= from && r.start < end ? [r.start] : [], band: null };
};

export const triggerOccurrences = (t: CheckbackTrigger, from: number, to: number): Occurrences => {
  if (t.kind === "at") return { times: t.at >= from && t.at < to ? [t.at] : [], band: null };
  if (t.kind !== "every" || !(t.everyMs > 0)) return { times: [], band: null };
  const end = t.until ? Math.min(to, t.until + 1) : to;
  if (t.everyMs < BAND_UNDER_MS) return { times: [], band: t.next < end && end > from ? t.everyMs : null };
  const times: number[] = [];
  let k = from <= t.next ? 0 : Math.ceil((from - t.next) / t.everyMs);
  for (let at = t.next + k * t.everyMs; at < end && times.length < CAP; at = t.next + (++k) * t.everyMs) times.push(at);
  return { times, band: null };
};
