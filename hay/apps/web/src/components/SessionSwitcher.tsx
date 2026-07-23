import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { Terminal } from "@xterm/xterm";
import {
  buildSwitcherModel,
  filterSessionsByOrigin,
  relativeTime,
  type SessionOriginScope,
  type SwitcherSession
} from "../utils/switcherModel";

// Full-screen, in-app session switcher (mobile-first). Hot sessions — current,
// attention, most recent — are preview cards; the tail is compact rows grouped
// by project. Long-press (or the ⋯ button) opens a per-session action sheet.
// Previews are fetched only for hero cards, only while the switcher is open
// and the tab visible, seeded from a cache so reopening paints instantly.

const LONG_PRESS_MS = 450;
const PREVIEW_REFRESH_MS = 5000;
const FILTER_THRESHOLD = 10;

type Props = {
  open: boolean;
  sessions: SwitcherSession[];
  currentRoom: string | null;
  onClose: () => void;
  // False when the switcher IS the page (hop's landing/hub mode): hides the ✕
  // and disables Escape/backdrop dismissal — there is nothing behind to close to.
  dismissable?: boolean;
  onSwitch: (session: SwitcherSession) => void;
  onRefresh: () => void;
  onNotice: (message: string) => void;
  // Mobile-hub quick actions: the switcher is the front page there, so the
  // few one-tap-hot actions (keyboard, find) and the settings drawer hang off
  // its header. Omitted callbacks render no button.
  // WebSocket base for live XL tiles (read-only monitor attachments). When
  // absent, XL falls back to polled text previews.
  tileWsBase?: string;
  onOpenSettings?: () => void;
  onToggleKeyboard?: () => void;
  onFind?: () => void;
};

type Sheet = {
  session: SwitcherSession;
  mode: "menu" | "rename";
  // Viewport point the menu anchors to — the ... button or the long-press
  // finger position. A bottom sheet made the thumb travel the whole screen
  // for actions about the element it was already touching.
  anchor: { x: number; y: number };
};

const sessionKey = (s: SwitcherSession) => s.internalName || s.name;

const shortDir = (p?: string) => {
  const parts = String(p || "").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return "";
  return parts.slice(-2).join("/");
};

const SHELL_PROCS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu", "xonsh", "login"]);
const runningApp = (s: SwitcherSession) => {
  const proc = (s.foregroundProcess || "").trim();
  return proc && !SHELL_PROCS.has(proc.toLowerCase()) ? proc : "";
};

// Live-tile budget: each live tile is a real xterm + WebSocket. Nine is a
// full XL screen; anything beyond falls back to polled text previews until a
// slot frees (scroll-out / unmount releases).
const MAX_LIVE_TILES = 9;
let liveTileSlots = 0;

// A read-only live terminal tile: attaches to the room as source=monitor
// (excluded from presence/counts server-side) with a small snapshot, renders
// at the session's true grid scaled to fit the tile box. IntersectionObserver
// gates the attachment so off-screen tiles cost nothing.
const LiveTile = ({ wsBase, room, cols, rows, fallback }: {
  wsBase: string; room: string; cols: number; rows: number; fallback: string;
}) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let term: Terminal | null = null;
    let ws: WebSocket | null = null;
    let acquired = false;
    const teardown = () => {
      try { ws?.close(); } catch { /* closing */ }
      try { term?.dispose(); } catch { /* disposed */ }
      ws = null;
      term = null;
      if (acquired) { liveTileSlots -= 1; acquired = false; }
      setLive(false);
    };
    const goLive = () => {
      if (term || liveTileSlots >= MAX_LIVE_TILES) return;
      liveTileSlots += 1;
      acquired = true;
      term = new Terminal({ cols, rows, scrollback: 0, disableStdin: true, cursorBlink: false, fontSize: 8 });
      term.open(box);
      // Scale the full terminal grid to the tile box (top-left anchored).
      const inner = box.querySelector(".xterm") as HTMLElement | null;
      if (inner) {
        const fit = () => {
          const w = inner.offsetWidth;
          if (w > 0 && box.clientWidth > 0) {
            const scale = Math.min(1, box.clientWidth / w);
            inner.style.transform = `scale(${scale})`;
            inner.style.transformOrigin = "top left";
          }
        };
        setTimeout(fit, 50);
      }
      const sep = wsBase.includes("?") ? "&" : "?";
      ws = new WebSocket(`${wsBase}${sep}room=${encodeURIComponent(room)}&name=tile&source=monitor&replay=65536&cols=${cols}&rows=${rows}`);
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data));
          if (!term) return;
          if (m.type === "snapshot") { term.reset(); term.write(m.data); }
          else if (m.type === "output") term.write(m.data);
        } catch { /* non-JSON frame */ }
      };
      ws.onclose = () => { /* tile goes stale silently; fallback on next mount */ };
      setLive(true);
    };
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) goLive();
      else teardown();
    }, { threshold: 0.05 });
    io.observe(box);
    return () => { io.disconnect(); teardown(); };
  }, [wsBase, room, cols, rows]);
  return (
    <div className="switcher-live-tile" ref={boxRef}>
      {!live && <pre className="switcher-preview switcher-live-fallback">{fallback}</pre>}
    </div>
  );
};

