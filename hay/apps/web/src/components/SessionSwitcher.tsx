import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  buildSwitcherModel,
  filterSessionsByOrigin,
  projectKey,
  relativeTime,
  type SessionOriginScope,
  type SwitcherSession,
  type SwitcherSortMode
} from "../utils/switcherModel";
import { scanKeyboardProtocol } from "../utils/keyboardProtocol";

// Full-screen, in-app session switcher (mobile-first). Hot sessions — current,
// attention, most recent — are preview cards; the tail is compact rows grouped
// by project. Long-press (or the ⋯ button) opens a per-session action sheet.
// Previews are fetched only for hero cards, only while the switcher is open
// and the tab visible, seeded from a cache so reopening paints instantly.

const LONG_PRESS_MS = 450;
const PREVIEW_REFRESH_MS = 5000;
const FILTER_THRESHOLD = 10;

// Zoom ladder: one +/− press per step. Each level sets the grid's minimum
// tile width, the preview window height, and the preview font size (the
// focused terminal inherits the same metrics so preview → terminal stays a
// swap in place). How much of the ladder is REACHABLE depends on the
// viewport: the first level whose tiles lay out as a single full-width
// column is the ceiling — past it "+" has nothing left to grow into.
const ZOOM_LEVELS = [
  { min: 100, h: "40px", fs: "4px" },
  { min: 120, h: "56px", fs: "5px" }, // old S
  { min: 150, h: "84px", fs: "6px" }, // old M
  { min: 210, h: "130px", fs: "7.5px" },
  { min: 300, h: "200px", fs: "9.5px" }, // old L
  { min: 420, h: "300px", fs: "11px" }, // old XL — interactive from here up
  { min: 560, h: "min(46vh, 480px)", fs: "11px" },
  { min: 720, h: "min(56vh, 640px)", fs: "12px" },
  { min: 900, h: "min(66vh, 820px)", fs: "13px" }
];
// From this level up the type is legible enough to work in: clicking a tile
// focuses a real terminal in place instead of switching to the session.
const INTERACTIVE_ZOOM = 5;
const GRID_GAP = 10;
const DEFAULT_ZOOM = 2;
// Old persisted hay_tile_size values map onto the ladder.
const LEGACY_ZOOM: Record<string, number> = { s: 1, m: 2, l: 4, xl: 5 };

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
  // WebSocket base + identity/theme for the XL focused tile (the one
  // interactive terminal in the wall). Absent => XL stays previews-only.
  tileWsBase?: string;
  userName?: string;
  terminalTheme?: object;
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

// A restored session can come back sitting on Claude's own "resume from
// summary / full session" question — running, but waiting on a keypress that
// only the human should answer (the full-session choice can eat a large share
// of a usage limit). Restore reports it as up, so without this it looks live
// while nothing moves. Detected from the preview text the wall already has,
// so it costs no extra request.
const RESUME_PROMPT_RE = /Resume from summary|Resuming the full session|Don't ask me again/i;
const waitingOnUser = (frame?: PreviewFrame) => !!frame && RESUME_PROMPT_RE.test(frame.text);

// One styled span of preview text. The daemon reads these straight off the
// room's grid (a real terminal), so a tile shows the session's ACTUAL colors
// instead of the flattened text previews used before.
type PreviewRun = { t: string; f?: string; b?: string; d?: 1; o?: 1; i?: 1 };
type PreviewFrame = { text: string; color?: PreviewRun[][] | null };

const renderPreviewRuns = (lines: PreviewRun[][]) =>
  lines.map((runs, y) => (
    <span key={y}>
      {runs.map((r, i) => (
        <span
          key={i}
          style={{
            // Inverse swaps fg/bg the way the terminal does; unset sides fall
            // back to the tile's own colors.
            color: r.i ? r.b || "var(--terminal-bg)" : r.f,
            background: r.i ? r.f || "var(--ink)" : r.b,
            opacity: r.d ? 0.6 : undefined,
            fontWeight: r.o ? 600 : undefined
          }}
        >
          {r.t}
        </span>
      ))}
      {y < lines.length - 1 ? "\n" : null}
    </span>
  ));

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

