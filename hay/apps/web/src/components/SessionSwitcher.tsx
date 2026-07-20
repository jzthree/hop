import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  buildSwitcherModel,
  relativeTime,
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
  onOpenSettings?: () => void;
  onToggleKeyboard?: () => void;
  onFind?: () => void;
};

type Sheet = {
  session: SwitcherSession;
  mode: "menu" | "rename";
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

export const SessionSwitcher = ({
  open,
  sessions,
  currentRoom,
  onClose,
  dismissable = true,
  onSwitch,
  onRefresh,
  onNotice,
  onOpenSettings,
  onToggleKeyboard,
  onFind
}: Props) => {
  const [filter, setFilter] = useState("");
  // Hero-tile size: bigger tiles show more of each terminal preview.
  const [tileSize, setTileSize] = useState<"s" | "m" | "l" | "xl">(() => {
    const saved = localStorage.getItem("hay_tile_size");
    return saved === "s" || saved === "l" || saved === "xl" ? saved : "m";
  });
  const changeTileSize = (size: "s" | "m" | "l" | "xl") => {
    setTileSize(size);
    localStorage.setItem("hay_tile_size", size);
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

  const model = useMemo(
    () => buildSwitcherModel(sessions, currentRoom, filter),
    [sessions, currentRoom, filter]
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
        const byKey = new Map(sessions.map((s) => [s.internalName || s.name, s]));
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
  }, [open, filter, sessions]);

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
  }, [open, filter]);
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

  // Reset transient state whenever the switcher opens.
  useEffect(() => {
    if (open) {
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

  // Hero-card previews: fetch on open and every 5s while open + visible.
  // Only live terminal sessions are asked; rows never fetch anything.
  useEffect(() => {
    if (!open || model.mode !== "tiers") return;
    let cancelled = false;
    const targets = model.hero.filter((s) => s.type !== "port" && (s.active || s.starting));
    const refresh = async () => {
      if (cancelled || document.hidden) return;
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
    const timer = window.setTimeout(() => {
      longPressRef.current = null;
      suppressTapRef.current = true;
      setSheet({ session, mode: "menu" });
    }, LONG_PRESS_MS);
    longPressRef.current = { timer, startX: event.clientX, startY: event.clientY };
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

  const openSheet = (session: SwitcherSession) => {
    cancelLongPress();
    setSheet({ session, mode: "menu" });
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

  const killSession = async () => {
    if (!sheet) return;
    const label = sheet.session.displayName || sheet.session.name;
    if (!window.confirm(`Kill session "${label}" for all participants? Its running process is terminated.`)) {
      return;
    }
    try {
      const res = await fetch("/api/sessions/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(sheet.session) })
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
      openSheet(s);
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
          {!current && s.starting && !s.active && <span className="switcher-chip starting">STARTING</span>}
          <button
            type="button"
            className="switcher-more"
            aria-label={`Actions for ${s.displayName}`}
            onClick={(e) => {
              e.stopPropagation();
              openSheet(s);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            ⋯
          </button>
        </div>
        <pre className="switcher-preview" aria-hidden="true">{preview || " "}</pre>
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
        {s.type === "port" && <span className="switcher-chip port">PORT {s.port}</span>}
        <span className="switcher-row-dir" title={s.cwd || undefined}>{dirPath(s) ? `\u200E${dirPath(s)}\u200E` : ""}</span>
        <span className="switcher-row-meta">{meta(s)}</span>
        <button
          type="button"
          className="switcher-more"
          aria-label={`Actions for ${s.displayName}`}
          onClick={(e) => {
            e.stopPropagation();
            openSheet(s);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          ⋯
        </button>
      </div>
    );
  };

  const sheetSession = sheet?.session;
  const sheetAgentPermitted = sheetSession?.agentPermitted === true;

  return (
    <div
      className={`switcher-overlay tile-${tileSize}${dismissable ? "" : " switcher-hub"}`}
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
          <span className="switcher-count">{sessions.length}</span>
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
        {(finePointer || sessions.length > FILTER_THRESHOLD || filter) && (
          <div className="switcher-filter-row">
            <input
              ref={filterInputRef}
              className="switcher-filter"
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter sessions"
            />
          </div>
        )}
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
            <div className="switcher-grid">
              {model.hero.map(renderCard)}
              {creating ? (
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
              )}
            </div>
            {model.groups.map((group) => (
              <section key={group.label} className="switcher-group">
                <h3 className="switcher-group-label">{group.label}</h3>
                <div className="switcher-rows">{group.rows.map(renderRow)}</div>
              </section>
            ))}
          </>
        )}
      </div>
      {sheet && sheetSession && (
        <>
          <div className="switcher-sheet-backdrop" onClick={() => setSheet(null)} />
          <div className="switcher-sheet" role="menu" aria-label={`Actions for ${sheetSession.displayName}`}>
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
                <button type="button" onClick={() => setSheet({ session: sheetSession, mode: "menu" })}>✕</button>
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
                    setSheet({ session: sheetSession, mode: "rename" });
                  }}
                >
                  Rename
                </button>
                {sheetSession.type !== "port" && (
                  <button type="button" onClick={toggleAgentAccess}>
                    {sheetAgentPermitted ? "Disable agent access" : "Enable agent access"}
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
