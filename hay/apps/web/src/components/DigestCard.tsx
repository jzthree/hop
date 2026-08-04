import { useEffect, useState } from "react";
import type { SwitcherSession } from "../utils/switcherModel";

// The briefing, on the desktop wall — the same digest.json the iOS app
// renders, written by the host-side agent (hop-ios tools/digest.mjs) into the
// directory the daemon serves under /assets/. This card is deliberately
// self-contained: one fetch, localStorage for dismissed/read state, no new
// endpoints, and the same reading contract as the phone — the summary is the
// headline, every story shows in full under its session DATELINE, unread
// stories carry a dot that opening clears.

type DigestItem = {
  session: string;
  headline: string;
  why?: string;
  urgency?: string;
};

type Digest = {
  generated_at?: string;
  summary?: string;
  items?: DigestItem[];
};

const READ_KEY = "hop_digest_read";        // "<stamp>|a,b,c" — self-pruning
const DISMISS_KEY = "hop_digest_dismissed"; // "<stamp>"

const readSet = (stamp: string): Set<string> => {
  try {
    const raw = localStorage.getItem(READ_KEY) || "";
    const [s, list] = raw.split("|");
    if (s !== stamp || !list) return new Set();
    return new Set(list.split(",").filter(Boolean));
  } catch { return new Set(); }
};

const urgencyClass = (u?: string) =>
  u === "needs-you" ? "needs" : u === "blocked" ? "blocked" : u === "finished" ? "done" : "fyi";

export const DigestCard = ({ sessions, onOpen }: {
  sessions: SwitcherSession[];
  onOpen: (session: SwitcherSession) => void;
}) => {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) || ""; } catch { return ""; }
  });
  const [read, setRead] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/assets/digest.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: Digest | null) => {
          if (cancelled || !d?.summary) return;
          setDigest(d);
          setRead(readSet(d.generated_at || ""));
        })
        .catch(() => { /* absent is the normal state until the job runs */ });
    };
    load();
    // A briefing written while this tab sat open should appear on return.
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVis); };
  }, []);

  if (!digest?.summary) return null;
  const stamp = digest.generated_at || "";
  if (dismissed === stamp) return null;
  const items = digest.items || [];

  const markRead = (session: string) => {
    const next = new Set(read);
    next.add(session);
    setRead(next);
    try { localStorage.setItem(READ_KEY, stamp + "|" + [...next].sort().join(",")); } catch { /* private mode */ }
  };

  // The daemon folds case when a name addresses a session; match it.
  const find = (internalName: string) =>
    sessions.find((s) => (s.internalName || s.name) === internalName)
      || sessions.find((s) => (s.internalName || s.name).toLowerCase() === internalName.toLowerCase());

  return (
    <div className="digest-card">
      <div className="digest-head">
        <span className="digest-badge">✦ Briefing</span>
        <button className="digest-dismiss" title="Dismiss briefing"
          onClick={() => { setDismissed(stamp); try { localStorage.setItem(DISMISS_KEY, stamp); } catch { /* ok */ } }}>
          ×
        </button>
      </div>
      <div className="digest-summary">{digest.summary}</div>
      {items.map((item) => {
        const target = find(item.session);
        const name = target ? (target.displayName || target.name) : item.session;
        return (
          <button
            key={item.session + item.headline}
            className={"digest-item " + urgencyClass(item.urgency) + (read.has(item.session) ? " read" : "")}
            onClick={() => {
              markRead(item.session);
              if (target) onOpen(target);
            }}
          >
            <span className="digest-dateline">
              {!read.has(item.session) && <span className="digest-dot" />}
              {name}
            </span>
            <span className="digest-headline">{item.headline}</span>
            {item.why ? <span className="digest-why">{item.why}</span> : null}
          </button>
        );
      })}
    </div>
  );
};