// Focused tile: exactly ONE tile at a time is a real interactive terminal —
// full input, auto-fit to its box, instant rendering, connected as the user
// (it participates in presence like any client). Every other tile stays a
// cheap polled text preview, so the XL wall costs one websocket, not nine.
const FocusedTile = ({ wsBase, room, userName, theme, fallback, fontSize, claudeApp, onFullscreen, onUnfocus }: {
  wsBase: string; room: string; userName: string; theme: object | undefined;
  fallback: string; fontSize: number; claudeApp: boolean;
  onFullscreen: () => void; onUnfocus: () => void;
}) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  // The last preview frame stays painted OVER the terminal until the claimed
  // resize has round-tripped and the app repainted — the first snapshot
  // contains old-size bytes and looks mangled for a beat. Matching font
  // metrics (below) make the veil-to-terminal swap nearly invisible.
  const [veiled, setVeiled] = useState(true);
  // Connection state surfaced in the focus bar: a dead socket must LOOK dead.
  const [conn, setConn] = useState<"live" | "down">("live");
  // Read at key time via a ref — the foreground process changes as commands
  // run, and a prop-dep here would tear down the whole connection each time.
  const claudeAppRef = useRef(claudeApp);
  claudeAppRef.current = claudeApp;
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // Clicking a tile is an act of attention: the tile claims the shared PTY
    // and autofits it to the tile box, exactly like attaching a window. Size
    // conflicts resolve through the normal server election — whoever typed
    // last owns the size — so typing in the big background terminal snaps the
    // session back, and the tile falls back to observing at active_size,
    // scaled down to fit.
    // Same font metrics as .switcher-preview at the current zoom (shared
    // --font-terminal stack, 1.3 line height) so preview → tile → the real
    // session are one continuous font, not three.
    const monoStack = getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim() || "monospace";
    const term = new Terminal({
      scrollback: 2000,
      fontSize,
      lineHeight: 1.3,
      fontFamily: monoStack,
      cursorBlink: true,
      theme: theme as never
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(box);
    const inner = box.querySelector(".xterm") as HTMLElement | null;
    const rescale = () => {
      if (!inner) return;
      const w = inner.offsetWidth;
      const h = inner.offsetHeight;
      if (w > 0 && h > 0 && box.clientWidth > 0 && box.clientHeight > 0) {
        const scale = Math.min(1, box.clientWidth / w, box.clientHeight / h);
        inner.style.transform = `scale(${scale})`;
        inner.style.transformOrigin = "top left";
      }
    };
    // Size the local grid to the box before connecting so the attach itself
    // carries the tile's dimensions.
    if (box.clientWidth > 0 && box.clientHeight > 0) fitAddon.fit();
    let claimed = { cols: term.cols, rows: term.rows };
    const sep = wsBase.includes("?") ? "&" : "?";
    // 64KB replay: enough tail for a wall tile, and the snapshot parses ~4x
    // faster than the full-scrollback replay — focus latency is dominated by
    // connect + snapshot + repaint.
    const wsUrl = () =>
      `${wsBase}${sep}room=${encodeURIComponent(room)}&name=${encodeURIComponent(userName || "user")}&replay=65536&cols=${term.cols}&rows=${term.rows}`;
    // The socket is a mutable slot with a real lifecycle. An idle tile's
    // connection dies silently (laptop sleep, tunnel idle timeout); without
    // onclose handling the tile kept rendering its last frame, kept blinking
    // its cursor, and swallowed every keystroke at the readyState guard — a
    // zombie only unfocus/refocus could revive. Mirror the main terminal:
    // onclose → backoff reconnect, wake/refocus → immediate reconnect, and
    // input typed while down is briefly buffered, never silently dropped.
    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer = 0;
    let reconnectAttempt = 0;
    const pendingInput: Array<{ data: string; at: number }> = [];
    // Claim lifecycle. The server sends the session's CURRENT active_size on
    // attach, which races our claim — resizing the local grid to it produced
    // a zoomed-out old-size view until the claim round-tripped (two reflows).
    // While a claim is pending we swallow non-matching echoes. A rejection
    // arrives as a corrective echo within one RTT; hearing nothing for 250ms
    // means accepted (newer hosts also confirm the winner explicitly).
    let claimPending = false;
    let remoteEcho: { cols: number; rows: number } | null = null;
    let claimTimer = 0;
    const applyClaimed = () => {
      if (term.cols !== claimed.cols || term.rows !== claimed.rows) {
        term.resize(claimed.cols, claimed.rows);
      }
      setTimeout(rescale, 30);
    };
    const resolveClaim = () => {
      if (!claimPending) return;
      claimPending = false;
      if (remoteEcho && (remoteEcho.cols !== claimed.cols || remoteEcho.rows !== claimed.rows)) {
        // Rejected — observe the winner's size, scaled.
        if (remoteEcho.cols !== term.cols || remoteEcho.rows !== term.rows) {
          term.resize(remoteEcho.cols, remoteEcho.rows);
          setTimeout(rescale, 30);
        }
      } else {
        // Silence = accepted (newer hosts also confirm explicitly).
        applyClaimed();
      }
      remoteEcho = null;
    };
    // The local grid is NEVER resized optimistically on a claim — only on
    // acceptance. A rejected claim (someone active elsewhere) must cause
    // zero visual churn, or periodic re-claims flap the tile between sizes.
    // `deliberate` marks a human click: the server (new hosts) lets it win
    // the election outright; old hosts strip the flag and apply attach rules.
    const sendClaim = (claim?: "attach", deliberate = false) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const dims = box.clientWidth > 0 && box.clientHeight > 0 ? fitAddon.proposeDimensions() : undefined;
      if (!dims?.cols || !dims?.rows) return;
      claimed = { cols: dims.cols, rows: dims.rows };
      claimPending = true;
      remoteEcho = null;
      window.clearTimeout(claimTimer);
      claimTimer = window.setTimeout(resolveClaim, 250);
      ws.send(JSON.stringify({
        type: "resize", cols: claimed.cols, rows: claimed.rows,
        ...(claim ? { claim } : {}), ...(deliberate ? { user: true } : {})
      }));
    };
    const ownsSize = () => term.cols === claimed.cols && term.rows === claimed.rows;
    setVeiled(true);
    // Unveil on the first output AFTER the claim resolves — that burst is the
    // repaint at the fitted size, so the veil lifts straight onto the final
    // layout (never the zoomed-out intermediate). Timers are fallbacks only.
    let unveilTimer = 0;
    const unveilSoon = (ms: number) => {
      window.clearTimeout(unveilTimer);
      unveilTimer = window.setTimeout(() => setVeiled(false), ms);
    };
    unveilSoon(2500);
    let sawSnapshot = false;
    let sawRepaint = false;
    // Enhanced-keyboard state, tracked from the tile's own stream (snapshot
    // flag + live protocol toggles) — gates the Shift+Enter CSI-u encoding.
    let kbdEnhanced = false;
    const scheduleReconnect = () => {
      if (disposed) return;
      setConn("down");
      window.clearTimeout(reconnectTimer);
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => connect(), delay);
    };
    const connect = () => {
      if (disposed) return;
      window.clearTimeout(reconnectTimer);
      if (ws) { try { ws.close(); } catch { /* replacing */ } }
      claimPending = false;
      remoteEcho = null;
      const sock = new WebSocket(wsUrl());
      ws = sock;
      // The mount IS the user's click on this tile — a deliberate claim.
      // (On reconnect the fresh snapshot repaints the grid, so no re-veil.)
      sock.onopen = () => {
        if (disposed || ws !== sock) return;
        reconnectAttempt = 0;
        setConn("live");
        sendClaim("attach", true);
        // Replay keystrokes typed while down — fresh ones only: firing stale
        // input into a shell long after it was typed is worse than losing it
        // (the user has usually retyped by then).
        const cutoff = Date.now() - 15000;
        for (const p of pendingInput) {
          if (p.at >= cutoff) sock.send(JSON.stringify({ type: "input", data: p.data }));
        }
        pendingInput.length = 0;
      };
      sock.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data));
          if (m.type === "snapshot") {
            term.reset();
            term.write(m.data, rescale);
            sawSnapshot = true;
            kbdEnhanced = typeof m.keyboardEnhanced === "boolean"
              ? m.keyboardEnhanced
              : scanKeyboardProtocol(String(m.data || ""), false);
            unveilSoon(600);
          }
          else if (m.type === "output") {
            term.write(m.data);
            kbdEnhanced = scanKeyboardProtocol(String(m.data || ""), kbdEnhanced);
            if (sawSnapshot && !sawRepaint && !claimPending) { sawRepaint = true; unveilSoon(120); }
          }
          else if (m.type === "active_size") {
            if (claimPending) {
              if (m.cols === claimed.cols && m.rows === claimed.rows) {
                // Claim confirmed — apply and let the repaint land on it.
                claimPending = false;
                window.clearTimeout(claimTimer);
                applyClaimed();
              } else {
                remoteEcho = { cols: m.cols, rows: m.rows };
              }
            } else if (m.cols !== term.cols || m.rows !== term.rows) {
              // Another client won the election — observe at its size, scaled.
              term.resize(m.cols, m.rows);
              setTimeout(rescale, 30);
            }
          }
        } catch { /* non-JSON frame */ }
      };
      sock.onclose = () => {
        if (disposed || ws !== sock) return;
        scheduleReconnect();
      };
      sock.onerror = () => {
        try { sock.close(); } catch { /* already closing */ }
      };
    };
    connect();
    // Wake/refocus recovery. A socket that died while the tab was hidden
    // reconnects the moment the user returns; after a LONG absence (system
    // sleep) even a socket claiming OPEN may be half-dead — the OS hasn't
    // noticed the peer vanish, so sends black-hole. Reconnect proactively;
    // the snapshot repaint makes it visually free.
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (!ws || ws.readyState !== WebSocket.OPEN || away > 60000) {
        reconnectAttempt = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const onWindowFocus = () => {
      if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        reconnectAttempt = 0;
        connect();
      }
    };
    window.addEventListener("focus", onWindowFocus);
    // One path for typed data AND synthesized key encodings: buffer +
    // kick a reconnect when the socket is down — never silently drop.
    let lastTypeClaimAt = 0;
    const sendInput = (data: string) => {
      noteInteraction();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        pendingInput.push({ data, at: Date.now() });
        if (pendingInput.length > 200) pendingInput.shift();
        setConn("down");
        if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
          reconnectAttempt = 0;
          connect();
        }
        return;
      }
      ws.send(JSON.stringify({ type: "input", data }));
      // Typing in the tile reasserts its size (typing recency wins the
      // election). One claim per burst, not per keystroke.
      const now = Date.now();
      if (!ownsSize() && now - lastTypeClaimAt > 500) {
        lastTypeClaimAt = now;
        sendClaim();
      }
    };
    // Reserved chords — everything else (Enter, Escape, arrows…) belongs
    // to the remote app: ⌘⏎/Ctrl⏎ opens the session full screen, ⌘./Ctrl+.
    // releases focus back to the wall.
    term.attachCustomKeyEventHandler((ev) => {
      // ⌘F leaves the tile: find belongs to the switcher's filter, and this
      // is the escape hatch when the tile holds the keyboard. The event
      // still bubbles to the window handler, which focuses the filter.
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "f") {
        if (ev.type === "keydown") onUnfocus();
        return false;
      }
      // Shift+Enter must reach the app as a distinct key (Claude Code:
      // newline, not submit). xterm.js would emit a plain \r — synthesize
      // the kitty CSI-u encoding under the same gate as the main terminal:
      // the app negotiated enhanced keyboard reporting, or it's Claude Code
      // (parses CSI-u unconditionally but no longer advertises the
      // protocol at boot). A plain shell renders raw CSI-u as junk, hence
      // the gate.
      if (ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey
          && (kbdEnhanced || claudeAppRef.current)) {
        if (ev.type === "keydown") sendInput("\x1b[13;2u");
        return false;
      }
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key === "Enter") {
        if (ev.type === "keydown") onFullscreen();
        return false;
      }
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key === ".") {
        if (ev.type === "keydown") onUnfocus();
        return false;
      }
      return true;
    });
    const sub = term.onData(sendInput);
    const ro = new ResizeObserver(() => {
      // Box changed (viewport/tile-size): refit our claim if we hold the
      // size; otherwise just rescale the observed grid.
      if (ownsSize()) sendClaim();
      else rescale();
    });
    ro.observe(box);
    // A rejected focus-claim (someone typed in that session <5s ago — often
    // an agent) left the tile zoomed-out until the user typed. Re-claim
    // quietly while the user has RECENTLY ENGAGED the tile (clicked or
    // typed within 10s) so the view converges once the peer goes idle. Not
    // gated on DOM focus: a tile left focused while the user works in
    // another window must never steal the size.
    let interactedAt = Date.now();
    const noteInteraction = () => { interactedAt = Date.now(); };
    // Clicking INTO a tile that lost the size takes it back — the click is
    // as deliberate as the one that focused it.
    const onBoxPointerDown = () => {
      noteInteraction();
      if (!ownsSize() && !claimPending) sendClaim("attach", true);
    };
    box.addEventListener("pointerdown", onBoxPointerDown);
    const retryTimer = window.setInterval(() => {
      if (!claimPending && !ownsSize() && ws && ws.readyState === WebSocket.OPEN
          && Date.now() - interactedAt < 10_000) {
        sendClaim("attach");
      }
    }, 1000);
    const focusTimer = window.setTimeout(() => { term.focus(); rescale(); }, 50);
    return () => {
      disposed = true;
      window.clearTimeout(focusTimer);
      window.clearTimeout(unveilTimer);
      window.clearTimeout(claimTimer);
      window.clearTimeout(reconnectTimer);
      window.clearInterval(retryTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onWindowFocus);
      box.removeEventListener("pointerdown", onBoxPointerDown);
      ro.disconnect();
      sub.dispose();
      try { ws?.close(); } catch { /* closing */ }
      term.dispose();
    };
  }, [wsBase, room, userName, theme, fontSize]);
  return (
    <div className="switcher-focus-tile" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <div className="switcher-focus-bar">
        <span className={`switcher-focus-label${conn === "down" ? " down" : ""}`}>
          {conn === "down" ? "connection lost — reconnecting…" : "interactive — ⌘⏎ full screen · ⌘. release"}
        </span>
        <button type="button" title="Open full screen" aria-label="Open session full screen" onClick={onFullscreen}>⛶</button>
        <button type="button" title="Unfocus" aria-label="Unfocus tile" onClick={onUnfocus}>✕</button>
      </div>
      <div className="switcher-focus-term" ref={boxRef} data-fallback={fallback ? "" : "empty"}>
        {veiled && <pre className="switcher-focus-veil" aria-hidden="true">{fallback || " "}</pre>}
      </div>
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
  userName,
  terminalTheme,
  onOpenSettings,
  onToggleKeyboard,
  onFind
}: Props) => {
  const [filter, setFilter] = useState("");
  const [originScope, setOriginScope] = useState<SessionOriginScope>("user");
  // Tile zoom: bigger tiles show more of each terminal preview.
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem("hay_tile_zoom");
    if (saved !== null && /^\d+$/.test(saved)) {
      return Math.min(Number(saved), ZOOM_LEVELS.length - 1);
    }
    const legacy = localStorage.getItem("hay_tile_size");
    if (legacy && legacy in LEGACY_ZOOM) return LEGACY_ZOOM[legacy];
    return DEFAULT_ZOOM;
  });
  // Grid content width, kept fresh across viewport/panel resizes — it decides
  // how far the zoom ladder is climbable on THIS screen.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      setGridWidth(w > 0 ? w : 0);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);
  // Ceiling: the first level that lays out as ONE full-width column. A tile
  // already spanning the whole grid has nothing left to grow into.
  const maxZoom = useMemo(() => {
    if (!gridWidth) return ZOOM_LEVELS.length - 1;
    for (let i = 0; i < ZOOM_LEVELS.length; i++) {
      if (Math.floor((gridWidth + GRID_GAP) / (ZOOM_LEVELS[i].min + GRID_GAP)) <= 1) return i;
    }
    return ZOOM_LEVELS.length - 1;
  }, [gridWidth]);
  const effectiveZoom = Math.min(zoom, maxZoom);
  const zoomLevel = ZOOM_LEVELS[effectiveZoom];
  // Above the threshold every active tile is one click away from being a real
  // terminal (the focused tile below). Announced once per open via onNotice;
  // the ⌨ chip in the header is the standing indicator.
  const interactiveTiles = effectiveZoom >= INTERACTIVE_ZOOM && !!tileWsBase;
  const noticedInteractiveRef = useRef(false);
  useEffect(() => { if (open) noticedInteractiveRef.current = false; }, [open]);
  const changeZoom = (next: number) => {
    const clamped = Math.max(0, Math.min(next, maxZoom));
    if (clamped === effectiveZoom) return;
    if (clamped >= INTERACTIVE_ZOOM && effectiveZoom < INTERACTIVE_ZOOM && tileWsBase && !noticedInteractiveRef.current) {
      noticedInteractiveRef.current = true;
      onNotice("Tiles are interactive at this zoom — click one to type in it (⌘⏎ full screen, ⌘. release)");
    }
    setZoom(clamped);
    localStorage.setItem("hay_tile_zoom", String(clamped));
  };
  // Organization mode: recent (tiers), project (grouped by workdir), or manual
  // (a persisted drag order). Persisted so the choice sticks across sessions.
  const [sortMode, setSortMode] = useState<SwitcherSortMode>(() => {
    const saved = localStorage.getItem("hay_sort_mode");
    return saved === "project" || saved === "manual" ? saved : "recent";
  });
  const changeSortMode = (mode: SwitcherSortMode) => {
    setSortMode(mode);
    localStorage.setItem("hay_sort_mode", mode);
    // A deliberate re-sort is the one time reordering is EXPECTED — drop the
    // frozen capture so the new mode lays out fresh.
    frozenOrderRef.current = null;
  };
  // Project view density: sectional (a header per project) vs compact (one
  // continuous grid — the card's workdir line already names the project).
  // Sections waste rows when most projects hold one or two sessions.
  const [projectCompact, setProjectCompact] = useState(() => localStorage.getItem("hay_project_compact") === "1");
  const changeProjectCompact = (compact: boolean) => {
    setProjectCompact(compact);
    localStorage.setItem("hay_project_compact", compact ? "1" : "0");
  };
  // Manual drag order: the ordered list of session keys. Seeded lazily from
  // the current recency order the first time the user drags, so nothing jumps.
  const [manualOrder, setManualOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("hay_manual_order_v1") || "[]");
      return Array.isArray(saved) ? saved.filter((k) => typeof k === "string") : [];
    } catch {
      return [];
    }
  });
  const persistManualOrder = (order: string[]) => {
    setManualOrder(order);
    try {
      localStorage.setItem("hay_manual_order_v1", JSON.stringify(order));
    } catch {
      /* quota — order is best-effort */
    }
  };
  const [dragKey, setDragKey] = useState<string | null>(null);
  // A focused tile is a live terminal: making the whole card draggable would
  // hijack text selection inside it. So it becomes draggable only while the
  // pointer is down on its HEADER — grab the title bar to move it, drag
  // inside the terminal to select text.
  const [dragArmKey, setDragArmKey] = useState<string | null>(null);
  useEffect(() => {
    if (!dragArmKey) return;
    const disarm = () => setDragArmKey(null);
    window.addEventListener("pointerup", disarm);
    window.addEventListener("dragend", disarm);
    return () => {
      window.removeEventListener("pointerup", disarm);
      window.removeEventListener("dragend", disarm);
    };
  }, [dragArmKey]);
  // Live reorder while dragging: dragging over a card moves the dragged
  // session to that card's index immediately, so the grid reflows in real
  // time and the drop is just a release. Index-move semantics keep this
  // stable (the classic sortable-hover pattern): after the move the hovered
  // card occupies the dragged card's old index, so re-entering it computes
  // from === to and no-ops instead of oscillating. Seeds the order from the
  // current visual sequence on first drag so untouched sessions keep place.
  const moveManual = (from: string | null, to: string) => {
    if (!from || from === to) return;
    const current = flatNavRef.current.map(sessionKey);
    const base = manualOrder.length ? manualOrder.slice() : current;
    // Ensure every visible session is represented before moving.
    for (const k of current) if (!base.includes(k)) base.push(k);
    const fromIdx = base.indexOf(from);
    const toIdx = base.indexOf(to);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    base.splice(fromIdx, 1);
    base.splice(toIdx, 0, from);
    persistManualOrder(base);
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
  // The wall's single interactive tile. Cleared on close / zooming below the
  // interactive threshold.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  useEffect(() => { if (!open) setFocusedKey(null); }, [open]);
  useEffect(() => { if (!interactiveTiles) setFocusedKey(null); }, [interactiveTiles]);
  const [renameDraft, setRenameDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [, setTick] = useState(0);
  // Preview cache survives page reloads via sessionStorage: a freshly loaded
  // page paints last-known screens instantly instead of a wall of blanks.
  const previewCacheRef = useRef<Map<string, PreviewFrame> | null>(null);
  if (!previewCacheRef.current) {
    const seeded = new Map<string, PreviewFrame>();
    try {
      const saved = JSON.parse(sessionStorage.getItem("hop_preview_cache_v1") || "[]") as Array<[string, string]>;
      // Text-only on purpose: the reload seed just needs to paint something
      // instantly; color arrives with the first live refresh.
      for (const [k, v] of saved) seeded.set(k, { text: v });
    } catch { /* corrupt or absent — start empty */ }
    previewCacheRef.current = seeded;
  }
  const persistPreviewCache = () => {
    try {
      const entries = Array.from(previewCacheRef.current!.entries()).map(
        ([k, v]) => [k, v.text.length > 4000 ? v.text.slice(-4000) : v.text] as [string, string]
      );
      sessionStorage.setItem("hop_preview_cache_v1", JSON.stringify(entries));
    } catch { /* quota — previews are best-effort */ }
  };
  const longPressRef = useRef<{ timer: number; startX: number; startY: number } | null>(null);
  // Set when a long-press opened the sheet, so the click that fires on finger
  // release doesn't also switch sessions.
  const suppressTapRef = useRef(false);

  const visibleSessions = useMemo(
    () => filterSessionsByOrigin(sessions, originScope),
    [sessions, originScope]
  );
  // Parked sessions leave the wall but stay one glance away in a collapsed
  // section — and the FILTER still searches them, so a parked session is
  // never more than ⌘K + a few letters from coming back.
  const wallSessions = useMemo(() => visibleSessions.filter((s) => !s.parked), [visibleSessions]);
  const parkedSessions = useMemo(() => visibleSessions.filter((s) => s.parked), [visibleSessions]);
  const [parkedOpen, setParkedOpen] = useState(false);
  // While the switcher is OPEN the wall's ORDER freezes at what the user
  // first saw: attention/recency resorting yanked tiles around mid-scan
  // (and out from under a focused tile's hands). Contents still refresh —
  // fresh session objects are looked up by key — and activity shows IN
  // PLACE (the active-now glow + attention dots) instead of as movement.
  // The order recaptures on reopen or when the user changes scope/sort;
  // sessions that vanish drop out; brand-new ones append at the end rather
  // than reshuffling the wall.
  const frozenOrderRef = useRef<{ mode: "tiers" | "project"; hero: string[]; groups: Array<{ label: string; rows: string[] }> } | null>(null);
  useEffect(() => { if (!open) frozenOrderRef.current = null; }, [open]);
  const model = useMemo(() => {
    // A filter query searches EVERYTHING (parked included); the browsing
    // wall shows only unparked sessions.
    const pool = filter.trim() ? visibleSessions : wallSessions;
    const live = buildSwitcherModel(pool, currentRoom, filter, sortMode, manualOrder);
    if (!open || (live.mode !== "tiers" && live.mode !== "project")) return live;
    let frozen = frozenOrderRef.current;
    if (!frozen || frozen.mode !== live.mode) {
      frozen = live.mode === "tiers"
        ? {
            mode: "tiers",
            hero: live.hero.map(sessionKey),
            groups: live.groups.map((g) => ({ label: g.label, rows: g.rows.map(sessionKey) }))
          }
        : {
            mode: "project",
            hero: [],
            groups: live.groups.map((g) => ({ label: g.label, rows: g.rows.map(sessionKey) }))
          };
      frozenOrderRef.current = frozen;
      return live;
    }
    const byKey = new Map(pool.map((s) => [sessionKey(s), s]));
    const knownKeys = new Set([...frozen.hero, ...frozen.groups.flatMap((g) => g.rows)]);
    const fresh = pool.filter((s) => !knownKeys.has(sessionKey(s)));
    const resolve = (keys: string[]) => keys.map((k) => byKey.get(k)).filter((s): s is SwitcherSession => !!s);
    if (live.mode === "tiers") {
      return {
        mode: "tiers" as const,
        // New sessions join at the end of the hero wall — visible without
        // displacing anything the user is already looking at.
        hero: [...resolve(frozen.hero), ...fresh],
        groups: frozen.groups
          .map((g) => ({ label: g.label, rows: resolve(g.rows) }))
          .filter((g) => g.rows.length > 0),
        currentInHero: live.currentInHero
      };
    }
    // Project mode: a new session lands in its own project's frozen group
    // when one exists, otherwise in a trailing group.
    const groups = frozen.groups.map((g) => ({ label: g.label, rows: resolve(g.rows) }));
    for (const s of fresh) {
      const label = s.type === "port" ? "Ports" : projectKey(s.cwd);
      const g = groups.find((x) => x.label === label);
      if (g) g.rows.push(s);
      else groups.push({ label, rows: [s] });
    }
    return { mode: "project" as const, groups: groups.filter((g) => g.rows.length > 0) };
  }, [open, visibleSessions, wallSessions, currentRoom, filter, sortMode, manualOrder, originScope]);

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
    () => {
      if (model.mode === "filter") return [...model.rows, ...extraContentMatches.map((m) => m.session)];
      if (model.mode === "manual") return model.rows;
      if (model.mode === "project") return model.groups.flatMap((g) => g.rows);
      return [...model.hero, ...model.groups.flatMap((g) => g.rows)];
    },
    [model, extraContentMatches]
  );
  const navIndexByKey = useMemo(() => {
    const m = new Map<string, number>();
    flatNav.forEach((s, i) => m.set(sessionKey(s), i));
    return m;
  }, [flatNav]);
  // Latest visual order, for reorderManual (defined earlier in the component).
  const flatNavRef = useRef(flatNav);
  flatNavRef.current = flatNav;

  // Default selection: the first session that isn't the current one (Enter on
  // open = jump to most relevant other session); with a filter, the top match.
  useEffect(() => {
    if (!open) return;
    // Anchor the selection on the CURRENT session: a stable, predictable start
    // (arrow keys move from there). Auto-selecting the first OTHER session
    // saved one keypress but made every open feel like the cursor teleported.
    const currentIdx = flatNav.findIndex((s) => currentRoom !== null && (s.internalName === currentRoom || s.name === currentRoom));
    setKbdIndex(filter ? 0 : Math.max(0, currentIdx));
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
      // While the focused tile owns the keyboard, Escape belongs to the
      // remote app (vim, claude) — unfocus is the ✕ or a click outside.
      if (document.activeElement?.closest?.(".switcher-focus-tile")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (sheet) setSheet(null);
        else if (focusedKey) setFocusedKey(null);
        else if (dismissable) onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet, focusedKey]);

  // Tile previews: EVERY session gets a preview tile. Hot tiles (the
  // attention/recency heroes) refresh each tick; the long tail refreshes at a
  // quarter of that rate — 30+ tiles stay cheap, and the daemon only renders
  // previews on demand anyway. Paused while the tab is hidden.
  const lastColdRefreshRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Hot = the hero tiles in recency mode. A filter's result set is small,
    // so every match is hot — its preview is the evidence the user is
    // scanning. The other modes have no hero tier; everything refreshes at
    // the cold rate.
    const hotKeys = new Set(
      model.mode === "tiers" ? model.hero.map(sessionKey)
      : model.mode === "filter" ? [...model.rows.map(sessionKey), ...contentMatches.map((m) => sessionKey(m.session))]
      : []
    );
    // EVERY session previews — dead ones serve their retained last screen
    // from the daemon, so a tile is never a blank box.
    const seenKeys = new Set<string>();
    const all = (
      model.mode === "tiers" ? [...model.hero, ...model.groups.flatMap((g) => g.rows)]
      : model.mode === "project" ? model.groups.flatMap((g) => g.rows)
      : model.mode === "filter" ? [...model.rows, ...contentMatches.map((m) => m.session)]
      : model.rows
    ).filter((s) => {
      if (s.type === "port") return false;
      const key = sessionKey(s);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
    const refresh = async () => {
      if (cancelled || document.hidden || all.length === 0) return;
      // Time-based cold tier (not tick-based: the first mount often races the
      // sessions fetch and would consume the cold slot on an empty list).
      const coldToo = Date.now() - lastColdRefreshRef.current > 15000;
      const targets = all.filter((s) => hotKeys.has(sessionKey(s)) || coldToo);
      await Promise.all(
        targets.map(async (s) => {
          const key = sessionKey(s);
          try {
            const res = await fetch(`/api/sessions/preview?name=${encodeURIComponent(key)}`);
            if (!res.ok) return;
            const data = await res.json();
            const text = typeof data.text === "string" ? data.text.replace(/\s+$/, "") : "";
            // The daemon serves exact grid screens now (or its own cached
            // good frame), so tiny frames are real screens — a fresh shell's
            // bare prompt must fill the tile, not be filtered as junk. Only
            // an empty frame never replaces existing content.
            if (!cancelled && text.trim().length > 0) {
              previewCacheRef.current!.set(key, {
                text,
                color: Array.isArray(data.color) ? (data.color as PreviewRun[][]) : null
              });
            }
          } catch {
            /* keep the cached preview */
          }
        })
      );
      if (cancelled) return;
      // Consume the cold slot only after an uncancelled sweep: a model change
      // mid-sweep otherwise burned the slot and left cold tiles blank for
      // another 15s, repeatedly.
      if (coldToo) lastColdRefreshRef.current = Date.now();
      persistPreviewCache();
      setTick((t) => t + 1);
    };
    refresh();
    const id = window.setInterval(refresh, PREVIEW_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, model, contentMatches]);

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
    // Opening a parked session IS unparking it — best-effort, never blocking
    // the switch itself.
    if (session.parked) {
      fetch("/api/sessions/park", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(session), parked: false })
      }).catch(() => { /* daemon will still show it parked; harmless */ });
    }
    onSwitch(session);
  };

  // Arrow/Enter navigation + type-anywhere filtering. The action sheet and
  // the create form own the keyboard while open.
  useEffect(() => {
    if (!open) return;
    const onNavKey = (event: KeyboardEvent) => {
      if (sheet || creating) return;
      // ⌘F/Ctrl+F: the switcher's find IS the filter box — never browser
      // find. Handled BEFORE the focused-tile guard so it's the rescue hatch
      // when a tile owns the keyboard: unfocus, jump to the filter.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFocusedKey(null);
        filterInputRef.current?.focus();
        setKbdIndex(-1);
        return;
      }
      if (document.activeElement?.closest?.(".switcher-focus-tile")) return;
      // ⌘⏎ (Ctrl⏎): focus the selected tile for in-place interaction.
      // Plain Enter stays "switch to session" — the muscle-memory action.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        const target = flatNav[kbdIndex];
        if (target && interactiveTiles && target.active && target.type !== "port") {
          event.preventDefault();
          setFocusedKey(sessionKey(target));
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // +/− step the tile zoom — but never while editing the filter text
      // ("-" is a legal character in session names).
      if (document.activeElement !== filterInputRef.current) {
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          changeZoom(effectiveZoom + 1);
          return;
        }
        if (event.key === "-") {
          event.preventDefault();
          changeZoom(effectiveZoom - 1);
          return;
        }
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "ArrowRight") {
        // ←→ must keep editing the filter text when there is any.
        if (
          (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
          document.activeElement === filterInputRef.current &&
          (filterInputRef.current?.value || "").length > 0
        ) {
          return;
        }
        event.preventDefault();
        setKbdIndex((i) => {
          // Selection parked in the filter box (-1): ↓ re-enters the wall at
          // the top; the other arrows stay in the box.
          if (i === -1) {
            if (event.key === "ArrowDown") {
              requestAnimationFrame(() => {
                document.querySelector('[data-nav-index="0"]')?.scrollIntoView({ block: "nearest" });
              });
              return 0;
            }
            return -1;
          }
          // Geometric navigation: the wall is a grid, the tail is rows — pick
          // the nearest tile in the pressed direction from real layout, so
          // all four arrows work in every mode without column bookkeeping.
          const els = Array.from(document.querySelectorAll<HTMLElement>("[data-nav-index]"));
          if (els.length === 0) return 0;
          const cur = els.find((el) => Number(el.dataset.navIndex) === i) ?? els[0];
          const cr = cur.getBoundingClientRect();
          const cx = cr.left + cr.width / 2;
          const cy = cr.top + cr.height / 2;
          let best: { idx: number; score: number } | null = null;
          for (const el of els) {
            const idx = Number(el.dataset.navIndex);
            if (idx === i || Number.isNaN(idx)) continue;
            const r = el.getBoundingClientRect();
            const dx = r.left + r.width / 2 - cx;
            const dy = r.top + r.height / 2 - cy;
            let primary: number;
            let cross: number;
            if (event.key === "ArrowDown") { primary = dy; cross = Math.abs(dx); }
            else if (event.key === "ArrowUp") { primary = -dy; cross = Math.abs(dx); }
            else if (event.key === "ArrowRight") { primary = dx; cross = Math.abs(dy); }
            else { primary = -dx; cross = Math.abs(dy); }
            if (primary < 4) continue; // wrong direction (or same row/col slot)
            const score = primary + cross * 3;
            if (!best || score < best.score) best = { idx, score };
          }
          // ↑ with nothing above: the search box sits above the wall — park
          // the selection there so the top row flows into the filter.
          if (!best && event.key === "ArrowUp") {
            requestAnimationFrame(() => filterInputRef.current?.focus());
            return -1;
          }
          const next = best ? best.idx : i;
          requestAnimationFrame(() => {
            document.querySelector(`[data-nav-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
          });
          return next;
        });
        return;
      }
      // Plain Enter only: Shift+Enter is a terminal keystroke (newline in
      // claude) — when a focused tile has lost DOM focus it must fall
      // through to NOTHING here, not switch the session to full screen.
      if (event.key === "Enter" && !event.shiftKey) {
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
  }, [open, sheet, creating, flatNav, kbdIndex, effectiveZoom, maxZoom, interactiveTiles]);

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
        // Address by internal name: display names can collide, and then
        // renaming by display name picks an arbitrary one of the two.
        body: JSON.stringify({ oldName, newName: next, internalName: sessionKey(sheet.session) })
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
  // Park: hide from the wall, keep running — instant bring-back via the
  // parked section or the filter. Unparking also clears the archived flag.
  const togglePark = async () => {
    if (!sheet) return;
    const next = sheet.session.parked !== true;
    try {
      const res = await fetch("/api/sessions/park", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(sheet.session), parked: next })
      });
      if (!res.ok) {
        onNotice("Failed to update park state");
        return;
      }
      onNotice(next ? "Parked — find it under “parked” at the bottom" : "Back on the wall");
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Failed to update park state");
    }
  };
  // Archive: stop the process but stay resumable — the daemon pre-writes the
  // resume command into the session's startup, so reopening it later picks
  // the conversation back up.
  const archiveSession = async () => {
    if (!sheet) return;
    try {
      const res = await fetch("/api/sessions/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(sheet.session) })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { error?: string }));
        onNotice(data.error || "Failed to stop session");
        return;
      }
      onNotice("Stopped & parked — opening it later resumes the conversation");
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Failed to stop session");
    }
  };
  const startRename = (s: SwitcherSession, anchor?: { x: number; y: number }) => {
    setRenameDraft(s.displayName || s.name);
    // Anchor is REQUIRED by the sheet's positioning math — a missing one
    // crashed the render (the ⋯ gray-screen bug's sibling). Default centers.
    setSheet({
      session: s,
      mode: "rename",
      anchor: anchor ?? { x: window.innerWidth / 2 + 132, y: window.innerHeight / 3 }
    });
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

  // `snippet` (search content hits): the matching output line, shown under
  // the preview so the card says WHY it matched.
  const renderCard = (s: SwitcherSession, snippet?: string) => {
    const key = sessionKey(s);
    const preview = previewCacheRef.current!.get(key);
    const current = isCurrentSession(s);
    const kbdSelected = navIndexByKey.get(key) === kbdIndex;
    // The frozen wall trades movement for a signal-in-place: a session
    // producing output RIGHT NOW glows instead of jumping to the top.
    // Window comfortably exceeds the 10s relative-time tick so a busy
    // session's glow holds steady rather than flickering between polls.
    const activeNow = !current && now - (s.lastActivityAt || 0) < 12000;
    // Manual mode: cards are draggable to reorder. The focused tile drags
    // from its header only (see dragArmKey) so its terminal keeps the
    // pointer for text selection; every other card drags from anywhere.
    const isFocusedCard = focusedKey === key;
    const draggable = sortMode === "manual" && (!isFocusedCard || dragArmKey === key);
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        data-nav-index={navIndexByKey.get(key)}
        className={`switcher-card${current ? " current" : ""}${activeNow ? " active-now" : ""}${kbdSelected ? " kbd-selected" : ""}${focusedKey === key ? " focused" : ""}${dragKey === key ? " dragging" : ""}${draggable ? " draggable" : ""}`}
        draggable={draggable}
        onDragStart={draggable ? (e) => { setDragKey(key); e.dataTransfer.effectAllowed = "move"; } : undefined}
        onDragEnter={draggable ? () => { if (dragKey && dragKey !== key) moveManual(dragKey, key); } : undefined}
        onDragOver={draggable ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } : undefined}
        // Order was already applied live during the drag — drop/end just clean up.
        onDrop={draggable ? (e) => { e.preventDefault(); setDragKey(null); } : undefined}
        onDragEnd={draggable ? () => setDragKey(null) : undefined}
        onClick={(e) => {
          // Only a click on the TERMINAL AREA focuses the tile — clicking
          // the header/name/meta switches. A whole-card focus target meant
          // any stray click at interactive zoom silently rerouted the
          // keyboard into that session ("typing goes to a terminal").
          const el = e.target as HTMLElement | null;
          const onTerminalArea = !!el?.closest?.(".switcher-preview, .switcher-focus-tile");
          if (interactiveTiles && s.active && s.type !== "port" && onTerminalArea) setFocusedKey(key);
          else handleTap(s);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            // ⌘⏎ focuses the tile; plain Enter switches (mirrors onNavKey).
            if ((e.metaKey || e.ctrlKey) && interactiveTiles && s.active && s.type !== "port") setFocusedKey(key);
            else handleTap(s);
          }
        }}
        {...pressHandlers(s)}
      >
        <div
          className={`switcher-card-head${sortMode === "manual" && isFocusedCard ? " drag-handle" : ""}`}
          onPointerDown={sortMode === "manual" && isFocusedCard ? () => setDragArmKey(key) : undefined}
        >
          {dots(s)}
          <span className="switcher-card-name">{s.displayName}</span>
          {current && <span className="switcher-chip current">CURRENT</span>}
          {originScope === "all" && s.createdBy === "agent" && (
            <span className="switcher-chip agent">AGENT</span>
          )}
          {!current && s.starting && !s.active && <span className="switcher-chip starting">STARTING</span>}
          {waitingOnUser(preview) && (
            <span className="switcher-chip waiting" title="Claude is asking how to resume this conversation — open it and choose">
              NEEDS YOU
            </span>
          )}
          {inlineActions(s)}
        </div>
        {/* Tagline sits directly under the name: it explains the session the
            way the name can't. Hidden at dense zooms where the card has no
            room for a second text line. */}
        {s.tagline && <div className="switcher-card-tagline" title={s.tagline}>{s.tagline}</div>}
        {interactiveTiles && tileWsBase && s.active && s.type !== "port" && focusedKey === key ? (
          <FocusedTile
            wsBase={tileWsBase}
            room={key}
            userName={userName || "user"}
            theme={terminalTheme}
            fallback={preview?.text || " "}
            fontSize={parseInt(zoomLevel.fs, 10) || 11}
            claudeApp={appLabel(s) === "claude"}
            onFullscreen={() => onSwitch(s)}
            onUnfocus={() => setFocusedKey(null)}
          />
        ) : (
          <pre className="switcher-preview" aria-hidden="true">
            {preview?.color?.length ? renderPreviewRuns(preview.color) : (preview?.text || " ")}
          </pre>
        )}
        {snippet && <div className="switcher-card-snippet" title={snippet}>{snippet}</div>}
        <div className="switcher-card-meta">
          <span className="switcher-card-dir" title={s.cwd || undefined}>{dirPath(s) ? `\u200E${dirPath(s)}\u200E` : "\u00a0"}</span>
          <span className="switcher-card-when">{meta(s)}</span>
        </div>
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
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); startRename(s, { x: r.right, y: r.bottom }); }}
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
      // tile-dense: too narrow for inline actions. tile-micro: too short for
      // a second text line at all — the tagline shows from the DEFAULT zoom
      // up (hiding it there meant nobody ever saw one).
      className={`switcher-overlay${zoomLevel.min < 300 ? " tile-dense" : ""}${zoomLevel.min < 150 ? " tile-micro" : ""}${dismissable ? "" : " switcher-hub"}${dismissable && fullscreen ? " switcher-fullscreen" : ""}`}
      style={{ "--tile-min": `${zoomLevel.min}px`, "--tile-h": zoomLevel.h, "--tile-fs": zoomLevel.fs } as CSSProperties}
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
          {originScope !== "agent" && (
            <button
              type="button"
              className="switcher-new-top"
              title="New session"
              aria-label="New session"
              onClick={() => setCreating(true)}
            >
              ＋ New
            </button>
          )}
          <div className="switcher-tilesize" role="group" aria-label="Tile zoom">
            <button
              type="button"
              aria-label="Smaller tiles"
              title="Smaller tiles (−)"
              disabled={effectiveZoom <= 0}
              onClick={() => changeZoom(effectiveZoom - 1)}
            >
              −
            </button>
            <span className="switcher-zoom-readout" aria-hidden="true">
              {effectiveZoom + 1}
            </span>
            <button
              type="button"
              aria-label="Bigger tiles"
              title={effectiveZoom >= maxZoom ? "Tiles already span the full width" : "Bigger tiles (+)"}
              disabled={effectiveZoom >= maxZoom}
              onClick={() => changeZoom(effectiveZoom + 1)}
            >
              +
            </button>
          </div>
          {interactiveTiles && (
            <span
              className="switcher-chip live"
              title="Tiles are live terminals at this zoom — click one to type in it. ⌘⏎ opens it full screen, ⌘. releases it."
            >
              ⌨ interactive
            </span>
          )}
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
                  // Scope change relays a different population — refreeze.
                  frozenOrderRef.current = null;
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="switcher-origin switcher-sort" role="group" aria-label="Organize sessions by">
            {([
              ["recent", "Recent", "Most recently active first"],
              ["project", "Project", "Grouped by working directory"],
              ["manual", "Manual", "Your own drag order"]
            ] as const).map(([mode, label, title]) => (
              <button
                key={mode}
                type="button"
                className={sortMode === mode ? "active" : ""}
                aria-pressed={sortMode === mode}
                title={title}
                onClick={() => changeSortMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          {sortMode === "project" && (
            <div className="switcher-origin switcher-density" role="group" aria-label="Project view density">
              {([
                [false, "Sections", "A header per project"],
                [true, "Compact", "One continuous grid — the project is on each card"]
              ] as const).map(([compact, label, title]) => (
                <button
                  key={label}
                  type="button"
                  className={projectCompact === compact ? "active" : ""}
                  aria-pressed={projectCompact === compact}
                  title={title}
                  onClick={() => changeProjectCompact(compact)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {/* Always rendered: it is the palette's focus home. When it wasn't
              (coarse pointer + a short list) there was nowhere to put focus,
              so keystrokes fell through to the terminal behind. */}
          <input
            ref={filterInputRef}
            className={`switcher-filter${finePointer || visibleSessions.length > FILTER_THRESHOLD || filter ? "" : " compact"}`}
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter sessions"
          />
        </div>
        {/* Create form lives in the top bar so the header ＋ works from EVERY
            mode — the dashed grid card only exists in recent mode. */}
        {creating && (
          <form className="switcher-create-row inline-edit" onSubmit={submitCreate}>
            <input
              placeholder="session-name"
              value={createDraft}
              onChange={(e) => setCreateDraft(e.target.value)}
              maxLength={64}
              autoFocus
              aria-label="New session name"
            />
            <button type="submit">Create</button>
            <button type="button" onClick={() => { setCreating(false); setCreateDraft(""); }}>✕</button>
          </form>
        )}
      </div>
      <div className="switcher-scroll" ref={scrollRef}>
        {model.mode === "filter" ? (
          // Matches keep their terminal previews: search results are preview
          // cards at the current zoom, same as the wall — the screen content
          // is usually WHY you're looking for the session.
          <>
            {model.rows.length === 0 && extraContentMatches.length === 0 ? (
              <div className="switcher-empty">No sessions match “{filter.trim()}”</div>
            ) : (
              <div className="switcher-grid">{model.rows.map((s) => renderCard(s))}</div>
            )}
            {extraContentMatches.length > 0 && (
              <section className="switcher-group">
                <h3 className="switcher-group-label">found in terminal output</h3>
                <div className="switcher-grid">
                  {extraContentMatches.map(({ session: s, snippet }) => renderCard(s, snippet))}
                </div>
              </section>
            )}
          </>
        ) : model.mode === "project" ? (
          <>
            {originScope === "agent" && visibleSessions.length === 0 && (
              <div className="switcher-empty">No agent sessions</div>
            )}
            {projectCompact ? (
              // Compact: group ORDER is kept (recency-ranked projects), but
              // everything flows in one grid — the card's workdir line names
              // the project, so section headers only cost rows.
              <div className="switcher-grid">
                {model.groups.flatMap((group) => group.rows).map((s) => renderCard(s))}
              </div>
            ) : (
              model.groups.map((group) => (
                <section key={group.label} className="switcher-group">
                  <h3 className="switcher-group-label">{group.label}</h3>
                  <div className="switcher-grid">{group.rows.map((s) => renderCard(s))}</div>
                </section>
              ))
            )}
          </>
        ) : model.mode === "manual" ? (
          <>
            {model.rows.length === 0 ? (
              <div className="switcher-empty">No sessions</div>
            ) : (
              <>
                <p className="switcher-hint">Drag tiles to reorder</p>
                <div className="switcher-grid">{model.rows.map((s) => renderCard(s))}</div>
              </>
            )}
          </>
        ) : (
          <>
            {originScope === "agent" && visibleSessions.length === 0 && (
              <div className="switcher-empty">No agent sessions</div>
            )}
            <div className="switcher-grid">
              {model.hero.map((s) => renderCard(s))}
              {originScope !== "agent" && !creating && (
                <button type="button" className="switcher-card new" onClick={() => setCreating(true)}>
                  <span className="switcher-new-plus">+</span>
                  <span>New session</span>
                </button>
              )}
            </div>
            {model.groups.map((group) => (
              <section key={group.label} className="switcher-group">
                <h3 className="switcher-group-label">{group.label}</h3>
                <div className="switcher-grid">{group.rows.map((s) => renderCard(s))}</div>
              </section>
            ))}
          </>
        )}
        {model.mode !== "filter" && parkedSessions.length > 0 && (
          <section className="switcher-group switcher-parked">
            <button
              type="button"
              className="switcher-parked-toggle"
              aria-expanded={parkedOpen}
              onClick={() => setParkedOpen((v) => !v)}
            >
              {parkedOpen ? "▾" : "▸"} parked · {parkedSessions.length}
            </button>
            {parkedOpen && (
              <div className="switcher-rows">
                {parkedSessions.map((s) => {
                  const key = sessionKey(s);
                  return (
                    <div
                      key={key}
                      role="button"
                      tabIndex={0}
                      className="switcher-row parked"
                      onClick={() => handleTap(s)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) handleTap(s); }}
                      {...pressHandlers(s)}
                    >
                      {dots(s)}
                      <span className="switcher-row-name">{s.displayName}</span>
                      <span className="switcher-chip">{s.active ? "PARKED" : "STOPPED"}</span>
                      {s.tagline && <span className="switcher-row-dir">{s.tagline}</span>}
                      <span className="switcher-row-meta">{meta(s)}</span>
                      {inlineActions(s)}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
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
                {sheetSession.type !== "port" && (
                  <button type="button" onClick={togglePark}>
                    {sheetSession.parked ? "Unpark session" : "Park session"}
                  </button>
                )}
                {sheetSession.type !== "port" && sheetSession.active && (
                  <button type="button" onClick={archiveSession}>
                    Stop &amp; park (resumable)
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
