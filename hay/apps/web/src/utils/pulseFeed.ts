import { useCallback, useEffect, useState } from "react";

// mybot's pulse, for its place in the sidebar: pulse.json, written by mybot
// on the host into the directory the daemon serves under /assets/ — beside
// the briefing — and read the way the iOS app reads it. The briefing says
// what the fleet needs from you; the pulse brings ideas and the things that
// slipped through the cracks. One pulse per engine (Claude, GPT) per day,
// today's first, then up to two weeks of history.

export type PulseSection = { id: string; kind: string; title: string; body: string };
export type PulseAction = {
  id: string;
  label: string;
  cwd: string;
  sessionName: string;
  command: string;
  // The live session that already owns the item: a one-line message there
  // is preferred to a new agent.
  targetInternalName?: string;
  targetName?: string;
  message?: string;
};
export type Pulse = { engine: string; label: string; date: string; title: string; sections: PulseSection[]; actions: Record<string, PulseAction> };
export type PulseDay = { date: string; pulses: Pulse[] };
export type PulseFeed = { generatedAt: string; days: PulseDay[]; discussUrl?: string };

const SEEN_KEY = "hop_pulse_seen";   // the newest day this browser has opened
const POLL_MS = 10 * 60 * 1000;

type Raw = Record<string, unknown>;
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);

const parsePulses = (raw: unknown): Pulse[] =>
  (Array.isArray(raw) ? raw : []).flatMap((p: Raw) => {
    const engine = str(p?.engine), date = str(p?.date);
    if (!engine || !date) return [];
    const sections = (Array.isArray(p.sections) ? p.sections : []).map((s: Raw, i: number) => ({
      id: str(s?.id, `s${i}`), kind: str(s?.kind, "note"), title: str(s?.title), body: str(s?.body)
    }));
    const actions: Record<string, PulseAction> = {};
    for (const a of (Array.isArray(p.actions) ? p.actions : []) as Raw[]) {
      const id = str(a?.id), sessionName = str(a?.session_name), command = str(a?.command);
      if (!id || !sessionName || !command) continue;
      actions[id] = {
        id, sessionName, command, label: str(a.label, "Follow up"), cwd: str(a.cwd),
        targetInternalName: str(a.target_internal_name) || undefined, targetName: str(a.target_name) || undefined,
        message: str(a.message) || undefined
      };
    }
    return [{ engine, date, label: str(p.label, engine), title: str(p.title, "Pulse"), sections, actions }];
  });

/** pulse.json as days, newest first; null when there is no pulse. */
export const parsePulseFeed = (json: unknown): PulseFeed | null => {
  const j = (json || {}) as Raw;
  const today = parsePulses(j.pulses);
  if (!today.length) return null;
  const days: PulseDay[] = [{ date: today[0].date, pulses: today }];
  for (const d of (Array.isArray(j.history) ? j.history : []) as Raw[]) {
    const pulses = parsePulses(d?.pulses);
    if (str(d?.date) && pulses.length) days.push({ date: str(d.date), pulses });
  }
  return { generatedAt: str(j.generated_at), days, discussUrl: str(j.discuss_url) || undefined };
};

/** "Today", "Yesterday", or "Mon, Oct 12" for a yyyy-mm-dd day. */
export const dayLabel = (day: string, now = new Date()): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((start - d.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
};

export const usePulse = () => {
  const [feed, setFeed] = useState<PulseFeed | null>(null);
  const [seenDay, setSeenDay] = useState<string>(() => { try { return localStorage.getItem(SEEN_KEY) || ""; } catch { return ""; } });
  const load = useCallback(() => {
    fetch("/assets/pulse.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setFeed(parsePulseFeed(j)))
      .catch(() => { /* keep what we have */ });
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, POLL_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);
  const newest = feed?.days[0]?.date || "";
  const markSeen = useCallback(() => {
    if (!newest) return;
    setSeenDay(newest);
    try { localStorage.setItem(SEEN_KEY, newest); } catch { /* per-browser only */ }
  }, [newest]);
  return { feed, fresh: !!newest && newest !== seenDay, markSeen, reload: load };
};

export type PulseItem = { date: string; pulse: Pulse; section: PulseSection; action: PulseAction };

/** A session's share of the pulse, newest day first: the items whose
 *  follow-up goes to it (it owns the item) or is it (an earlier follow-up).
 *  `isSession` says whether a session identifier names the session. */
export const pulseItemsFor = (feed: PulseFeed | null, isSession: (id: string) => boolean): PulseItem[] => {
  const out: PulseItem[] = [];
  for (const day of feed?.days || []) for (const pulse of day.pulses) for (const section of pulse.sections) {
    const action = pulse.actions[section.id];
    if (!action) continue;
    if ([action.targetInternalName, action.targetName, action.sessionName].some((n) => n && isSession(n))) {
      out.push({ date: day.date, pulse, section, action });
    }
  }
  return out;
};
