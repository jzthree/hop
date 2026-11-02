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
