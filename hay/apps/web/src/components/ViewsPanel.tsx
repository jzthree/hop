import React, { MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { relativeTime } from "../utils/switcherModel";

// Views: the results an agent hands a human that a terminal cannot draw — a
// plot, a PDF, a rendered write-up, a live dev server.
//
// A GALLERY, then a READER. Results are mostly visual, and a list of 500
// filenames hid that: the gallery shows them as cards — figures as their own
// thumbnails, documents as typographic cards — grouped by day, the way a lab
// notebook reads. Filters by kind and a search narrow it; a session's own
// Views open filtered to that session (with "all" one click away). Opening a
// card fills the panel with the result: ‹ › and ← → step through what the
// filters show, a filmstrip of the neighbours runs along the bottom, Esc
// goes back to the gallery. Opened straight on one result (a link in a
// terminal, an inline card) Esc closes instead: there was no gallery before.
//
// Three placements of that one shape:
//
// - PAGE (beside the docked sidebar): Views is a place, like the wall, and
//   it shares the sidebar with Sessions — one selection, two places. The
//   session selected there is the filter (no toggle of Views' own), and
//   clearing it shows every session's results. A session's results — a
//   link in its terminal, an inline card, ⌘⇧V — are this page filtered to
//   it.
// - SIDE (an option, beside a session): a column to the right of the
//   terminal, its width dragged at its edge. Side by side, not over: the
//   terminal gives up the width and refits. Its keys are its own only once
//   you are in it — Esc and the arrows are the shell's otherwise.
// - MODAL where there is no sidebar.
//
// Results read in place (an iframe, or native media): navigating would tear
// down the terminal's WebSocket. A new tab is always a choice — ↗, ⌘-click,
// middle click — never the only way to see a result.

type ViewItem = {
  // The session's internalName — the key /api/sessions reports views under,
  // so seen-markers written here line up with the switcher's counts.
  session: string;
  name: string;
  title?: string;
  path: string;
  bytes?: number;
  // Epoch SECONDS (the manifest stores unix time, not ms).
  mtime?: number;
  // "server" is a LIVE proxied localhost server (`hop port`), not a stored
  // file; "link" points at another app (a Nebula notebook) at `target`.
  kind?: "file" | "server" | "link";
  app?: string;
  target?: string;
};

type Props = {
  // Scope to one session — set when opened from that session's own affordance.
  session?: string;
  // Translates internalName into the name the user renamed it to.
  sessions?: { name: string; displayName?: string; internalName?: string }[];
  // Where the reader sits (see above).
  placement?: "modal" | "page" | "side";
  // Switch between full page and side by side (offered beside a session).
  onToggleSide?: () => void;
  // Side by side: drag the column's edge (a width), double-click (null).
  onResizeSide?: (width: number | null) => void;
  // Open straight on this result (its file name within `session`).
  item?: string;
  // Scoped as a page (a session picked in the sidebar): go into it.
  onOpenSession?: (session: string) => void;
  // As a page, the sidebar's selection is the scope: this clears it.
  onClearSession?: () => void;
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
 * A session with no marker counts as unseen — a first-time reader HAS results
 * waiting, and silently baselining them would hide the feature.
 */
export const hasUnseenViews = (
  key: string,
  latestAt: number | undefined,
  seen: Record<string, number>
) => (latestAt || 0) > (seen[key] || 0);

const extOf = (name: string) => (name.split(".").pop() || "").toLowerCase();
const isImage = (name: string) => ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extOf(name));
const isVideo = (name: string) => ["mp4", "mov", "webm", "m4v", "ogv"].includes(extOf(name));
const isAudio = (name: string) => ["mp3", "m4a", "wav", "flac", "aac", "ogg", "oga", "opus"].includes(extOf(name));
// Kinds the daemon renders into a full HTML page — the only ones where a
// theme exists to pass.
const isRendered = (name: string) => ["md", "markdown", "csv", "tsv", "json"].includes(extOf(name));

// A short type tag: emoji coverage for document glyphs differs too much
// between platforms, and the tag survives a monospace column.
const kindTag = (item: ViewItem) => {
  if (item.kind === "server") return "LIVE";
  if (item.kind === "link") return "NB";
  const ext = extOf(item.name);
  if (["csv", "tsv"].includes(ext)) return "TBL";
  if (isAudio(item.name)) return "AUD";
  if (ext === "pdf") return "PDF";
  if (isImage(item.name) || ext === "ico") return "IMG";
  if (isVideo(item.name)) return "VID";
  if (["md", "markdown"].includes(ext)) return "MD";
  if (["html", "htm"].includes(ext)) return "WEB";
  if (["txt", "log", "json"].includes(ext)) return "TXT";
  return "FILE";
};

export type ViewFilter = "all" | "figures" | "docs" | "pages" | "live";
export const filterOf = (item: { name: string; kind?: string }): Exclude<ViewFilter, "all"> => {
  if (item.kind === "server" || item.kind === "link") return "live";
  const ext = extOf(item.name);
  if (isImage(item.name) || isVideo(item.name) || isAudio(item.name)) return "figures";
  if (ext === "html" || ext === "htm") return "pages";
  return "docs";
};
const FILTERS: Array<[ViewFilter, string]> = [["all", "All"], ["figures", "Figures"], ["docs", "Docs"], ["pages", "Pages"], ["live", "Live"]];

/** The day a result belongs to, as a notebook would head it. */
export const dayLabel = (mtimeSec: number, now = Date.now()): string => {
  const d = new Date(mtimeSec * 1000);
  const start = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((start(new Date(now)) - start(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "long", day: "numeric" } : { month: "long", day: "numeric", year: "numeric" });
};

const formatBytes = (n?: number) => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const hrefFor = (item: ViewItem) =>
  (item.kind === "server" || item.kind === "link") && item.target ? item.target : item.path;

// The stored file itself, as an attachment (the markdown an agent wrote, not
// the page it renders into). Only files — a server has nothing to save.
const downloadHrefFor = (item: ViewItem) =>
  item.kind === "server" || item.kind === "link" ? null : item.path.replace(/\/inline$/, "") + "/download";

// A hidden same-origin anchor with `download`: window.open would show the
// file, not save it, and cards are anchors already (anchors cannot nest).
const triggerDownload = (item: ViewItem) => {
  const href = downloadHrefFor(item);
  if (!href) return;
  const a = document.createElement("a");
  a.href = href;
  a.download = item.name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
};

// The wall's theme is a USER CHOICE (data-theme on the root); only "system"
// defers to the OS. The rendered document inside the iframe follows it.
const pageTheme = (): "light" | "dark" => {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "light" || t === "dark") return t;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const previewSrc = (item: ViewItem) =>
  isRendered(item.name) && item.kind !== "server"
    ? `${item.path}?theme=${pageTheme()}`
    : hrefFor(item);

const thumbSrc = (item: ViewItem) => item.path.replace(/\/inline$/, "/thumb");

export const ViewsPanel = ({ session, item, sessions = [], placement, onOpenSession, onClearSession, onToggleSide, onResizeSide, onClose }: Props) => {
  const [items, setItems] = useState<ViewItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The result being read; null is the gallery.
  const [open, setOpen] = useState<ViewItem | null>(null);
  // Opened straight on a result: Esc closes rather than "going back".
  const [direct, setDirect] = useState(!!item);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState<ViewFilter>("all");
  const [query, setQuery] = useState("");
  // The keyboard's place in the gallery.
  const [sel, setSel] = useState(0);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [armedClear, setArmedClear] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Frozen at open: the mark-seen effect fires as soon as the list lands,
  // and reading live storage during render would clear every "new" dot in
  // the frame that exists to show them.
  const [seenAtOpen] = useState(loadViewsSeen);
  const asPage = placement === "page";
  const asSide = placement === "side";
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const now = Date.now();

  // The scope arrives as whatever identifier the opener had (a display name
  // from the URL, an internalName from the wall); the manifest keys by
  // internalName, so resolve through the sessions list.
  const resolvedSession = useMemo(() => {
    if (!session) return undefined;
    const lc = session.toLowerCase();
    const hit = sessions.find((s) =>
      (s.internalName || "").toLowerCase() === lc
      || (s.name || "").toLowerCase() === lc
      || (s.displayName || "").toLowerCase() === lc);
    return hit?.internalName || session;
  }, [session, sessions]);
  const effectiveScope = showAll ? undefined : resolvedSession;
  // A new scope from outside (another session picked in the sidebar): its
  // results, from the gallery, with any "all" widening undone.
  const firstScope = useRef(session);
  useEffect(() => {
    if (firstScope.current === session) return;
    firstScope.current = session;
    setShowAll(false);
    setOpen(null);
    setDirect(false);
    setQuery("");
  }, [session]);

  const label = (internalName: string) => {
    const hit = sessions.find((s) => (s.internalName || s.name) === internalName)
      || sessions.find((s) => (s.internalName || s.name).toLowerCase() === internalName.toLowerCase());
    return hit ? (hit.displayName || hit.name) : internalName;
  };

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

  // Take focus once so the keyboard works at once (Esc, arrows): the page
  // and the modal sit over a terminal that had it.
  useEffect(() => { panelRef.current?.focus(); }, []);

  // In scope: newest first (the manifest's own order).
  const scoped = useMemo(() => {
    const scope = effectiveScope?.toLowerCase();
    return (items || []).filter((i) => i?.path && i?.name
      && (!scope || String(i.session || "").toLowerCase() === scope));
  }, [items, effectiveScope]);

  const counts = useMemo(() => {
    const c: Record<ViewFilter, number> = { all: scoped.length, figures: 0, docs: 0, pages: 0, live: 0 };
    for (const i of scoped) c[filterOf(i)] += 1;
    return c;
  }, [scoped]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scoped.filter((i) => (filter === "all" || filterOf(i) === filter)
      && (!q || (i.title || "").toLowerCase().includes(q) || i.name.toLowerCase().includes(q)
        || label(i.session).toLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, filter, query, sessions]);

  const days = useMemo(() => {
    const out: Array<{ day: string; rows: ViewItem[] }> = [];
    for (const i of shown) {
      const day = dayLabel(i.mtime || 0, now);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(i);
      else out.push({ day, rows: [i] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  useEffect(() => { setSel(0); }, [filter, query, effectiveScope]);

  // Opened on one result: read it as soon as the index lands.
  useEffect(() => {
    if (!items || !item || open) return;
    const asked = scoped.find((r) => r.name === item);
    if (asked) setOpen(asked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  // A result that disappears (deleted, filtered away) closes the reader.
  useEffect(() => {
    if (open && items && !items.some((r) => r.path === open.path)) setOpen(null);
  }, [items, open]);

  const at = open ? shown.findIndex((r) => r.path === open.path) : -1;
  const step = (dir: 1 | -1) => {
    if (!shown.length) return;
    const next = at < 0 ? 0 : Math.min(shown.length - 1, Math.max(0, at + dir));
    setOpen(shown[next]);
  };
  const backToGallery = () => {
    if (open) setSel(Math.max(0, shown.findIndex((r) => r.path === open.path)));
    setOpen(null);
    setDirect(false);
    window.setTimeout(() => panelRef.current?.focus(), 0);
  };

  // Grid columns, read from the layout: the cards sharing the first's top.
  const columns = () => {
    const cards = gridRef.current?.querySelectorAll<HTMLElement>(".vg-card");
    if (!cards || !cards.length) return 1;
    const top = cards[0].offsetTop;
    let n = 0;
    for (const c of Array.from(cards)) { if (c.offsetTop !== top) break; n++; }
    return Math.max(1, n);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Side by side, the terminal beside the column is live and Esc is a
      // real key there (vim!): answer only keys that start inside Views.
      if (asSide) {
        const el = panelRef.current;
        // A keydown dispatched on `window` has a non-Node target; jsdom
        // throws on contains() for it.
        const target = event.target instanceof Node ? event.target : null;
        const inside = !!el && ((target && el.contains(target))
          || (document.activeElement && el.contains(document.activeElement)));
        if (!inside) return;
      }
      const inSearch = document.activeElement === searchRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (inSearch && query) { setQuery(""); return; }
        if (open && !direct) { backToGallery(); return; }
        onClose();
        return;
      }
      if (open) {
        const dir = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (dir) { event.preventDefault(); event.stopPropagation(); step(dir); }
        return;
      }
      if (event.key === "/" && !inSearch) { event.preventDefault(); searchRef.current?.focus(); return; }
      if (!shown.length) return;
      const horiz = event.key === "ArrowLeft" || event.key === "ArrowRight";
      if (inSearch && horiz && query) return; // ← → edit the query
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1
        : event.key === "ArrowDown" ? columns() : event.key === "ArrowUp" ? -columns() : 0;
      if (delta) {
        event.preventDefault();
        event.stopPropagation();
        if (inSearch) searchRef.current?.blur();
        setSel((i) => Math.max(0, Math.min(shown.length - 1, i + delta)));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const pick = shown[Math.min(sel, shown.length - 1)];
        if (pick) { setOpen(pick); setDirect(false); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, open, shown, direct, query, sel, asSide]);

  // Keep the keyboard's card on screen.
  useEffect(() => {
    if (open) return;
    const card = gridRef.current?.querySelectorAll<HTMLElement>(".vg-card")[sel];
    card?.scrollIntoView?.({ block: "nearest" });
  }, [sel, open]);

  // Opening the panel IS the act of seeing what it shows.
  useEffect(() => {
    if (!items) return;
    const seen = loadViewsSeen();
    let dirty = false;
    const newest = new Map<string, number>();
    for (const i of scoped) newest.set(i.session, Math.max(newest.get(i.session) || 0, i.mtime || 0));
    for (const [key, m] of newest) {
      if (m > (seen[key] || 0)) { seen[key] = m; dirty = true; }
    }
    // Only a fleet-wide reading knows the full population; pruning from a
    // scoped open would make every other session's results "new" again.
    if (!effectiveScope) {
      for (const key of Object.keys(seen)) {
        if (!newest.has(key)) { delete seen[key]; dirty = true; }
      }
    }
    if (dirty) saveViewsSeen(seen);
  }, [items, scoped, effectiveScope]);

  const isFresh = (i: ViewItem) => (i.mtime || 0) > (seenAtOpen[i.session] || 0);

  // Cards are real anchors: ⌘-click, middle-click and "copy link address"
  // keep their browser meaning; a plain click reads the result here.
  const onCardClick = (event: MouseEvent, i: ViewItem) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setOpen(i);
    setDirect(false);
  };

  const copyLink = (i: ViewItem) => {
    const href = hrefFor(i);
    const url = /^https?:\/\//.test(href) ? href : location.origin + href;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(i.path);
      window.setTimeout(() => setCopied((c) => (c === i.path ? null : c)), 1400);
    }).catch(() => { /* clipboard denied — ↗ still carries the URL */ });
  };

  // Clear the scope's published COPIES: `hop view` copies files into the
  // daemon's store, so this frees exactly what the feature uses and cannot
  // touch an agent's originals; live servers stay.
  const clearScope = () => {
    if (!armedClear) { setArmedClear(true); return; }
    setArmedClear(false);
    const scope = effectiveScope;
    fetch("/api/views", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scope ? { session: scope, all: true } : { all: true })
    }).then((r) => {
      if (!r.ok) return;
      setItems((cur) => (cur || []).filter((i) => i.kind === "server"
        || (scope ? i.session.toLowerCase() !== scope.toLowerCase() : false)));
    }).catch(() => { /* nothing claimed to be cleared */ });
  };

  const deleteItem = (i: ViewItem) => {
    if (armedDelete !== i.path) { setArmedDelete(i.path); return; }
    setArmedDelete(null);
    fetch("/api/views", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: i.session, name: i.name })
    }).then((r) => {
      if (!r.ok) return;
      setItems((cur) => (cur || []).filter((x) => x.path !== i.path));
    }).catch(() => { /* nothing claimed to be deleted */ });
  };

  // Side by side: the column's left edge drags its width.
  const onEdgeDown = (down: React.PointerEvent<HTMLDivElement>) => {
    if (!onResizeSide) return;
    down.preventDefault();
    const el = down.currentTarget;
    el.setPointerCapture(down.pointerId);
    const move = (ev: PointerEvent) => onResizeSide(window.innerWidth - ev.clientX);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.classList.remove("rail-resizing");
    };
    document.body.classList.add("rail-resizing");
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const sideToggle = onToggleSide && (
    <button type="button" className="views-act vg-layout" onClick={onToggleSide}
            aria-label={asSide ? "Full page" : "Side by side with the session"}
            title={asSide ? "Full page" : "Side by side with the session — the terminal makes room"}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {asSide ? <path d="M4 4h16v16H4z" /> : <><path d="M4 4h16v16H4z" /><path d="M14 4v16" /></>}
      </svg>
    </button>
  );

  const metaOf = (i: ViewItem) => i.kind === "server"
    ? "live server"
    : [label(i.session), relativeTime((i.mtime || 0) * 1000, now)].filter(Boolean).join(" · ");

  // ── The gallery ──
  const card = (i: ViewItem, index: number) => (
    <a key={i.path}
       className={"vg-card" + (index === sel ? " kbd" : "") + (isFresh(i) ? " fresh" : "")}
       href={hrefFor(i)} target="_blank" rel="noopener"
       onClick={(e) => onCardClick(e, i)}
       onMouseEnter={() => setSel(index)}
       title={i.title || i.name}>
      <span className={"vg-thumb" + (isImage(i.name) && i.kind !== "server" ? " image" : ` doc ${filterOf(i)}`)}>
        {isImage(i.name) && i.kind !== "server"
          // A small server-made thumbnail: the plots scannable at a glance
          // without pulling every full image through the tunnel.
          ? <img className="views-thumb" src={thumbSrc(i)} loading="lazy" decoding="async" alt="" />
          : (<>
              <span className="views-kind" aria-hidden="true">{kindTag(i)}</span>
              <span className="vg-doc-title" aria-hidden="true">{i.title || i.name}</span>
              <span className="vg-doc-rule" aria-hidden="true" />
            </>)}
        {isFresh(i) && <span className="views-dot" aria-label="New" />}
      </span>
      <span className="vg-caption">
        <span className="views-title">{i.title || i.name}</span>
        <span className="views-meta">{metaOf(i)}</span>
      </span>
    </a>
  );

  let index = 0;
  const gallery = (
    <div className="vg-scroll">
      {failed ? (
        <p className="views-empty">Couldn't reach the view index.</p>
      ) : !items ? (
        <p className="views-empty">Loading…</p>
      ) : scoped.length === 0 ? (
        <div className="views-empty views-empty-page">
          <p>Nothing published yet{effectiveScope ? " by this session" : ""}. Agents
          hand over results a terminal can't draw — plots, PDFs, rendered
          write-ups, live dev servers — and they land here, by day.</p>
          <pre className="views-empty-cmds">{"hop view --title \"ROC curve\" plot.png\nhop port 5173"}</pre>
        </div>
      ) : shown.length === 0 ? (
        <p className="views-empty">Nothing here matches{query ? ` “${query.trim()}”` : ""}.</p>
      ) : (
        <div ref={gridRef}>
          {days.map((d) => (
            <section key={d.day} className="vg-day">
              <h4 className="vg-day-head">{d.day}<span className="vg-day-count">{d.rows.length}</span></h4>
              <div className="vg-grid">{d.rows.map((r) => card(r, index++))}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  );

  // ── The reader ──
  const linkFile = (() => {
    if (!open || open.kind !== "link") return "";
    try { return new URL(open.target || "").searchParams.get("file") || ""; } catch { return ""; }
  })();
  // Media gets native elements (an iframed raw image sits tiny in a corner;
  // native <video> gives real controls). Documents are iframes — sandboxed
  // only for LIVE servers; our own files skip the sandbox, which would
  // disable the browser's PDF viewer. A notebook lives in its own app.
  const page = open && (
    open.kind === "link" ? (
      <div className="views-link-card">
        <div className="views-link-app">{open.app === "nebula" ? "Nebula notebook" : "Link"}</div>
        <div className="views-link-title">{open.title || open.name}</div>
        {linkFile && <code className="views-link-path">{linkFile}</code>}
        <a className="views-link-open" href={open.target} target="_blank" rel="noopener">
          Open in {open.app === "nebula" ? "Nebula" : "a new tab"} ↗
        </a>
        <div className="views-link-host">{(() => { try { return new URL(open.target || "").host; } catch { return ""; } })()}</div>
      </div>
    ) : open.kind !== "server" && isImage(open.name) ? (
      <div className="views-media"><img src={open.path} alt={open.title || open.name} /></div>
    ) : open.kind !== "server" && isVideo(open.name) ? (
      <div className="views-media"><video src={open.path} controls autoPlay={false} /></div>
    ) : open.kind !== "server" && isAudio(open.name) ? (
      <div className="views-media audio"><audio src={open.path} controls /></div>
    ) : (
      <iframe
        className="views-frame"
        key={open.path}
        src={previewSrc(open)}
        title={open.title || open.name}
        sandbox={open.kind === "server"
          ? "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
          : undefined}
      />
    )
  );

  const reader = open && (
    <div className="vg-reader">
      <div className="views-nav">
        <button type="button" className="views-act vg-back" onClick={direct ? onClose : backToGallery}
                aria-label={direct ? "Close" : "Back to all views"} title={direct ? "Close (Esc)" : "All views (Esc)"}>
          {direct ? "×" : "←"}
        </button>
        <span className="views-nav-title" title={open.title || open.name}>
          {open.title || open.name}
          <span className="views-nav-meta">{[metaOf(open), formatBytes(open.bytes)].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="views-head-spacer" />
        <button type="button" className="views-act" aria-label="Previous view" title="Previous (←)"
                disabled={at <= 0} onClick={() => step(-1)}>‹</button>
        <span className="views-nav-pos">{at < 0 ? "–" : at + 1} / {shown.length}</span>
        <button type="button" className="views-act" aria-label="Next view" title="Next (→)"
                disabled={at < 0 || at >= shown.length - 1} onClick={() => step(1)}>›</button>
        <span className="views-nav-acts">
          {sideToggle}
          {open.kind !== "server" && open.kind !== "link" && (
            <button type="button" className="views-act" title="Download" aria-label={`Download ${open.name}`}
                    onClick={() => triggerDownload(open)}>⤓</button>
          )}
          <button type="button" className="views-act" title="Open in a new tab" aria-label="Open in a new tab"
                  onClick={() => window.open(hrefFor(open), "_blank", "noopener")}>↗</button>
          <button type="button" className="views-act" title={copied === open.path ? "Copied" : "Copy link"} aria-label="Copy link"
                  onClick={() => copyLink(open)}>{copied === open.path ? "✓" : "⧉"}</button>
          {open.kind !== "server" && (
            <button type="button" className={"views-act danger" + (armedDelete === open.path ? " armed" : "")}
                    title={armedDelete === open.path ? "Click again to delete" : "Delete"}
                    aria-label={armedDelete === open.path ? "Click again to delete" : "Delete"}
                    onMouseLeave={() => setArmedDelete((a) => (a === open.path ? null : a))}
                    onClick={() => deleteItem(open)}>
              {armedDelete === open.path ? "sure?" : "🗑"}
            </button>
          )}
        </span>
      </div>
      <div className="views-preview">{page}</div>
      {shown.length > 1 && (
        // The neighbours, in the order ← → walks: where you are in the set.
        <div className="vg-strip" role="list" aria-label="Other views">
          {shown.map((r) => (
            <button key={r.path} type="button" role="listitem"
                    className={"vg-strip-item" + (r.path === open.path ? " on" : "")}
                    ref={r.path === open.path ? (el) => el?.scrollIntoView?.({ block: "nearest", inline: "center" }) : undefined}
                    title={r.title || r.name} onClick={() => setOpen(r)}>
              {isImage(r.name) && r.kind !== "server"
                ? <img src={thumbSrc(r)} loading="lazy" decoding="async" alt="" />
                : <span className="views-kind">{kindTag(r)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Page and side have no backdrop: the sidebar, the terminal beside
          them stay live. */}
      {!asPage && !asSide && <div className="views-backdrop" onClick={onClose} />}
      <div className={"views-panel gallery reading" + (asPage ? " page" : "") + (asSide ? " side" : "") + (open ? " is-reading" : "")}
           role="dialog" aria-label="Published views"
           ref={panelRef} tabIndex={-1}>
        {asSide && onResizeSide && (
          <div className="views-side-handle" role="separator" aria-orientation="vertical" aria-label="Resize Views"
               title="Drag to resize · double-click for the default width"
               onPointerDown={onEdgeDown} onDoubleClick={() => onResizeSide(null)} />
        )}
        {open ? reader : (<>
          <div className="views-head">
            <span className="views-badge">Views</span>
            <span className="vg-count">{counts.all}</span>
            {session && asPage && onClearSession && (
              // The sidebar's selection, shown here; × lets it go.
              <span className="views-scope-chip">
                {label(resolvedSession || session)}
                <button type="button" aria-label="Show every session's results" title="Every session's results"
                        onClick={onClearSession}>×</button>
              </span>
            )}
            {session && !(asPage && onClearSession) && (
              // A session's own results, or the fleet's — one click either way.
              <span className="views-scope-toggle" role="tablist">
                <button type="button" role="tab" aria-selected={!showAll}
                        className={showAll ? "" : "on"} onClick={() => setShowAll(false)}>{label(resolvedSession || session)}</button>
                <button type="button" role="tab" aria-selected={showAll}
                        className={showAll ? "on" : ""} onClick={() => setShowAll(true)}>all</button>
              </span>
            )}
            {session && !showAll && onOpenSession && resolvedSession && (
              <button type="button" className="vg-open-session" onClick={() => onOpenSession(resolvedSession)}
                      title="Open this session">
                Open session →
              </button>
            )}
            <span className="views-head-spacer" />
            {sideToggle}
            {(items?.some((i) => i.kind !== "server") ?? false) && (
              <button type="button"
                      className={"views-act danger views-clear" + (armedClear ? " armed" : "")}
                      title="Free the space hop's published copies use — source files are never touched"
                      onMouseLeave={() => setArmedClear(false)}
                      onClick={clearScope}>
                {armedClear ? "release the copies?" : "clear"}
              </button>
            )}
            <button type="button" className="views-close" aria-label="Close views" onClick={onClose}>×</button>
          </div>
          {scoped.length > 0 && (
            <div className="vg-bar">
              <div className="vg-filters" role="tablist" aria-label="Kind">
                {FILTERS.filter(([f]) => f === "all" || counts[f] > 0).map(([f, name]) => (
                  <button key={f} type="button" role="tab" aria-selected={filter === f}
                          className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                    {name}<span className="vg-filter-n">{counts[f]}</span>
                  </button>
                ))}
              </div>
              <input ref={searchRef} className="vg-search" type="search" placeholder="Search views  /"
                     value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search views" />
            </div>
          )}
          {gallery}
        </>)}
      </div>
    </>
  );
};
