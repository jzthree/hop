import { useEffect, useMemo, useState } from "react";
import { relativeTime } from "../utils/switcherModel";

// Views: the results an agent hands a human that a terminal cannot draw — a
// PDF, a rendered write-up, a screenshot, a proxied dev server. The daemon has
// published them since `hop view` shipped, but the only way to reach one from
// this client was to catch the printed URL before it scrolled out of the
// viewport. This panel is the index that was missing: one fetch of the
// manifest the daemon already maintains, grouped by session, newest first.

type ViewItem = {
  // The session's internalName — the same key /api/sessions reports views
  // under, so seen-markers written here line up with the switcher's counts.
  session: string;
  name: string;
  title?: string;
  path: string;
  bytes?: number;
  // Epoch SECONDS (the manifest stores unix time, not ms).
  mtime?: number;
  // "server" is a LIVE proxied localhost server (`hop port`), not a stored
  // file: it stops working when the server does, which a file never does.
  kind?: "file" | "server";
  // For a server, the proxy itself. The manifest scan can only see the
  // redirect page `hop port` leaves behind; going straight to the proxy skips
  // a visible flash and a round trip on a phone link.
  target?: string;
};

type Props = {
  // Scope to one session — set when opened from that session's own affordance.
  // Absent means the whole fleet, which is the default reading.
  session?: string;
  // Only used to translate internalName into the name the user renamed it to;
  // the manifest has no idea a session was ever renamed.
  sessions?: { name: string; displayName?: string; internalName?: string }[];
  onClose: () => void;
};

// Per-session high-water mark: the newest mtime this browser has looked at.
const SEEN_KEY = "hop_views_seen";

export const loadViewsSeen = (): Record<string, number> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, number>;
  } catch { return {}; }  // private mode, or a half-written value
};

const saveViewsSeen = (seen: Record<string, number>) => {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* private mode */ }
};

/**
 * Whether a session has published something since this browser last looked.
 * A session with no marker at all counts as unseen — a first-time reader HAS
 * results waiting, and silently baselining them would hide the whole feature
 * behind an affordance that never lights up.
 */
export const hasUnseenViews = (
  key: string,
  latestAt: number | undefined,
  seen: Record<string, number>
) => (latestAt || 0) > (seen[key] || 0);

// A short type tag instead of an emoji: this sits at ~9px on a phone, and
// emoji coverage for document glyphs differs enough between iOS and Android
// that the column stops lining up. The tag also survives a monospace column.
const kindOf = (name: string, kind?: string) => {
  if (kind === "server") return "LIVE";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["csv", "tsv"].includes(ext)) return "TBL";
  if (["mp3", "m4a", "wav", "flac", "aac", "ogg", "opus"].includes(ext)) return "AUD";
  if (ext === "pdf") return "PDF";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) return "IMG";
  if (["mp4", "mov", "webm"].includes(ext)) return "VID";
  if (["md", "markdown"].includes(ext)) return "MD";
  if (["html", "htm"].includes(ext)) return "WEB";
  if (["txt", "log", "json", "csv"].includes(ext)) return "TXT";
  return "FILE";
};