export const SessionSwitcher = ({
  open,
  sessions,
  currentRoom,
  onClose,
  dismissable = true,
  onSwitch,
  onRefresh,
  onNotice,
  tileWsBase,
  onOpenSettings,
  onToggleKeyboard,
  onFind
}: Props) => {
  const [filter, setFilter] = useState("");
  const [originScope, setOriginScope] = useState<SessionOriginScope>("user");
  // Hero-tile size: bigger tiles show more of each terminal preview.
  const [tileSize, setTileSize] = useState<"s" | "m" | "l" | "xl">(() => {
    const saved = localStorage.getItem("hay_tile_size");
    return saved === "s" || saved === "l" || saved === "xl" ? saved : "m";
  });
  const changeTileSize = (size: "s" | "m" | "l" | "xl") => {
    setTileSize(size);
    localStorage.setItem("hay_tile_size", size);
  };
  // Fullscreen: the in-session palette can expand to the whole viewport for a
  // workspace feel, or stay compact for quick switching. Persisted.
  const [fullscreen, setFullscreen] = useState(() => localStorage.getItem("hay_switcher_fullscreen") === "1");
  const toggleFullscreen = () => {
    setFullscreen((v) => {
      localStorage.setItem("hay_switcher_fullscreen", v ? "0" : "1");
      return !v;
    });
  };
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [, setTick] = useState(0);
  const previewCacheRef = useRef(new Map<string, string>());
  const longPressRef = useRef<{ timer: number; startX: number; startY: number } | null>(null);
  // Set when a long-press opened the sheet, so the click that fires on finger
  // release doesn't also switch sessions.
  const suppressTapRef = useRef(false);

  const visibleSessions = useMemo(
    () => filterSessionsByOrigin(sessions, originScope),
    [sessions, originScope]
  );
  const model = useMemo(
    () => buildSwitcherModel(visibleSessions, currentRoom, filter),
    [visibleSessions, currentRoom, filter]
  );

  // ── Keyboard-first palette: ⌘K → type to filter → ↑↓ → Enter, no mouse. ──
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [kbdIndex, setKbdIndex] = useState(0);
  const finePointer = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: fine)").matches;

  // Content-aware matches: debounced grep over each session's recent screen
  // text (daemon-side, over already-retained output — no index, no polling).
  const [contentMatches, setContentMatches] = useState<Array<{ session: SwitcherSession; snippet: string }>>([]);
  useEffect(() => {
    const q = filter.trim();
    if (!open || q.length < 3) {
      setContentMatches([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (cancelled) return;
        const byKey = new Map(visibleSessions.map((s) => [s.internalName || s.name, s]));
        setContentMatches(
          (Array.isArray(data?.matches) ? data.matches : [])
            .map((m: { internalName?: string; name?: string; snippet?: string }) => {
              const session = byKey.get(m.internalName || "") || byKey.get(m.name || "");
              return session ? { session, snippet: m.snippet || "" } : null;
            })
            .filter(Boolean) as Array<{ session: SwitcherSession; snippet: string }>
        );
      } catch {
        if (!cancelled) setContentMatches([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, filter, visibleSessions]);

  // Content matches the name filter didn't already surface.
  const extraContentMatches = useMemo(() => {
    if (model.mode !== "filter") return [];
    const seen = new Set(model.rows.map(sessionKey));
    return contentMatches.filter((m) => !seen.has(sessionKey(m.session)));
  }, [model, contentMatches]);

  // Flat navigation order = exactly the visual order: heroes, then group rows
  // (and under a filter: name matches, then on-screen content matches).
  const flatNav = useMemo<SwitcherSession[]>(
    () =>
      model.mode === "filter"
        ? [...model.rows, ...extraContentMatches.map((m) => m.session)]
        : [...model.hero, ...model.groups.flatMap((g) => g.rows)],
    [model, extraContentMatches]
  );
  const navIndexByKey = useMemo(() => {
    const m = new Map<string, number>();
    flatNav.forEach((s, i) => m.set(sessionKey(s), i));
    return m;
  }, [flatNav]);

  // Default selection: the first session that isn't the current one (Enter on
  // open = jump to most relevant other session); with a filter, the top match.
  useEffect(() => {
    if (!open) return;
    const firstOther = flatNav.findIndex((s) => !(currentRoom !== null && (s.internalName === currentRoom || s.name === currentRoom)));
    setKbdIndex(filter ? 0 : Math.max(0, firstOther));
    document.querySelector(".switcher-scroll")?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filter, originScope]);
  // Background refreshes may shrink the list — keep the selection in range.
  useEffect(() => {
    setKbdIndex((i) => Math.min(i, Math.max(0, flatNav.length - 1)));
  }, [flatNav.length]);

  // Focus the filter on open (fine-pointer devices only — autofocus on mobile
  // would pop the system keyboard over the grid).
  useEffect(() => {
    if (!open || !finePointer) return;
    const t = window.setTimeout(() => filterInputRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [open, finePointer]);

  // Every visit starts on user-owned sessions. Agent sessions stay one toggle
  // away without competing for the default view.
  useLayoutEffect(() => {
    if (open) {
      setOriginScope("user");
      setFilter("");
      setSheet(null);
      setCreating(false);
      setCreateDraft("");
    }
  }, [open]);

  // Keep relative times fresh while open.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 10000);
    return () => window.clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (sheet) setSheet(null);
        else if (dismissable) onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet]);

  // Tile previews: EVERY session gets a preview tile. Hot tiles (the
  // attention/recency heroes) refresh each tick; the long tail refreshes at a
  // quarter of that rate — 30+ tiles stay cheap, and the daemon only renders
  // previews on demand anyway. Paused while the tab is hidden.
  const lastColdRefreshRef = useRef(0);
  useEffect(() => {
    if (!open || model.mode !== "tiers") return;
    let cancelled = false;
    const hotKeys = new Set(model.hero.map(sessionKey));
    const all = [...model.hero, ...model.groups.flatMap((g) => g.rows)]
      .filter((s) => s.type !== "port" && (s.active || s.starting));
    const refresh = async () => {
      if (cancelled || document.hidden || all.length === 0) return;
      // Time-based cold tier (not tick-based: the first mount often races the
      // sessions fetch and would consume the cold slot on an empty list).
      const coldToo = Date.now() - lastColdRefreshRef.current > 15000;
      if (coldToo) lastColdRefreshRef.current = Date.now();
      const targets = all.filter((s) => hotKeys.has(sessionKey(s)) || coldToo);
      await Promise.all(
        targets.map(async (s) => {
          const key = sessionKey(s);
          try {
            const res = await fetch(`/api/sessions/preview?name=${encodeURIComponent(key)}`);
            if (!res.ok) return;
            const data = await res.json();
            const text = typeof data.text === "string" ? data.text.replace(/\s+$/, "") : "";
            if (!cancelled && text) {
              previewCacheRef.current.set(key, text);
            }
          } catch {
            /* keep the cached preview */
          }
        })
      );
      if (!cancelled) setTick((t) => t + 1);
    };
    refresh();
    const id = window.setInterval(refresh, PREVIEW_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, model]);

  const startLongPress = (event: ReactPointerEvent, session: SwitcherSession) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    cancelLongPress();
    const pressX = event.clientX;
    const pressY = event.clientY;
    const timer = window.setTimeout(() => {
      longPressRef.current = null;
      suppressTapRef.current = true;
      setSheet({ session, mode: "menu", anchor: { x: pressX, y: pressY } });
    }, LONG_PRESS_MS);
    longPressRef.current = { timer, startX: pressX, startY: pressY };
  };

  const cancelLongPress = () => {
    if (longPressRef.current) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
  };

  // Finger jitter shouldn't cancel a long-press; a real drag/scroll should.
  const moveLongPress = (event: ReactPointerEvent) => {
    const pending = longPressRef.current;
    if (!pending) return;
    if (Math.abs(event.clientX - pending.startX) > 10 || Math.abs(event.clientY - pending.startY) > 10) {
      cancelLongPress();
    }
  };

  const handleTap = (session: SwitcherSession) => {
    cancelLongPress();
    if (suppressTapRef.current) {
      suppressTapRef.current = false;
      return;
    }
    if (currentRoom !== null && (session.internalName === currentRoom || session.name === currentRoom)) {
      onClose();
      return;
    }
    onSwitch(session);
  };

  // Arrow/Enter navigation + type-anywhere filtering. The action sheet and
  // the create form own the keyboard while open.
  useEffect(() => {
    if (!open) return;
    const onNavKey = (event: KeyboardEvent) => {
      if (sheet || creating) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setKbdIndex((i) => {
          const n = flatNav.length;
          if (n === 0) return 0;
          const next = event.key === "ArrowDown" ? Math.min(i + 1, n - 1) : Math.max(i - 1, 0);
          requestAnimationFrame(() => {
            document.querySelector(`[data-nav-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
          });
          return next;
        });
        return;
      }
      if (event.key === "Enter") {
        const target = flatNav[kbdIndex];
        if (target) {
          event.preventDefault();
          handleTap(target);
        }
        return;
      }
      // Type-to-filter from anywhere: stray printables land in the filter box.
      const inputFocused = document.activeElement === filterInputRef.current;
      if (!inputFocused && (event.key.length === 1 || event.key === "Backspace")) {
        event.preventDefault();
        filterInputRef.current?.focus();
        setFilter((f) => (event.key === "Backspace" ? f.slice(0, -1) : f + event.key));
      }
    };
    window.addEventListener("keydown", onNavKey);
    return () => window.removeEventListener("keydown", onNavKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet, creating, flatNav, kbdIndex]);

  const openSheet = (session: SwitcherSession, anchor?: { x: number; y: number }) => {
    cancelLongPress();
    // A missing anchor must degrade to a centered menu, never crash the render.
    setSheet({
      session,
      mode: "menu",
      anchor: anchor ?? { x: window.innerWidth / 2 + 132, y: window.innerHeight / 3 }
    });
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!sheet) return;
    const next = renameDraft.trim();
    const oldName = sheet.session.displayName || sheet.session.name;
    if (!next || next === oldName) {
      setSheet(null);
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(next)) {
      onNotice("Only letters, numbers, - and _ allowed");
      return;
    }
    try {
      const res = await fetch("/api/sessions/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldName, newName: next })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { error?: string }));
        onNotice(data.error || "Rename failed");
        return;
      }
      onNotice(`Renamed to ${next}`);
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Rename failed");
    }
  };

  const toggleAgentAccess = async () => {
    if (!sheet) return;
    const key = sessionKey(sheet.session);
    const allowed = sheet.session.agentPermitted !== true;
    try {
      const res = await fetch("/api/sessions/agent-permission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: key, allowed })
      });
      if (!res.ok) {
        onNotice("Failed to update agent access");
        return;
      }
      onNotice(allowed ? "Agent access enabled" : "Agent access disabled");
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Failed to update agent access");
    }
  };

  const killSessionByRef = async (s: SwitcherSession) => {
    const label = s.displayName || s.name;
    if (!window.confirm(`Kill session "${label}" for all participants? Its running process is terminated.`)) {
      return;
    }
    try {
      const res = await fetch("/api/sessions/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(s) })
      });
      if (!res.ok) {
        onNotice("Failed to kill session");
        return;
      }
      onNotice(`Killed ${label}`);
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Failed to kill session");
    }
  };
  // Reclassify origin (user <-> agent): adopting an agent-spawned session you
  // now drive yourself (a forked conversation, a worker you took over) moves
  // it to the user side of the origin filter — and into default restore.
  const toggleOrigin = async () => {
    if (!sheet) return;
    const next = sheet.session.createdBy === "agent" ? "user" : "agent";
    try {
      const res = await fetch("/api/sessions/origin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(sheet.session), createdBy: next })
      });
      if (!res.ok) {
        onNotice("Failed to change session origin");
        return;
      }
      onNotice(next === "user" ? "Moved to user sessions" : "Moved to agent sessions");
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Failed to change session origin");
    }
  };

  const killSession = async () => {
    if (!sheet) return;
    await killSessionByRef(sheet.session);
  };
  const startRename = (s: SwitcherSession) => {
    setRenameDraft(s.displayName || s.name);
    setSheet({ session: s, mode: "rename" });
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    const next = createDraft.trim();
    if (!next) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(next)) {
      onNotice("Only letters, numbers, - and _ allowed");
      return;
    }
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next, type: "terminal", port: null })
      });
      const data = await res.json().catch(() => ({} as { name?: string; error?: string }));
      if (!res.ok || !data.name) {
        onNotice(data.error || "Failed to create session");
        return;
      }
      setCreating(false);
      setCreateDraft("");
      onSwitch({ name: data.name, displayName: data.name, active: false, starting: true, internalName: data.name });
    } catch {
      onNotice("Failed to create session");
    }
  };

  if (!open) return null;

  const now = Date.now();

  const dots = (s: SwitcherSession) =>
    (s.bellUnseen || s.unread) && (
      <span
        className={`attention-dot ${s.bellUnseen ? "bell" : "output"}`}
        title={s.bellUnseen ? "Bell rung since last viewed" : "New output since last viewed"}
      />
    );

  // Claude Code titles its process with a bare version number — label it.
  const appLabel = (s: SwitcherSession) => {
    const app = runningApp(s);
    if (!app) return "";
    return /^\d+\.\d+\.\d+$/.test(app) ? "claude" : app;
  };

  // Home-shortened path, full tail preserved: the workdir IS the identity of a
  // session, so it gets its own flexible span (left-ellipsized in CSS — the
  // END of the path is the part that matters).
  const dirPath = (s: SwitcherSession) => {
    const p = s.cwd || "";
    if (!p) return "";
    return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^\/root(?=\/|$)/, "~");
  };

  // Compact right-side meta: time first, app demoted to last (least important).
  const meta = (s: SwitcherSession) => {
    const parts: string[] = [];
    const rel = relativeTime(s.lastActivityAt || 0, now);
    if (rel) parts.push(rel);
    const app = appLabel(s);
    if (app) parts.push(app);
    return parts.join(" · ");
  };

  const isCurrentSession = (s: SwitcherSession) =>
    currentRoom !== null && (s.internalName === currentRoom || s.name === currentRoom);

  const pressHandlers = (s: SwitcherSession) => ({
    onPointerDown: (e: ReactPointerEvent) => startLongPress(e, s),
    onPointerUp: cancelLongPress,
    onPointerLeave: cancelLongPress,
    onPointerMove: moveLongPress,
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      suppressTapRef.current = false;
      openSheet(s, { x: e.clientX, y: e.clientY });
    }
  });

  const renderCard = (s: SwitcherSession) => {
    const key = sessionKey(s);
    const preview = previewCacheRef.current.get(key);
    const current = isCurrentSession(s);
    const kbdSelected = navIndexByKey.get(key) === kbdIndex;
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        data-nav-index={navIndexByKey.get(key)}
        className={`switcher-card${current ? " current" : ""}${kbdSelected ? " kbd-selected" : ""}`}
        onClick={() => handleTap(s)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleTap(s);
        }}
        {...pressHandlers(s)}
      >
        <div className="switcher-card-head">
          {dots(s)}
          <span className="switcher-card-name">{s.displayName}</span>
          {current && <span className="switcher-chip current">CURRENT</span>}
          {originScope === "all" && s.createdBy === "agent" && (
            <span className="switcher-chip agent">AGENT</span>
          )}
          {!current && s.starting && !s.active && <span className="switcher-chip starting">STARTING</span>}
          {inlineActions(s)}
        </div>
        {tileSize === "xl" && tileWsBase && s.active && s.type !== "port" ? (
          <LiveTile
            wsBase={tileWsBase}
            room={sessionKey(s)}
            cols={s.cols || 140}
            rows={s.rows || 40}
            fallback={preview || " "}
          />
        ) : (
          <pre className="switcher-preview" aria-hidden="true">{preview || " "}</pre>
        )}
        <div className="switcher-card-meta">
          <span className="switcher-card-dir" title={s.cwd || undefined}>{dirPath(s) ? `\u200E${dirPath(s)}\u200E` : "\u00a0"}</span>
          <span className="switcher-card-when">{meta(s)}</span>
        </div>
      </div>
    );
  };

  const renderRow = (s: SwitcherSession) => {
    const key = sessionKey(s);
    const kbdSelected = navIndexByKey.get(key) === kbdIndex;
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        data-nav-index={navIndexByKey.get(key)}
        className={`switcher-row${isCurrentSession(s) ? " current" : ""}${kbdSelected ? " kbd-selected" : ""}`}
        onClick={() => handleTap(s)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleTap(s);
        }}
        {...pressHandlers(s)}
      >
        {dots(s)}
        <span className="switcher-row-name">{s.displayName}</span>
        {originScope === "all" && s.createdBy === "agent" && (
          <span className="switcher-chip agent">AGENT</span>
        )}
        {s.type === "port" && <span className="switcher-chip port">PORT {s.port}</span>}
        <span className="switcher-row-dir" title={s.cwd || undefined}>{dirPath(s) ? `\u200E${dirPath(s)}\u200E` : ""}</span>
        <span className="switcher-row-meta">{meta(s)}</span>
        {inlineActions(s)}
      </div>
    );
  };

  // Inline quick actions (desktop hover): rename + kill without the sheet.
  const inlineActions = (s: SwitcherSession) => (
    <span className="switcher-inline-actions">
      <button
        type="button"
        className="switcher-icon-btn"
        aria-label={`Rename ${s.displayName}`}
        title="Rename"
        onClick={(e) => { e.stopPropagation(); startRename(s); }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
      <button
        type="button"
        className="switcher-icon-btn danger"
        aria-label={`Kill ${s.displayName}`}
        title="Kill session"
        onClick={(e) => { e.stopPropagation(); killSessionByRef(s); }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>
      </button>
      <button
        type="button"
        className="switcher-icon-btn"
        aria-label={`More actions for ${s.displayName}`}
        title="More"
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openSheet(s, { x: r.right, y: r.bottom }); }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        ⋯
      </button>
    </span>
  );

  const sheetSession = sheet?.session;
  const sheetAgentPermitted = sheetSession?.agentPermitted === true;

  return (
    <div
      className={`switcher-overlay tile-${tileSize}${dismissable ? "" : " switcher-hub"}${dismissable && fullscreen ? " switcher-fullscreen" : ""}`}
      role="dialog"
      aria-label="Sessions"
      onClick={(e) => {
        // Desktop shows the switcher as a centered panel over a backdrop;
        // clicking the backdrop (not the panel) dismisses it. On mobile the
        // panel is full-bleed, so this never fires.
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="switcher-top">
        <header className="switcher-header">
          <h2>Sessions</h2>
          <span className="switcher-count">{visibleSessions.length}</span>
          <div className="switcher-tilesize" role="group" aria-label="Tile size">
            {(["s", "m", "l", "xl"] as const).map((size) => (
              <button
                key={size}
                type="button"
                className={tileSize === size ? "active" : ""}
                aria-label={`Tile size ${size.toUpperCase()}`}
                onClick={() => changeTileSize(size)}
              >
                {size.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="switcher-header-spacer" />
          {dismissable && (
            <button type="button" className="switcher-action" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen}>
              {fullscreen ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 3v6H3M21 9h-6V3M3 15h6v6M15 21v-6h6"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6"/>
                </svg>
              )}
            </button>
          )}
          {onToggleKeyboard && (
            <button type="button" className="switcher-action" aria-label="Toggle keyboard" title="Toggle keyboard" onClick={onToggleKeyboard}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="14" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8"/>
              </svg>
            </button>
          )}
          {onFind && (
            <button type="button" className="switcher-action" aria-label="Find in terminal" title="Find in terminal" onClick={onFind}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
              </svg>
            </button>
          )}
          {onOpenSettings && (
            <button type="button" className="switcher-action" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          )}
          {dismissable && (
            <button type="button" className="switcher-close" aria-label="Close switcher" onClick={onClose}>
              ✕
            </button>
          )}
        </header>
        <div className="switcher-filter-row">
          <div className="switcher-origin" role="group" aria-label="Session origin">
            {([
              ["user", "User"],
              ["agent", "Agent"],
              ["all", "All"]
            ] as const).map(([scope, label]) => (
              <button
                key={scope}
                type="button"
                className={originScope === scope ? "active" : ""}
                aria-pressed={originScope === scope}
                onClick={() => {
                  setOriginScope(scope);
                  setCreating(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {(finePointer || visibleSessions.length > FILTER_THRESHOLD || filter) && (
            <input
              ref={filterInputRef}
              className="switcher-filter"
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter sessions"
            />
          )}
        </div>
      </div>
      <div className="switcher-scroll">
        {model.mode === "filter" ? (
          <>
            <div className="switcher-rows">
              {model.rows.length === 0 && extraContentMatches.length === 0 ? (
                <div className="switcher-empty">No sessions match “{filter.trim()}”</div>
              ) : (
                model.rows.map(renderRow)
              )}
            </div>
            {extraContentMatches.length > 0 && (
              <section className="switcher-group">
                <h3 className="switcher-group-label">found in terminal output</h3>
                <div className="switcher-rows">
                  {extraContentMatches.map(({ session: s, snippet }) => {
                    const key = sessionKey(s);
                    const kbdSelected = navIndexByKey.get(key) === kbdIndex;
                    return (
                      <div
                        key={key}
                        role="button"
                        tabIndex={0}
                        data-nav-index={navIndexByKey.get(key)}
                        className={`switcher-row${kbdSelected ? " kbd-selected" : ""}`}
                        onClick={() => handleTap(s)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleTap(s); }}
                      >
                        {dots(s)}
                        <span className="switcher-row-name">{s.displayName}</span>
                        <span className="switcher-snippet">{snippet}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        ) : (
          <>
            {originScope === "agent" && visibleSessions.length === 0 && (
              <div className="switcher-empty">No agent sessions</div>
            )}
            <div className="switcher-grid">
              {model.hero.map(renderCard)}
              {originScope !== "agent" && (creating ? (
                <form className="switcher-card new inline-edit" onSubmit={submitCreate}>
                  <input
                    placeholder="session-name"
                    value={createDraft}
                    onChange={(e) => setCreateDraft(e.target.value)}
                    maxLength={64}
                    autoFocus
                    aria-label="New session name"
                  />
                  <div className="switcher-new-actions">
                    <button type="submit">Create</button>
                    <button type="button" onClick={() => setCreating(false)}>✕</button>
                  </div>
                </form>
              ) : (
                <button type="button" className="switcher-card new" onClick={() => setCreating(true)}>
                  <span className="switcher-new-plus">+</span>
                  <span>New session</span>
                </button>
              ))}
            </div>
            {model.groups.map((group) => (
              <section key={group.label} className="switcher-group">
                <h3 className="switcher-group-label">{group.label}</h3>
                <div className="switcher-grid">{group.rows.map(renderCard)}</div>
              </section>
            ))}
          </>
        )}
      </div>
      {sheet && sheetSession && (
        <>
          <div className="switcher-sheet-backdrop" onClick={() => setSheet(null)} />
          <div
            className="switcher-sheet"
            role="menu"
            aria-label={`Actions for ${sheetSession.displayName}`}
            style={(() => {
              const width = 264;
              const estH = sheet.mode === "rename" ? 140 : 340;
              const left = Math.min(Math.max(8, sheet.anchor.x - width), window.innerWidth - width - 8);
              let top = sheet.anchor.y + 8;
              if (top + estH > window.innerHeight - 8) top = Math.max(8, sheet.anchor.y - estH - 8);
              return { left, top };
            })()}
          >
            <p className="switcher-sheet-title">{sheetSession.displayName}</p>
            {sheet.mode === "rename" ? (
              <form className="inline-edit" onSubmit={submitRename}>
                <input
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  maxLength={64}
                  autoFocus
                  aria-label="New session name"
                />
                <button type="submit">Save</button>
                <button type="button" onClick={() => setSheet({ session: sheetSession, mode: "menu", anchor: sheet.anchor })}>✕</button>
              </form>
            ) : (
              <>
                {!isCurrentSession(sheetSession) && (
                  <button type="button" onClick={() => handleTap(sheetSession)}>Switch to</button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setRenameDraft(sheetSession.displayName || sheetSession.name);
                    setSheet({ session: sheetSession, mode: "rename", anchor: sheet.anchor });
                  }}
                >
                  Rename
                </button>
                {sheetSession.type !== "port" && (
                  <button type="button" onClick={toggleAgentAccess}>
                    {sheetAgentPermitted ? "Disable agent access" : "Enable agent access"}
                  </button>
                )}
                {sheetSession.type !== "port" && (
                  <button type="button" onClick={toggleOrigin}>
                    {sheetSession.createdBy === "agent" ? "Move to user sessions" : "Move to agent sessions"}
                  </button>
                )}
                <button type="button" className="danger" onClick={killSession}>
                  Kill session
                </button>
                <button type="button" onClick={() => setSheet(null)}>Cancel</button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};
