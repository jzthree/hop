import { useCallback, useEffect, useState } from "react";

// The briefing's data, for its place in the sidebar and its page: the
// editions the host agent writes beside the web build (digest-archive.json,
// newest first, with digest.json as the fallback before an archive exists),
// and the daemon's read union across devices (/api/digest/reads). Polled
// gently and on return to the tab; absent files are the normal state before
// the first edition, not an error.

export type BriefingItem = {
  session: string;
  headline: string;
  why?: string;
  urgency?: string;
  slot?: "decide" | "watch" | "done" | "also";
  recommendation?: string;
  replies?: string[];
};
export type Edition = { generated_at?: string; summary?: string; items?: BriefingItem[] };

const SEEN_KEY = "hop_digest_seen_v2";   // shared with the wall's card
const SEEN_CAP = 200;
const POLL_MS = 3 * 60 * 1000;

const loadSeen = (): Set<string> => {
  try {
    const arr = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
};
const saveSeen = (set: Set<string>) => {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-SEEN_CAP))); } catch { /* per-browser only */ }
};

/** Editions newest first: the archive, with a newer digest.json in front of it. */
export const mergeEditions = (archive: { editions?: Edition[] } | null, latest: Edition | null): Edition[] => {
  let list: Edition[] = Array.isArray(archive?.editions) ? archive!.editions! : [];
  if (latest?.summary && (!list.length || list[0]?.generated_at !== latest.generated_at)) list = [latest, ...list];
  return list.filter((e) => e && e.summary);
};

/** "edition|session" keys read or acted on anywhere — a glimpse doesn't count. */
export const readKeys = (reads: Record<string, { level?: string }> | undefined): Set<string> =>
  new Set(Object.entries(reads || {}).filter(([, r]) => r?.level === "read" || r?.level === "acted").map(([k]) => k));

/** Stories in the newest edition that still want a decision and nobody has read. */
export const unreadDecisions = (editions: Edition[], read: Set<string>): number => {
  const ed = editions[0];
  if (!ed?.generated_at) return 0;
  return (ed.items || []).filter((it) => (it.slot === "decide" || (!it.slot && it.urgency === "needs-you"))
    && !read.has(ed.generated_at + "|" + it.session)).length;
};

export const useBriefing = () => {
  const [editions, setEditions] = useState<Edition[]>([]);
  const [read, setRead] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState<Set<string>>(loadSeen);

  const load = useCallback(() => {
    Promise.all([
      fetch("/assets/digest-archive.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/assets/digest.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/digest/reads", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    ]).then(([archive, latest, reads]) => {
      setEditions(mergeEditions(archive, latest));
      if (reads?.reads) setRead(readKeys(reads.reads));
      const elsewhere: string[] = Array.isArray(reads?.editionsSeen) ? reads.editionsSeen : [];
      if (elsewhere.length) setSeen((prev) => { const next = new Set(prev); elsewhere.forEach((x) => next.add(x)); saveSeen(next); return next; });
    });
  }, []);

  useEffect(() => {
    load();
    const t = window.setInterval(load, POLL_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  const markSeen = useCallback((stamp?: string) => {
    if (!stamp) return;
    setSeen((prev) => { if (prev.has(stamp)) return prev; const next = new Set(prev).add(stamp); saveSeen(next); return next; });
  }, []);
  const markRead = useCallback((edition: string, session: string) => {
    setRead((prev) => new Set(prev).add(edition + "|" + session));
  }, []);

  const latestUnseen = !!editions[0]?.generated_at && !seen.has(editions[0].generated_at!);
  return { editions, read, seen, markSeen, markRead, reload: load, decisions: unreadDecisions(editions, read), latestUnseen };
};

/** A session's thread: every story about it, newest edition first, with the
 *  edition it ran in. `isSession` says whether a story's session names it. */
export const threadFor = (editions: Edition[], isSession: (id: string) => boolean): Array<BriefingItem & { at: string }> => {
  const out: Array<BriefingItem & { at: string }> = [];
  for (const e of editions) for (const it of e.items || []) {
    if (it.session && isSession(it.session)) out.push({ ...it, at: e.generated_at || "" });
  }
  return out;
};

type Named = { name: string; displayName?: string; internalName?: string };
/** Old name → the reader's name now: ids and born-with names a session has
 *  outgrown, skipping any that is another session's current name. */
export const currentNames = (sessions: Named[]): Map<string, string> => {
  const shown = new Set(sessions.map((s) => s.displayName || s.name).filter(Boolean));
  const map = new Map<string, string>();
  for (const s of sessions) {
    const now = s.displayName || s.name;
    if (!now) continue;
    for (const old of [s.internalName, s.name]) if (old && old !== now && !shown.has(old)) map.set(old, now);
  }
  return map;
};
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A briefing's prose with sessions called what the reader calls them now. */
export const renamer = (names: Map<string, string>) => {
  if (!names.size) return (t?: string) => t || "";
  const re = new RegExp(`(?<![\\w-])(${[...names.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![\\w-])`, "g");
  return (t?: string) => (t ? t.replace(re, (m) => names.get(m) ?? m) : "");
};
