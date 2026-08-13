import { MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { relativeTime } from "../utils/switcherModel";

// Views: the results an agent hands a human that a terminal cannot draw — a
// PDF, a rendered write-up, a screenshot, a proxied dev server. The daemon has
// published them since `hop view` shipped, but the only way to reach one from
// this client was to catch the printed URL before it scrolled out of the
// viewport.
//
// The panel is a reading surface, not just an index: on a desk-sized window
// it is two panes, list and PREVIEW, and a plain click renders the result in
// place. The iframe is what makes that safe — navigating would tear down the
// WebSocket attached to the live terminal, and reading a result must never
// disconnect the session that produced it. Narrow windows keep the old
// contract (rows are anchors to a new tab), because a preview pane the width
// of a phone is worse than the browser's own viewer.

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
  // a visible flash and a round trip.
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

const isImage = (name: string) =>
  ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(
    (name.split(".").pop() || "").toLowerCase());

const formatBytes = (n?: number) => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const hrefFor = (item: ViewItem) =>
  item.kind === "server" && item.target ? item.target : item.path;

export const ViewsPanel = ({ session, sessions = [], onClose }: Props) => {
  const [items, setItems] = useState<ViewItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<ViewItem | null>(null);
  // Two-step delete, disarmed by leaving the row: a browser confirm() dialog
  // over a floating panel reads as a different app interrupting.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Frozen at open. The mark-seen effect below fires the moment the list
  // lands, so reading live storage during render would clear every "new" dot
  // in the same frame that exists to show them.
  const [seenAtOpen] = useState(loadViewsSeen);
  const listRef = useRef<HTMLDivElement | null>(null);
  const now = Date.now();

  // The preview pane only exists where it has room to be useful. Checked at
  // interaction time, not render time, so a resized window behaves like what
  // it currently is rather than what it was at open.
  const wideEnoughForPreview = () => window.innerWidth >= 760;

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

  const flatRows = useMemo(() => groups.flatMap(([, rows]) => rows), [groups]);

  // Escape backs OUT one layer — preview first, then the panel — and arrows
  // read the list like a mail client. Capture phase + stopPropagation: the
  // switcher listens for Escape on window too, and without this one press
  // closed the panel AND dismissed the wall behind it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (preview) setPreview(null);
        else onClose();
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && flatRows.length
          && wideEnoughForPreview()) {
        event.preventDefault();
        event.stopPropagation();
        const at = preview ? flatRows.findIndex((r) => r.path === preview.path) : -1;
        const next = event.key === "ArrowDown"
          ? Math.min(flatRows.length - 1, at + 1)
          : Math.max(0, at < 0 ? 0 : at - 1);
        setPreview(flatRows[next]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, preview, flatRows]);

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

  // Rows stay real anchors so ⌘-click, middle-click and "copy link address"
  // keep their browser meaning; only a PLAIN left click is intercepted, and
  // only where the preview pane exists to receive it.
  const onRowClick = (event: MouseEvent, item: ViewItem) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!wideEnoughForPreview()) return;   // narrow: the anchor's new tab is right
    event.preventDefault();
    setPreview(item);
  };

  const copyLink = (item: ViewItem) => {
    const url = location.origin + hrefFor(item);
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(item.path);
      window.setTimeout(() => setCopied((c) => (c === item.path ? null : c)), 1400);
    }).catch(() => { /* clipboard denied — the ↗ anchor still carries the URL */ });
  };

  const deleteItem = (item: ViewItem) => {
    if (armedDelete !== item.path) { setArmedDelete(item.path); return; }
    setArmedDelete(null);
    fetch("/api/views", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: item.session, name: item.name })
    }).then((r) => {
      if (!r.ok) return;
      setItems((cur) => (cur || []).filter((i) => i.path !== item.path));
      setPreview((p) => (p?.path === item.path ? null : p));
    }).catch(() => { /* row stays; nothing lied about being deleted */ });
  };

  const showPreview = preview !== null;

  return (
    <>
      <div className="views-backdrop" onClick={onClose} />
      <div className={"views-panel" + (showPreview ? " with-preview" : "")}
           role="dialog" aria-label="Published views">
        <div className="views-head">
          <span className="views-badge">◧ Views</span>
          {session && <span className="views-scope">{label(session)}</span>}
          <span className="views-head-spacer" />
          <button type="button" className="views-close" aria-label="Close views" onClick={onClose}>×</button>
        </div>
        <div className="views-body">
          <div className="views-list" ref={listRef}>
            {failed ? (
              <p className="views-empty">Couldn't reach the view index.</p>
            ) : !items ? (
              <p className="views-empty">Loading…</p>
            ) : groups.length === 0 ? (
              <div className="views-empty">
                <p>Nothing published yet. Agents hand over results a terminal
                can't draw — plots, PDFs, rendered write-ups, live dev servers —
                and they land here, grouped by the session that produced them.</p>
                <pre className="views-empty-cmds">{"hop view --title \"ROC curve\" plot.png\nhop port 5173"}</pre>
              </div>
            ) : (
              groups.map(([key, rows]) => (
                <div className="views-group" key={key}>
                  <div className="views-dateline">{label(key)}</div>
                  {rows.map((item) => {
                    const fresh = (item.mtime || 0) > (seenAtOpen[key] || 0);
                    const isServer = item.kind === "server";
                    const selected = preview?.path === item.path;
                    // A server has no meaningful size and its filename is an
                    // implementation detail (the redirect page) — it is a
                    // door, not a document, so say what it is instead.
                    const meta = isServer
                      ? "live server"
                      : [
                          // The filename is only worth a line of its own when
                          // the title isn't already showing it.
                          item.title ? item.name : "",
                          relativeTime((item.mtime || 0) * 1000, now),
                          formatBytes(item.bytes)
                        ].filter(Boolean).join(" · ");
                    return (
                      <a
                        key={item.path}
                        className={"views-row" + (fresh ? " fresh" : "")
                          + (isServer ? " server" : "") + (selected ? " selected" : "")}
                        href={hrefFor(item)}
                        target="_blank"
                        rel="noopener"
                        onClick={(e) => onRowClick(e, item)}
                        onMouseLeave={() => setArmedDelete((a) => (a === item.path ? null : a))}
                      >
                        {isImage(item.name)
                          // The file is its own thumbnail — one lazy request,
                          // and a list of plots becomes scannable at a glance.
                          ? <img className="views-thumb" src={item.path} loading="lazy" alt="" />
                          : <span className="views-kind" aria-hidden="true">{kindOf(item.name, item.kind)}</span>}
                        <span className="views-row-text">
                          <span className="views-title">{item.title || item.name}</span>
                          {meta && <span className="views-meta">{meta}</span>}
                        </span>
                        {fresh && <span className="views-dot" aria-label="New" />}
                        <span className="views-acts" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                          {/* A button, not an <a>: anchors cannot nest, and
                              the row itself is already the real link. */}
                          <button type="button" className="views-act"
                                  title="Open in a new tab" aria-label="Open in a new tab"
                                  onClick={() => window.open(hrefFor(item), "_blank", "noopener")}>↗</button>
                          <button type="button" className="views-act"
                                  title={copied === item.path ? "Copied" : "Copy link"}
                                  aria-label="Copy link"
                                  onClick={() => copyLink(item)}>{copied === item.path ? "✓" : "⧉"}</button>
                          {!isServer && (
                            <button type="button"
                                    className={"views-act danger" + (armedDelete === item.path ? " armed" : "")}
                                    title={armedDelete === item.path ? "Click again to delete" : "Delete"}
                                    aria-label={armedDelete === item.path ? "Click again to delete" : "Delete"}
                                    onClick={() => deleteItem(item)}>
                              {armedDelete === item.path ? "sure?" : "🗑"}
                            </button>
                          )}
                        </span>
                      </a>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          {showPreview && (
            <div className="views-preview">
              <div className="views-preview-head">
                <span className="views-preview-title" title={preview.title || preview.name}>
                  {preview.title || preview.name}
                </span>
                <span className="views-head-spacer" />
                <a className="views-act" href={hrefFor(preview)} target="_blank" rel="noopener"
                   title="Open in a new tab" aria-label="Open preview in a new tab">↗</a>
                <button type="button" className="views-act" aria-label="Close preview"
                        onClick={() => setPreview(null)}>×</button>
              </div>
              {/* Sandboxed only for LIVE servers: an arbitrary dev app must not
                  be able to navigate the wall out from under its own terminal
                  (frame-busting). Our own files skip the sandbox, because a
                  sandboxed iframe disables the browser's PDF viewer. */}
              <iframe
                className="views-frame"
                key={preview.path}
                src={hrefFor(preview)}
                title={preview.title || preview.name}
                sandbox={preview.kind === "server"
                  ? "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
                  : undefined}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
};