const formatBytes = (n?: number) => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export const ViewsPanel = ({ session, sessions = [], onClose }: Props) => {
  const [items, setItems] = useState<ViewItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Frozen at open. The mark-seen effect below fires the moment the list
  // lands, so reading live storage during render would clear every "new" dot
  // in the same frame that exists to show them.
  const [seenAtOpen] = useState(loadViewsSeen);
  const now = Date.now();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/views", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { items?: ViewItem[] }) => {
        if (!cancelled) setItems(Array.isArray(d?.items) ? d.items : []);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  // Capture phase + stopPropagation: the switcher listens for Escape on window
  // too, so without this one press closed the panel AND dismissed the wall
  // behind it, dumping the reader into a terminal they never asked for.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const groups = useMemo(() => {
    // The daemon folds case when a name addresses a session; match it here so
    // a scoped open from a differently-cased key still finds its rows.
    const scope = session?.toLowerCase();
    const by = new Map<string, ViewItem[]>();
    // /api/views is already newest-first, so plain insertion order gives both
    // newest-first rows inside a session and newest-first sessions.
    for (const item of items || []) {
      if (!item?.path || !item?.name) continue;
      const key = String(item.session || "");
      if (scope && key.toLowerCase() !== scope) continue;
      const rows = by.get(key);
      if (rows) rows.push(item);
      else by.set(key, [item]);
    }
    return [...by.entries()];
  }, [items, session]);

  // Opening the panel IS the act of seeing what it shows.
  useEffect(() => {
    if (!items) return;
    const seen = loadViewsSeen();
    let dirty = false;
    for (const [key, rows] of groups) {
      const newest = rows[0]?.mtime || 0;
      if (newest > (seen[key] || 0)) { seen[key] = newest; dirty = true; }
    }
    // Only a fleet-wide open knows the full population. Pruning from a scoped
    // open would delete every other session's marker, and their long-read
    // views would announce themselves as new all over again.
    if (!session) {
      const live = new Set(groups.map(([key]) => key));
      for (const key of Object.keys(seen)) {
        if (!live.has(key)) { delete seen[key]; dirty = true; }
      }
    }
    if (dirty) saveViewsSeen(seen);
  }, [items, groups, session]);

  const label = (internalName: string) => {
    const hit = sessions.find((s) => (s.internalName || s.name) === internalName)
      || sessions.find((s) => (s.internalName || s.name).toLowerCase() === internalName.toLowerCase());
    return hit ? (hit.displayName || hit.name) : internalName;
  };

  return (
    <>
      <div className="views-backdrop" onClick={onClose} />
      <div className="views-panel" role="dialog" aria-label="Published views">
        <div className="views-head">
          <span className="views-badge">◧ Views</span>
          {session && <span className="views-scope">{label(session)}</span>}
          <span className="views-head-spacer" />
          <button type="button" className="views-close" aria-label="Close views" onClick={onClose}>×</button>
        </div>
        {failed ? (
          <p className="views-empty">Couldn't reach the view index.</p>
        ) : !items ? (
          <p className="views-empty">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="views-empty">
            Nothing published yet — agents publish results with <code>hop view &lt;file&gt;</code>.
            PDFs, images, HTML and markdown write-ups land here instead of scrolling
            past as text.
          </p>
        ) : (
          <div className="views-list">
            {groups.map(([key, rows]) => (
              <div className="views-group" key={key}>
                <div className="views-dateline">{label(key)}</div>
                {rows.map((item) => {
                  const fresh = (item.mtime || 0) > (seenAtOpen[key] || 0);
                  const isServer = item.kind === "server";
                  // A server has no meaningful size and its filename is an
                  // implementation detail (the redirect page) — it is a door,
                  // not a document, so say what it is instead.
                  const meta = isServer
                    ? "live server · opens the running app"
                    : [
                        // The filename is only worth a line of its own when
                        // the title isn't already showing it.
                        item.title ? item.name : "",
                        relativeTime((item.mtime || 0) * 1000, now),
                        formatBytes(item.bytes)
                      ].filter(Boolean).join(" · ");
                  return (
                    // A real anchor to a new tab, not an in-app overlay or a
                    // button: these are PDFs, videos and whole HTML pages, and
                    // the browser's own viewers already do zoom/scrub/print far
                    // better than an iframe would. Decisively, navigating in
                    // place would tear down the WebSocket attached to the live
                    // terminal — reading a result must not disconnect the
                    // session that produced it. The tunnel_session cookie is
                    // same-origin, so the new tab authenticates itself, and
                    // being an anchor keeps ⌘-click and "copy link" working.
                    <a
                      key={item.path}
                      className={"views-row" + (fresh ? " fresh" : "") + (isServer ? " server" : "")}
                      href={isServer && item.target ? item.target : item.path}
                      target="_blank"
                      rel="noopener"
                    >
                      <span className="views-kind" aria-hidden="true">{kindOf(item.name, item.kind)}</span>
                      <span className="views-row-text">
                        <span className="views-title">{item.title || item.name}</span>
                        {meta && <span className="views-meta">{meta}</span>}
                      </span>
                      {fresh && <span className="views-dot" aria-label="New" />}
                    </a>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
};
