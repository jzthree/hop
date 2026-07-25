import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties, type FormEvent, type ReactElement, type PointerEvent as ReactPointerEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  safeParseServerMessage,
  type PresenceClient,
  type ClientMessage
} from "hay-shared";
import { activityLabel, sortPresence } from "./utils/presence";
import { createOptimisticEcho } from "./utils/optimisticEcho";
import { scanKeyboardProtocol } from "./utils/keyboardProtocol";
import { originalPathHint } from "./utils/fileDrop";
import { MobileKeyboard } from "./components/MobileKeyboard";
import { SessionSwitcher } from "./components/SessionSwitcher";
import { SecondaryPane } from "./components/SecondaryPane";

const createRoomId = () => `room-${Math.random().toString(36).slice(2, 7)}`;

const isMacPlatform = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

// Web haptics only exist where the Vibration API does (Android/Chromium). iOS
// Safari has no web haptic API — the old <input switch> trick was removed in
// iOS 17.4 — so we hide the toggle there rather than show a dead control.
const hapticsSupported = typeof navigator.vibrate === "function";

// Browser notifications are opt-in and only offered where the Notification
// API exists (iOS Safari lacks it outside installed PWAs) — hide the toggle
// elsewhere rather than show a dead control.
const notificationsSupported = typeof window !== "undefined" && "Notification" in window;

const parseSessionNameFromPath = (pathname: string) => {
  const match = pathname.match(/^\/s\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const getLocationRoom = () => {
  const pathRoom = parseSessionNameFromPath(window.location.pathname);
  if (pathRoom) {
    return pathRoom;
  }
  return new URLSearchParams(window.location.search).get("room");
};

const buildSessionPath = (sessionName: string) => `/s/${encodeURIComponent(sessionName)}/`;

const resolveWsUrl = () => {
  // Check for hop session config (when embedded in hop)
  const hopSession = (window as unknown as { __HOP_SESSION__?: { wsUrl?: string } }).__HOP_SESSION__;
  if (hopSession?.wsUrl) {
    const { protocol, host } = window.location;
    const wsProtocol = protocol === "https:" ? "wss" : "ws";
    return `${wsProtocol}://${host}${hopSession.wsUrl}`;
  }
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL as string;
  }
  const { protocol, hostname, host } = window.location;
  const wsProtocol = protocol === "https:" ? "wss" : "ws";
  if (import.meta.env.DEV) {
    return `${wsProtocol}://${hostname}:4001/ws`;
  }
  return `${wsProtocol}://${host}/ws`;
};

const formatStatus = (client: PresenceClient) => {
  const state = activityLabel(client);
  if (state === "typing") {
    return "typing";
  }
  if (state === "active") {
    return "active";
  }
  return "idle";
};

const createShareLink = (room: string) => {
  const url = new URL(window.location.href);
  url.searchParams.set("room", room);
  url.searchParams.delete("name");
  return url.toString();
};

const darkTerminalTheme = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#60a5fa",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  selectionForeground: "#e6edf3",
  black: "#0d1117",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e5e7eb",
  brightBlack: "#6b7280",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f9fafb"
};

// Light theme modeled on iTerm2's "Light Background" profile
const lightTerminalTheme = {
  background: "#ffffff",
  foreground: "#000000",
  cursor: "#000000",
  cursorAccent: "#ffffff",
  selectionBackground: "#b5d5ff",
  selectionForeground: "#000000",
  selectionInactiveBackground: "#d0d0d0",
  black: "#000000",
  red: "#c91b00",
  green: "#00a600",
  yellow: "#c7c400",
  blue: "#0225c7",
  magenta: "#c930c7",
  cyan: "#00a6b2",
  white: "#c7c7c7",
  brightBlack: "#676767",
  brightRed: "#ff6d67",
  brightGreen: "#5ff967",
  brightYellow: "#fefb67",
  brightBlue: "#6871ff",
  brightMagenta: "#ff76ff",
  brightCyan: "#5ffdff",
  brightWhite: "#feffff"
};

// Contrast floor, applied ONLY on the light theme. xterm rewrites every
// foreground color to meet this ratio against the background, which visibly
// desaturates the mid-tones a TUI like Claude Code paints with — its output
// looked washed out next to the same app in iTerm. Agent palettes assume a
// dark background, so on our dark theme (#0d1117, close to that assumption)
// no correction is needed and colors render faithfully. The light theme
// still needs it, or dark-tuned near-white text lands on white.
const contrastFloorFor = (mode: string) => (resolveTerminalTheme(mode) === lightTerminalTheme ? 4.5 : 1);

const resolveTerminalTheme = (mode: string) => {
  if (mode === "dark") return darkTerminalTheme;
  if (mode === "light") return lightTerminalTheme;
  // "system" — check media query
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return darkTerminalTheme;
  }
  return lightTerminalTheme;
};

const isMobileDevice = () => {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod|Android/i.test(ua) || window.innerWidth < 768;
};

/** Shorten a path for display: replace home dir with ~ and truncate long paths. */
const shortenPath = (cwdPath: string) => {
  if (!cwdPath) return "";
  let display = cwdPath;
  const homeMatch = cwdPath.match(/^(\/(?:Users|home)\/[^/]+)(\/.*)?$/);
  if (homeMatch) {
    display = "~" + (homeMatch[2] || "");
  } else if (cwdPath === "/root") {
    display = "~";
  } else if (cwdPath.startsWith("/root/")) {
    display = "~" + cwdPath.slice(5);
  }
  return display;
};

type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "ended";

// Latency compensation (optimistic echo) and auto-fit-on-type are always on;
// kept as constants so the gated code paths stay obvious.
// ── Pane layout tree ─────────────────────────────────────────────────────
// Splits are a full binary tree (direction + ratio + two children) so future
// layouts (nested splits, 2x2 grids) need no model changes — today's UI just
// happens to build one split at a time. The primary leaf (session: null) is
// the full-featured terminal; other leaves are lightweight SecondaryPanes.
type PaneNode =
  | { kind: "leaf"; id: string; session: string | null }
  | { kind: "split"; id: string; dir: "row" | "col"; ratio: number; a: PaneNode; b: PaneNode };

const PRIMARY_PANE: PaneNode = { kind: "leaf", id: "primary", session: null };
const newPaneId = () => `p${Math.random().toString(36).slice(2, 8)}`;

const paneTreeValid = (n: unknown): n is PaneNode => {
  const x = n as PaneNode;
  if (!x || typeof x !== "object") return false;
  if (x.kind === "leaf") return typeof x.id === "string" && (x.session === null || typeof x.session === "string");
  if (x.kind === "split") {
    return (x.dir === "row" || x.dir === "col") && typeof x.ratio === "number" && paneTreeValid(x.a) && paneTreeValid(x.b);
  }
  return false;
};
const paneTreeHasPrimary = (n: PaneNode): boolean =>
  n.kind === "leaf" ? n.session === null : paneTreeHasPrimary(n.a) || paneTreeHasPrimary(n.b);

const LATENCY_COMP = true;
const AUTO_FIT_ON_TYPE = true;

type SessionSwitchMode = "page" | "instant";
const DEFAULT_SESSION_SWITCH_MODE: SessionSwitchMode = "instant";
const SESSION_LIST_STALE_MS = 5000;
// Offline-typed input: replay window and buffer bound (see pendingInputRef).
const PENDING_INPUT_MAX_AGE_MS = 15000;
const PENDING_INPUT_MAX_ENTRIES = 200;

type SessionInfo = {
  name: string;
  displayName: string;
  active: boolean;
  starting: boolean;
  type?: "terminal" | "port";
  port?: number;
  cwd?: string;
  internalName?: string;
  lastActivityAt?: number;
  bellSeq?: number;
  foregroundProcess?: string;
  agentPermitted?: boolean;
  createdBy?: "user" | "agent";
  // Computed against the local seen-markers: new output / an unseen bell since
  // this client last viewed the session.
  unread?: boolean;
  bellUnseen?: boolean;
};

// Check if embedded in Hop
const getHopSession = () =>
  (window as unknown as { __HOP_SESSION__?: { room?: string; wsUrl?: string; name?: string } }).__HOP_SESSION__;
// Any injected config means hop served this page (session pages carry a room;
// the landing/hub page carries none). Standalone hay has no injection at all.
const isEmbeddedInHop = () => !!getHopSession();

// Display name resolution: an explicit ?name= wins, then the name the user set
// on this device, then the login identity hop injects (never the legacy
// "Guest" placeholder), then a generic fallback.
const resolveInitialName = () => {
  const fromParams = new URLSearchParams(window.location.search).get("name");
  const stored = localStorage.getItem("hay_name");
  const injected = getHopSession()?.name;
  return fromParams ?? stored ?? (injected && injected !== "Guest" ? injected : null) ?? "User";
};

// Per-session "seen" markers, shared with the session manager page via
// localStorage (same origin). Keyed by internal session name; values are the
// server's own lastActivityAt/bellSeq so no cross-device clock comparison
// ever happens.
type SeenMarker = { out: number; bell: number };
const SEEN_MARKERS_KEY = "hop_session_seen_v1";
const loadSeenMarkers = (): Record<string, SeenMarker> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_MARKERS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};
const saveSeenMarkers = (markers: Record<string, SeenMarker>) => {
  try {
    localStorage.setItem(SEEN_MARKERS_KEY, JSON.stringify(markers));
  } catch {
    /* quota/private mode — indicators just stay baseline */
  }
};

// The classic iOS activity indicator: 12 tapered blades around a circle, each
// fading in turn so the "light" chases around the ring. Pure CSS/DOM — no image.
const IosSpinner = ({ size = 34 }: { size?: number }) => (
  <span className="ios-spinner" style={{ width: size, height: size }} aria-hidden="true">
    {Array.from({ length: 12 }).map((_, i) => (
      <span
        key={i}
        style={{
          transform: `rotate(${i * 30}deg) translate(0, -${size * 0.34}px)`,
          animationDelay: `${-(11 - i) / 12}s`
        }}
      />
    ))}
  </span>
);

const App = () => {
  const hopSession = getHopSession();
  const initialRoom = hopSession?.room ?? getLocationRoom() ?? createRoomId();

  const [name, setName] = useState(() => resolveInitialName());
  const [room, setRoom] = useState(() => initialRoom);
  // Auto-start session when embedded in Hop (skip join page)
  const [session, setSession] = useState<{ name: string; room: string } | null>(() => {
    if (hopSession?.room) {
      return { name: resolveInitialName(), room: initialRoom };
    }
    return null;
  });
  const [sessionLabel, setSessionLabel] = useState(() => initialRoom);
  const [liveCwd, setLiveCwd] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [presence, setPresence] = useState<PresenceClient[]>([]);
  const [collabMode, setCollabMode] = useState(true);
  const [controllerId, setControllerId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimeout = useRef<number | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInfo, setSearchInfo] = useState({ index: 0, total: 0 });
  const searchMatchesRef = useRef<Array<{ row: number; col: number }>>([]);
  const searchIndexRef = useRef(-1);
  const lastMatchPosRef = useRef<{ row: number; col: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Default the drawer FAB to the top-right (clear of the status bar), mirroring
  // the drawer's close button. It stays draggable; clampFab keeps it on-screen.
  const [fabPosition, setFabPosition] = useState({ x: window.innerWidth - 72, y: 64 });
  const fabDragRef = useRef<{ dragging: boolean; startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const [isMobile, setIsMobile] = useState(() => isMobileDevice());
  const [keyboardVisible, setKeyboardVisible] = useState(() => isMobileDevice());
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [selectionMode, setSelectionMode] = useState(() => {
    const saved = localStorage.getItem("hay_selection_mode");
    return saved === "true";
  });
  const [hapticsEnabled, setHapticsEnabled] = useState(() => {
    const saved = localStorage.getItem("hay_haptics_enabled");
    return saved !== "false";
  });
  const [notifyBells, setNotifyBells] = useState(() => {
    const saved = localStorage.getItem("hay_notify_bells");
    return notificationsSupported && saved === "true";
  });
  type ThemeMode = "system" | "light" | "dark";
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem("hay_theme") as ThemeMode) || "system";
  });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionsError, setSessionsError] = useState(false);
  // Attention plumbing: tab-title alert for a bell in the attached session
  // while the tab is hidden; inline editors for display name / rename / create.
  const [titleAlert, setTitleAlert] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renamingSession, setRenamingSession] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [newSessionName, setNewSessionName] = useState("");
  // On mobile the preview-grid switcher is the home screen: land on it so the
  // first thing you see is your sessions, not a single terminal. The current
  // session still connects underneath, so tapping its card is instant. Desktop
  // (persistent sidebar) and standalone (no session API) keep the terminal-first
  // landing.
  //
  // Deep links are the exception: opening /s/Venus/ names a session — go
  // straight to it instead of parking the visitor on the grid while every
  // other session's preview loads. The grid stays one FAB tap away.
  // ?home=1 overrides: the daemon redirects mobile roots to the most recent
  // session with that flag, so the grid is still the first paint on "home"
  // while the freshest session connects underneath.
  const [switcherOpen, setSwitcherOpen] = useState(() => {
    if (!isEmbeddedInHop()) return false;
    // ?home=1 = "this is the landing page": the daemon redirects / and
    // /sessions here so the switcher grid is the first paint on EVERY device,
    // with the freshest session already connecting underneath.
    if (new URLSearchParams(window.location.search).has("home")) return true;
    return isMobileDevice() && !window.location.pathname.startsWith("/s/");
  });
  const [sessionSwitchMode, setSessionSwitchMode] = useState<SessionSwitchMode>(() => {
    const saved = localStorage.getItem("hay_session_switch_mode");
    // Keep "page" as a legacy fallback while we validate instant mode end-to-end.
    if (saved === "page") {
      return "page";
    }
    return DEFAULT_SESSION_SWITCH_MODE;
  });

  useEffect(() => {
    if (session?.room) {
      setSessionLabel(session.room);
    }
  }, [session?.room]);
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem("hay_font_size");
    return saved ? parseInt(saved, 10) : 14;
  });
  const [viewMode, setViewMode] = useState<"fit" | "full">(() => {
    const saved = localStorage.getItem("hay_view_mode");
    if (saved === "fit" || saved === "full") return saved;
    // Default to autofit on every platform so the terminal is readable on
    // connect without panning; fit re-runs on each session load (snapshot
    // replay). Switch to Manual in the drawer to keep the remote's own size.
    // (Autofit resizes the shared PTY, so other viewers follow this client.)
    return "fit";
  });

  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // Last shared size announced by the server (the active typer's size). Used
  // to restore the remote's true shape when switching view mode to Manual —
  // fit mode may have resized the local terminal (and re-wrapped the buffer)
  // to this viewport in the meantime.
  const activeSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const optimisticEchoRef = useRef(createOptimisticEcho());
  const optimisticPrevRef = useRef(false);
  const typingTimeout = useRef<number | null>(null);
  const viewportTouchRef = useRef<{
    start?: (ev: TouchEvent) => void;
    move?: (ev: TouchEvent) => boolean;
  } | null>(null);

  // Keep isMobile in sync with the viewport. It's used to gate mobile-only
  // controls (keyboard toggle, Find, Touch, the virtual keyboard) which must
  // match the CSS mobile breakpoint (<768px). Without this, loading wide then
  // resizing narrow leaves the JS in "desktop mode" while the CSS shows the
  // mobile drawer — so those controls silently disappear.
  useEffect(() => {
    const onResize = () => setIsMobile(isMobileDevice());
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("hay_selection_mode", selectionMode ? "true" : "false");
  }, [selectionMode]);
  useEffect(() => {
    localStorage.setItem("hay_haptics_enabled", hapticsEnabled ? "true" : "false");
  }, [hapticsEnabled]);
  useEffect(() => {
    localStorage.setItem("hay_notify_bells", notifyBells ? "true" : "false");
  }, [notifyBells]);
  useEffect(() => {
    localStorage.setItem("hay_theme", themeMode);
    const root = document.documentElement;
    if (themeMode === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", themeMode);
    }
    // Update terminal theme live
    if (termRef.current) {
      const t = termRef.current;
      const newTheme = resolveTerminalTheme(themeMode);
      t.options.theme = newTheme;
      // The floor is theme-dependent — switching themes must move it too.
      t.options.minimumContrastRatio = contrastFloorFor(themeMode);
      // xterm sets background-color inline on the viewport element — update it
      const viewport = containerRef.current?.querySelector('.xterm-viewport') as HTMLElement | null;
      if (viewport) {
        viewport.style.backgroundColor = newTheme.background ?? '';
      }
      // Force canvas re-render: clear the texture atlas and refresh all rows
      if (typeof (t as any).clearTextureAtlas === 'function') {
        (t as any).clearTextureAtlas();
      }
      t.refresh(0, t.rows - 1);
    }
  }, [themeMode]);
  useEffect(() => {
    localStorage.setItem("hay_session_switch_mode", sessionSwitchMode);
  }, [sessionSwitchMode]);

  const typingActive = useRef(false);
  const noticeTimeout = useRef<number | null>(null);
  const viewModeRef = useRef(viewMode);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);
  const connectNonceRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  // Whether the remote app is on the alternate screen (vim/less/Claude fullscreen).
  // Seeded from the server snapshot (message.alternateScreen) and kept live via the
  // xterm ?h/?l CSI handlers below. The alt-screen buffer has no scrollback, so a
  // local viewport scroll is a no-op there — touch scrolling must instead send the
  // app its own scroll keys (PageUp/PageDown). See the mobile touch handler.
  const remoteAltScreenRef = useRef(false);
  // Mouse tracking requested by the remote app (?1000/1002/1003) + SGR
  // encoding (?1006). When both are on, touch scrolling drives the app with
  // per-line SGR wheel events (smooth, momentum-capable) instead of Page keys.
  const remoteMouseReportingRef = useRef(false);
  const remoteMouseSgrRef = useRef(false);
  // Whether the remote app has enhanced keyboard reporting on (kitty keyboard
  // protocol / xterm modifyOtherKeys). xterm.js can't encode modified keys
  // itself, so when this is set we synthesize the sequences (e.g. Shift+Enter →
  // CSI 13;2u) that a protocol-aware terminal would send. Tracked from the
  // output/snapshot stream; the server's snapshot flag seeds reattach.
  const remoteKbdEnhancedRef = useRef(false);
  const lastDropToastRef = useRef(0);
  // Keystrokes typed while the socket is down are buffered per room and
  // replayed in order on reconnect — a mobile radio blip must not eat input.
  // Entries past the age cap are discarded rather than replayed: firing stale
  // keystrokes into a shell long after they were typed is worse than losing
  // them (the user has usually retyped by then).
  const pendingInputRef = useRef<Array<{ room: string; data: string; at: number }>>([]);
  // Presence re-render throttle (see the "presence" message handler).
  const presenceThrottleRef = useRef<number | null>(null);
  const presencePendingRef = useRef<PresenceClient[] | null>(null);
  const activeSessionRoomRef = useRef<string | null>(null);
  // Set each render once switchSession exists (defined later); the keyboard
  // layer calls through this ref to avoid declaration-order coupling.
  const switchSessionRef = useRef<((s: SessionInfo) => void) | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // Claude Code titles its process with a bare version number; hop's session
  // poll surfaces it as foregroundProcess. Used to unlock claude-specific key
  // encodings (Shift+Enter) without protocol negotiation.
  const foregroundIsClaude = () => {
    const room = activeSessionRoomRef.current;
    if (!room) return false;
    const s = sessionsRef.current.find((x) => (x.internalName || x.name) === room);
    const proc = (s?.foregroundProcess || "").trim();
    return proc === "claude" || /^\d+\.\d+\.\d+$/.test(proc);
  };
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  // Read at keystroke time by handleUserInput: while the session palette is
  // open, NOTHING typed may reach the session. Blurring the terminal on open
  // wasn't enough — on mobile the keyboard's hidden textarea keeps forwarding,
  // and any re-focus (pane change, fit, tap) re-opens the leak. Guarding the
  // single input path closes the whole class. The palette's own interactive
  // tile has its own socket and does not go through here.
  const switcherOpenRef = useRef(switcherOpen);
  switcherOpenRef.current = switcherOpen;
  const shortcutHelpRef = useRef(shortcutHelpOpen);
  shortcutHelpRef.current = shortcutHelpOpen;

  // ── Panes ──
  const [paneTree, setPaneTree] = useState<PaneNode>(() => {
    try {
      const raw = localStorage.getItem("hay_pane_tree");
      if (raw) {
        const t = JSON.parse(raw);
        if (paneTreeValid(t) && paneTreeHasPrimary(t)) return t;
      }
    } catch { /* fall through */ }
    return PRIMARY_PANE;
  });
  const [focusedPaneId, setFocusedPaneId] = useState("primary");
  const focusedPaneIdRef = useRef(focusedPaneId);
  focusedPaneIdRef.current = focusedPaneId;
  // ⌘\ opens the palette in pick-a-session-for-the-new-pane mode.
  // Holds the empty pane id awaiting a session from the palette (split-first-
  // then-fill), or null when the palette is a normal session switch.
  const paneTargetRef = useRef<string | null>(null);
  useEffect(() => {
    try {
      if (paneTree.kind === "leaf") localStorage.removeItem("hay_pane_tree");
      else localStorage.setItem("hay_pane_tree", JSON.stringify(paneTree));
    } catch { /* ignore */ }
  }, [paneTree]);

  // Split the focused pane, adding an EMPTY pane in the given direction (dir:
  // "row" = side-by-side, "col" = stacked). Returns the new empty pane's id so
  // the caller can focus it and open the palette to fill it (split-first, then
  // pick — matching tmux/iTerm muscle memory). Direct fill of an existing empty
  // pane is a separate op (fillPane).
  const splitEmpty = (dir: "row" | "col"): string => {
    const freshId = newPaneId();
    const fresh: PaneNode = { kind: "leaf", id: freshId, session: "" };
    setPaneTree((tree) => {
      const target = focusedPaneIdRef.current;
      // Rule: the PRIMARY leaf never re-parents (React would remount the live
      // xterm/WebGL terminal and kill it). Splits from the primary nest on the
      // secondary side; secondary leaves split in place (they tolerate remount).
      if (target === "primary" || tree.kind === "leaf") {
        if (tree.kind === "leaf") {
          return { kind: "split", id: "root", dir, ratio: 0.55, a: tree, b: fresh };
        }
        return { ...tree, b: { kind: "split", id: newPaneId(), dir, ratio: 0.5, a: tree.b, b: fresh } };
      }
      let done = false;
      const replace = (n: PaneNode): PaneNode => {
        if (n.kind === "leaf") {
          if (n.id !== target || done) return n;
          done = true;
          return { kind: "split", id: newPaneId(), dir, ratio: 0.5, a: n, b: fresh };
        }
        return { ...n, a: replace(n.a), b: replace(n.b) };
      };
      const next = replace(tree);
      return done ? next : { ...tree, b: { kind: "split", id: newPaneId(), dir, ratio: 0.5, a: (tree as Extract<PaneNode, { kind: "split" }>).b, b: fresh } };
    });
    return freshId;
  };
  const fillPane = (paneId: string, session: string) => {
    setPaneTree((tree) => setPaneLeafSession(tree, paneId, session));
  };
  // Split + immediately open the palette targeting the new empty pane.
  const splitAndPick = (dir: "row" | "col") => {
    const id = splitEmpty(dir);
    setFocusedPaneId(id);
    paneTargetRef.current = id;
    setSwitcherOpen(true);
  };
  const closePane = (id: string) => {
    if (id === "primary") return;
    setFocusedPaneId("primary");
    setPaneTree((tree) => {
      const prune = (n: PaneNode): PaneNode | null => {
        if (n.kind === "leaf") return n.id === id ? null : n;
        const a = prune(n.a);
        const b = prune(n.b);
        if (a && b) return { ...n, a, b };
        return a || b;
      };
      return prune(tree) || PRIMARY_PANE;
    });
  };
  const setPaneRatio = (id: string, ratio: number) => {
    setPaneTree((tree) => {
      const walk = (n: PaneNode): PaneNode =>
        n.kind === "split" ? (n.id === id ? { ...n, ratio } : { ...n, a: walk(n.a), b: walk(n.b) }) : n;
      return walk(tree);
    });
  };
  const paneTreeRef = useRef(paneTree);
  paneTreeRef.current = paneTree;
  const findPaneLeafSession = (n: PaneNode, id: string): string | null => {
    if (n.kind === "leaf") return n.id === id ? n.session : null;
    return findPaneLeafSession(n.a, id) ?? findPaneLeafSession(n.b, id);
  };
  const setPaneLeafSession = (n: PaneNode, id: string, session: string): PaneNode =>
    n.kind === "leaf"
      ? (n.id === id ? { ...n, session } : n)
      : { ...n, a: setPaneLeafSession(n.a, id, session), b: setPaneLeafSession(n.b, id, session) };
  // Promote: the pane's session becomes the primary and the primary's session
  // moves into the pane. Pure connection retargeting — the primary terminal's
  // DOM never moves (a remount would kill the live canvas); the pane
  // reconnects when its sessionName prop changes.
  const swapPaneWithPrimary = (paneId: string) => {
    const paneSession = findPaneLeafSession(paneTreeRef.current, paneId);
    const primaryRoom = activeSessionRoomRef.current;
    if (!paneSession || !primaryRoom || paneSession === primaryRoom) return;
    const target = sessionsRef.current.find((x) => x.name === paneSession || x.internalName === paneSession);
    if (!target) return;
    setPaneTree((tree) => setPaneLeafSession(tree, paneId, primaryRoom));
    switchSessionRef.current?.(target);
    setFocusedPaneId("primary");
  };
  // In-order leaves = visual left-to-right/top-to-bottom pane order.
  const paneOpsRef = useRef({ splitAndPick, closePane, swapPaneWithPrimary });
  paneOpsRef.current = { splitAndPick, closePane, swapPaneWithPrimary };
  const paneLeafIds = (n: PaneNode): string[] =>
    n.kind === "leaf" ? [n.id] : [...paneLeafIds(n.a), ...paneLeafIds(n.b)];
  const paneDragRef = useRef<{ id: string; dir: "row" | "col"; rect: DOMRect } | null>(null);
  const sessionListLoadedRef = useRef(false);
  const sessionListFetchedAtRef = useRef(0);
  // Monotonic fetch id so a stale in-flight /api/sessions response can't
  // overwrite a newer one (rename/kill refresh vs the periodic poll).
  const fetchSeqRef = useRef(0);
  // Bell-notification plumbing: the terminal effect that registers onBell runs
  // once per session, so it reads the live toggle/label through refs. The seq
  // map dedupes so each session notifies at most once per bellSeq value.
  const notifyBellsRef = useRef(notifyBells);
  const sessionLabelRef = useRef(sessionLabel);
  const prevBellUnseenRef = useRef<Record<string, boolean>>({});
  const notifiedBellSeqRef = useRef<Record<string, number>>({});

  useEffect(() => {
    notifyBellsRef.current = notifyBells;
  }, [notifyBells]);
  useEffect(() => {
    sessionLabelRef.current = sessionLabel;
  }, [sessionLabel]);

  const pushNotice = (message: string) => {
    setNotice(message);
    if (noticeTimeout.current) {
      window.clearTimeout(noticeTimeout.current);
    }
    noticeTimeout.current = window.setTimeout(() => {
      setNotice(null);
    }, 3000);
  };

  const showToast = (message: string, durationMs = 2000) => {
    setToast(message);
    if (toastTimeout.current) {
      window.clearTimeout(toastTimeout.current);
    }
    toastTimeout.current = window.setTimeout(() => {
      setToast(null);
    }, durationMs);
  };

  // Fire a browser notification for a bell. Clicking it focuses this tab and
  // runs the optional follow-up (e.g. switching to the session that rang).
  const fireBellNotification = (title: string, onClick?: () => void) => {
    if (!notificationsSupported || Notification.permission !== "granted") {
      return;
    }
    try {
      const notification = new Notification(title, { body: "Terminal bell" });
      notification.onclick = () => {
        window.focus();
        onClick?.();
        notification.close();
      };
    } catch {
      /* constructor can throw (e.g. Android Chrome wants a service worker) */
    }
  };

  const getVisibleText = () => {
    const terminal = termRef.current;
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(start + terminal.rows, buffer.length);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n").trimEnd();
  };

  const getBufferText = (maxLines = 0) => {
    const terminal = termRef.current;
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    const total = buffer.length;
    const start = maxLines > 0 ? Math.max(0, total - maxLines) : 0;
    const lines: string[] = [];
    for (let i = start; i < total; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n").trimEnd();
  };

  // ── Scrollback search ──
  const jumpToSearchMatch = (idx: number, len: number) => {
    const terminal = termRef.current;
    const matches = searchMatchesRef.current;
    if (!terminal || matches.length === 0) return;
    const i = ((idx % matches.length) + matches.length) % matches.length;
    searchIndexRef.current = i;
    const m = matches[i];
    lastMatchPosRef.current = { row: m.row, col: m.col };
    terminal.select(m.col, m.row, len);
    const target = Math.max(0, m.row - Math.floor(terminal.rows / 2));
    const scrollable = terminal as unknown as { scrollToLine?: (line: number) => void };
    scrollable.scrollToLine?.(target);
    userScrolledUpRef.current = true; // keep the match in view; don't snap to bottom on output
    setSearchInfo({ index: i + 1, total: matches.length });
  };

  // Scan the whole buffer (scrollback included) for the query. Positions are
  // absolute buffer rows, valid only until the next output/trim — callers
  // recompute before navigating.
  const collectMatches = (query: string) => {
    const terminal = termRef.current;
    if (!terminal || !query) return [];
    const buffer = terminal.buffer.active;
    const needle = query.toLowerCase();
    const matches: Array<{ row: number; col: number }> = [];
    const MAX = 2000;
    for (let row = 0; row < buffer.length && matches.length < MAX; row++) {
      const text = (buffer.getLine(row)?.translateToString(true) ?? "").toLowerCase();
      let from = 0;
      while (matches.length < MAX) {
        const idx = text.indexOf(needle, from);
        if (idx === -1) break;
        matches.push({ row, col: idx });
        from = idx + needle.length;
      }
    }
    return matches;
  };

  const runSearch = (query: string) => {
    const terminal = termRef.current;
    searchIndexRef.current = -1;
    lastMatchPosRef.current = null;
    const matches = collectMatches(query);
    searchMatchesRef.current = matches;
    if (!terminal || !query) {
      setSearchInfo({ index: 0, total: 0 });
      terminal?.clearSelection();
      return;
    }
    if (matches.length > 0) {
      // Start at the most recent match (bottom of the buffer)
      jumpToSearchMatch(matches.length - 1, query.length);
    } else {
      setSearchInfo({ index: 0, total: 0 });
      terminal.clearSelection();
    }
  };

  const searchStep = (dir: number) => {
    const terminal = termRef.current;
    const query = searchQuery;
    if (!terminal || !query) return;
    // Recompute on every navigation — rows shift as output streams in or scrollback trims
    const matches = collectMatches(query);
    searchMatchesRef.current = matches;
    if (matches.length === 0) {
      searchIndexRef.current = -1;
      lastMatchPosRef.current = null;
      setSearchInfo({ index: 0, total: 0 });
      terminal.clearSelection();
      return;
    }
    const prev = lastMatchPosRef.current;
    if (!prev) {
      jumpToSearchMatch(matches.length - 1, query.length);
      return;
    }
    let idx = matches.findIndex((m) => m.row === prev.row && m.col === prev.col);
    if (idx === -1) {
      // Buffer shifted under us — re-anchor at the nearest match at/after the old position
      idx = matches.findIndex((m) => m.row > prev.row || (m.row === prev.row && m.col >= prev.col));
      if (idx === -1) idx = matches.length - 1;
    }
    jumpToSearchMatch(idx + dir, query.length);
  };

  const openSearch = () => {
    setSearchActive(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const closeSearch = () => {
    setSearchActive(false);
    setSearchQuery("");
    searchMatchesRef.current = [];
    searchIndexRef.current = -1;
    lastMatchPosRef.current = null;
    setSearchInfo({ index: 0, total: 0 });
    termRef.current?.clearSelection();
    if (!isMobile) termRef.current?.focus();
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushNotice(`${label} copied (${text.split("\n").length} lines)`);
    } catch {
      pushNotice("Copy failed");
    }
  };

  useEffect(() => {
    activeSessionRoomRef.current = session?.room ?? null;
  }, [session?.room]);

  const shareUrl = useMemo(() => {
    if (session) {
      return createShareLink(sessionLabel || session.room);
    }
    return createShareLink(room);
  }, [session, room, sessionLabel]);

  const sortedPresence = useMemo(() => sortPresence(presence, clientId), [presence, clientId]);

  const controllerName = useMemo(() => {
    if (!controllerId) {
      return "";
    }
    return presence.find((client) => client.id === controllerId)?.name ?? "Someone";
  }, [presence, controllerId]);

  const optimisticActive =
    LATENCY_COMP && status === "connected" && !collabMode && controllerId === clientId;

  useEffect(() => {
    if (optimisticPrevRef.current && !optimisticActive) {
      optimisticEchoRef.current.reset();
    }
    optimisticPrevRef.current = optimisticActive;
  }, [optimisticActive]);

  useEffect(() => {
    viewModeRef.current = viewMode;
    localStorage.setItem("hay_view_mode", viewMode);
    // When switching to fit mode, refit terminal
    if (viewMode === "fit" && termRef.current) {
      setTimeout(() => {
        fitToViewport();
        handleResize();
      }, 0);
    }
    // Switching to Manual restores the shared (active) size: fit mode may have
    // shrunk the local terminal to this viewport, wrapping the buffer at a
    // width the PTY isn't. Back at the true size, overflow + panning work.
    if (viewMode === "full" && termRef.current && activeSizeRef.current) {
      const { cols, rows } = activeSizeRef.current;
      if (termRef.current.cols !== cols || termRef.current.rows !== rows) {
        termRef.current.resize(cols, rows);
      }
    }
  }, [viewMode]);

  const sendMessage = (message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  };

  // ── Drag-and-drop onto the terminal ──
  // A browser never reveals a dropped file's real path, so a file drop can't
  // paste one. Catch the drop and teach the working gesture instead: the
  // OS-specific copy-path hotkey (⌘⌥C in Finder / Ctrl+Shift+C in Explorer).
  // Dragged TEXT (a path string from anywhere) pastes normally.
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);
  const platformString = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  // Without these guards a drop that misses the target navigates the whole
  // page to the file, killing the session view.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const sendTyping = (active: boolean) => {
    sendMessage({ type: "typing", active });
  };

  const handleUserInput = (data: string) => {
    // The palette owns the keyboard while it's open — typed filter text must
    // never also land in the session behind it.
    if (switcherOpenRef.current) {
      return;
    }
    // Typing is "I am at the prompt": any earlier scroll-up turned
    // follow-mode OFF, so the line you just submitted (and everything the
    // app printed after it) stayed below the fold — the "I hit enter and
    // can't see my prompt" report. Every real terminal snaps to the bottom
    // on input; do the same.
    if (userScrolledUpRef.current) {
      userScrolledUpRef.current = false;
      termRef.current?.scrollToBottom();
    }
    // Strip focus reporting sequences that can be echoed back as visible text
    const sanitized = data.replace(/\x1b\[I/g, '').replace(/\x1b\[O/g, '');
    if (!sanitized) {
      return;
    }
    // Buffer input while disconnected instead of dropping it; the reconnect
    // handler replays it in order (same room, age-capped).
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      const room = activeSessionRoomRef.current;
      if (room) {
        pendingInputRef.current.push({ room, data: sanitized, at: Date.now() });
        if (pendingInputRef.current.length > PENDING_INPUT_MAX_ENTRIES) {
          pendingInputRef.current.shift();
        }
      }
      const kbDiagBuf = (window as any).__hopKbDiag;
      if (kbDiagBuf) kbDiagBuf.buf++;
      const now = Date.now();
      if (now - lastDropToastRef.current > 2000) {
        lastDropToastRef.current = now;
        showToast("Reconnecting — input buffered");
      }
      return;
    }
    const echoed = optimisticEchoRef.current.onInput(sanitized, optimisticActive);
    if (echoed) {
      writeToTerminal(echoed);
    }
    sendMessage({ type: "input", data: sanitized });
    const kbDiag = (window as any).__hopKbDiag;
    if (kbDiag) kbDiag.sent++;
    // Fit-on-type exists to reclaim the shared size when the user STARTS
    // typing (the input above makes this client the election winner) — once
    // per burst is enough. Running it on every keystroke forced a synchronous
    // layout (getComputedStyle/getBoundingClientRect) plus a resize message
    // per key, which on phones stalls the main thread long enough for iOS to
    // drop touches on the on-screen keyboard at normal typing speed.
    if (AUTO_FIT_ON_TYPE && viewModeRef.current === "fit") {
      const nowFit = Date.now();
      if (nowFit - lastTypeFitAtRef.current > 500) {
        lastTypeFitAtRef.current = nowFit;
        fitToViewport();
        // If another client holds the session at a different size, our fit can
        // equal the last size we sent (a rejected claim) — the dedupe guard
        // would swallow the reclaim. Typing is the election winner, so force
        // the resize through whenever the active size isn't ours.
        const active = activeSizeRef.current;
        const t = termRef.current;
        if (active && t && (active.cols !== t.cols || active.rows !== t.rows)) {
          lastSentSizeRef.current = null;
        }
        handleResize();
      }
    }
    if (!typingActive.current) {
      typingActive.current = true;
      sendTyping(true);
    }
    if (typingTimeout.current) {
      window.clearTimeout(typingTimeout.current);
    }
    typingTimeout.current = window.setTimeout(() => {
      typingActive.current = false;
      sendTyping(false);
    }, 1200);
  };

  // One-shot: armed when a snapshot loads (fresh session open/switch), consumed
  // by the next resize so it goes out as an attach claim.
  const attachClaimPendingRef = useRef(false);
  // Throttle gate for fit-on-type (one fit per typing burst, not per key).
  const lastTypeFitAtRef = useRef(0);
  // Ctrl+Q double-press arm deadline (CLI-parity kill binding).
  const killArmedAtRef = useRef(0);
  // Set by an explicit session switch; the next attach claim carries
  // user:true (deliberate — wins the size election outright on new hosts).
  const deliberateAttachRef = useRef(false);
  // Rooms the user asked full history for: their next connect replays the
  // server maximum instead of the fast bounded snapshot.
  const deepReplayRoomsRef = useRef(new Set<string>());
  const snapshotWasCappedRef = useRef(false);
  const [historyPillVisible, setHistoryPillVisible] = useState(false);
  // The ws handler needs the latest fetchSessions (declared later); assigned
  // each render, same pattern as switchSessionRef.
  const fetchSessionsRef = useRef<((o?: { showLoading?: boolean }) => void) | null>(null);
  // Last size actually sent, to skip redundant resize messages. Reset when a
  // new connection opens so the server always learns the size once.
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const handleResize = () => {
    if (!termRef.current) {
      return;
    }
    const claim = attachClaimPendingRef.current ? ("attach" as const) : undefined;
    attachClaimPendingRef.current = false;
    const cols = termRef.current.cols;
    const rows = termRef.current.rows;
    if (!claim && lastSentSizeRef.current && lastSentSizeRef.current.cols === cols && lastSentSizeRef.current.rows === rows) {
      return;
    }
    lastSentSizeRef.current = { cols, rows };
    const deliberate = claim === "attach" && deliberateAttachRef.current;
    if (deliberate) deliberateAttachRef.current = false;
    sendMessage({
      type: "resize",
      cols,
      rows,
      ...(claim ? { claim } : {}),
      ...(deliberate ? { user: true } : {})
    });
  };

  // Fit based on the scroll container viewport rather than the terminal element itself.
  // This ensures correct sizing across desktop padding and mobile full-bleed layouts.
  // Returns false when it couldn't measure yet (render service not ready, or the
  // container has no layout) so callers can retry on a later frame.
  const fitToViewport = (): boolean => {
    if (!termRef.current || !containerRef.current) return false;

    const terminal = termRef.current;
    const core = (terminal as any)._core;
    if (!core?._renderService?.dimensions?.css?.cell) return false;

    const cellWidth = core._renderService.dimensions.css.cell.width;
    const cellHeight = core._renderService.dimensions.css.cell.height;
    if (!cellWidth || !cellHeight) return false;

    const scrollContainer = containerRef.current.closest(".terminal-scroll");
    if (!scrollContainer) return false;

    const rect = scrollContainer.getBoundingClientRect();
    // No layout yet (e.g. the terminal mounted while the switcher covered it) —
    // report not-ready so the caller retries once it has real dimensions.
    if (rect.width < 1 || rect.height < 1) return false;
    const styles = window.getComputedStyle(scrollContainer);
    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const paddingRight = parseFloat(styles.paddingRight) || 0;
    const paddingTop = parseFloat(styles.paddingTop) || 0;
    const paddingBottom = parseFloat(styles.paddingBottom) || 0;

    const availableWidth = rect.width - paddingLeft - paddingRight;
    const availableHeight = rect.height - paddingTop - paddingBottom;

    const cols = Math.max(2, Math.floor(availableWidth / cellWidth));
    const rows = Math.max(1, Math.floor(availableHeight / cellHeight));

    if (terminal.cols !== cols || terminal.rows !== rows) {
      terminal.resize(cols, rows);
    }
    return true;
  };

  // Fit as soon as xterm can be measured, retrying across frames. A fresh session
  // load often calls fit before the render service has measured cell metrics (or
  // before the container is laid out), so a single pass silently bails and the
  // terminal is left at its stale size. Retrying until ready is what actually
  // makes "autofit after loading" reliable.
  const fitWhenReady = (attempts = 12, onFit?: () => void) => {
    if (viewModeRef.current !== "fit") return;
    if (fitToViewport()) {
      handleResize();
      onFit?.();
      return;
    }
    if (attempts > 0) {
      requestAnimationFrame(() => fitWhenReady(attempts - 1, onFit));
    }
  };

  const writeToTerminal = (data: string) => {
    if (!termRef.current) {
      return;
    }

    // Filter focus reporting sequences that can leak as visible text
    const filtered = data.replace(/\x1b\[I/g, '').replace(/\x1b\[O/g, '');
    termRef.current.write(filtered, () => {
      // Auto-scroll to bottom unless the user has explicitly scrolled up
      if (!userScrolledUpRef.current) {
        termRef.current?.scrollToBottom();
      }
    });
  };

  const scheduleReconnect = (nextSession: { name: string; room: string }) => {
    if (!shouldReconnectRef.current) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 30000);
    reconnectAttemptRef.current += 1;

    pushNotice(`Reconnecting in ${Math.round(delay / 1000)}s...`);

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (shouldReconnectRef.current) {
        connect(nextSession);
      }
    }, delay);
  };

  const connect = (nextSession: { name: string; room: string }) => {
    const targetRoom = nextSession.room;
    // Clear any pending reconnect
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const connectionNonce = ++connectNonceRef.current;

    // A brand-new room may have no retained output, so the server sends no
    // snapshot. Reset at the connection boundary instead of relying on the
    // snapshot handler, or the previous room's screen and terminal modes can
    // survive and make the new prompt appear below old output (with mouse
    // reports rendered as junk text).
    remoteKbdEnhancedRef.current = false;
    remoteAltScreenRef.current = false;
    remoteMouseReportingRef.current = false;
    remoteMouseSgrRef.current = false;
    activeSizeRef.current = null;
    optimisticEchoRef.current.reset();
    userScrolledUpRef.current = false;
    termRef.current?.reset();

    // Fast first paint: the daemon can serialize the session's CURRENT
    // screen from its preview grid in one small response — paint that
    // immediately so the switch shows content while the WS snapshot's
    // ~384KB download+parse is still in flight (the dominant switch cost on
    // a phone over the tunnel). The snapshot handler reset()s the terminal
    // before writing, so this paint is fully superseded; if the snapshot
    // wins the race, the response is discarded. Best-effort throughout.
    let snapshotLanded = false;
    fetch(`/api/sessions/screen?name=${encodeURIComponent(targetRoom)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((screen: { data?: string; cols?: number; rows?: number } | null) => {
        if (!screen || typeof screen.data !== "string" || !screen.data) return;
        if (connectionNonce !== connectNonceRef.current || activeSessionRoomRef.current !== targetRoom) return;
        if (snapshotLanded || !termRef.current) return;
        // Paint at the session's real dims — writing a 250-col screen into
        // an 80-col local grid would wrap into mush. The post-snapshot
        // autofit/claim dance re-sizes exactly as it does today.
        const cols = Number(screen.cols);
        const rows = Number(screen.rows);
        if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 1 && rows > 1
            && (termRef.current.cols !== cols || termRef.current.rows !== rows)) {
          try { termRef.current.resize(cols, rows); } catch { /* keep local size */ }
        }
        termRef.current.write(screen.data);
      })
      .catch(() => { /* fast paint is best-effort */ });

    const wsUrl = resolveWsUrl();
    const cols = termRef.current?.cols ?? 80;
    const rows = termRef.current?.rows ?? 24;
    // Bound the attach snapshot: long-lived sessions sit at the server's
    // 1.5MB replay cap, and downloading + parsing that on every switch cost
    // ~1s through the tunnel — switching stopped feeling instant once
    // buffers filled. 384KB keeps thousands of scrollback lines and lands in
    // ~0.3s worst-case. Scrolling to the very top offers a full-depth
    // reload (deepReplayRoomsRef); the CLI always replays full depth.
    const replay = deepReplayRoomsRef.current.has(nextSession.room) ? 1572864 : 393216;
    const url = `${wsUrl}?room=${encodeURIComponent(nextSession.room)}&name=${encodeURIComponent(
      nextSession.name
    )}&cols=${cols}&rows=${rows}&replay=${replay}`;

    wsRef.current?.close();
    setStatus("connecting");
    setHistoryPillVisible(false);
    shouldReconnectRef.current = true;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      if (connectionNonce !== connectNonceRef.current || activeSessionRoomRef.current !== targetRoom) {
        ws.close();
        return;
      }
      setStatus("connected");
      reconnectAttemptRef.current = 0; // Reset backoff on successful connection
      lastSentSizeRef.current = null; // fresh connection must learn the size once
      handleResize();
      // Replay keystrokes buffered during the outage: this room only, in
      // order, and only within the age window — stale input is discarded.
      const queued = pendingInputRef.current;
      pendingInputRef.current = [];
      if (queued.length > 0) {
        const nowMs = Date.now();
        const sameRoom = queued.filter((entry) => entry.room === targetRoom);
        const replayable = sameRoom.filter((entry) => nowMs - entry.at <= PENDING_INPUT_MAX_AGE_MS);
        if (replayable.length > 0) {
          ws.send(JSON.stringify({ type: "input", data: replayable.map((entry) => entry.data).join("") } satisfies ClientMessage));
          showToast(`Reconnected — sent ${replayable.length} buffered keystroke${replayable.length === 1 ? "" : "s"}`);
        }
        if (sameRoom.length > replayable.length) {
          showToast("Reconnected — stale buffered input discarded");
        }
      }
    });

    ws.addEventListener("message", (event) => {
      // close() does not guarantee that already-queued message events from the
      // old socket won't run. Never let one repopulate the freshly reset term.
      if (connectionNonce !== connectNonceRef.current || activeSessionRoomRef.current !== targetRoom) {
        return;
      }
      const message = safeParseServerMessage(event.data);
      if (!message) {
        return;
      }
      switch (message.type) {
        case "hello":
          setClientId(message.clientId);
          setCollabMode(message.collabMode);
          setControllerId(message.controllerId);
          break;
        case "presence":
          // Presence broadcasts arrive on every peer keystroke (typing
          // indicator) — re-rendering the whole app tree per remote key is
          // wasted main-thread time while output streams. Leading update for
          // immediacy, then at most one trailing update per 300ms window.
          if (presenceThrottleRef.current === null) {
            setPresence(message.clients);
            presenceThrottleRef.current = window.setTimeout(() => {
              presenceThrottleRef.current = null;
              if (presencePendingRef.current) {
                setPresence(presencePendingRef.current);
                presencePendingRef.current = null;
              }
            }, 300);
          } else {
            presencePendingRef.current = message.clients;
          }
          break;
        case "output":
          {
            remoteKbdEnhancedRef.current = scanKeyboardProtocol(message.data, remoteKbdEnhancedRef.current);
            const reconciled = optimisticEchoRef.current.reconcileOutput(message.data);
            if (reconciled) {
              writeToTerminal(reconciled);
            }
          }
          break;
        case "snapshot":
          // The authoritative replay has arrived — the fast-paint prefetch
          // must no longer touch the terminal.
          snapshotLanded = true;
          // Fresh connection: recompute from the snapshot. The server's tracked
          // flag wins when present (the enable may predate the retained buffer);
          // otherwise scan the replayed buffer itself from a clean slate.
          remoteKbdEnhancedRef.current = typeof message.keyboardEnhanced === "boolean"
            ? message.keyboardEnhanced
            : scanKeyboardProtocol(message.data, false);
          // Mouse-mode seed: the enables predate the replay tail (emitted once
          // at app startup), so the server's tracked flags are the only
          // signal. Reset UNCONDITIONALLY — stale true values from a previous
          // session on this connection made clients synthesize SGR mouse
          // reports at apps that never asked, which land as junk input
          // ("35;197;31M") at a shell prompt.
          remoteMouseReportingRef.current = message.mouseReporting === true;
          remoteMouseSgrRef.current = message.mouseSgr === true;
          optimisticEchoRef.current.reset();
          userScrolledUpRef.current = false;
          // A snapshot near the requested bound was almost certainly cut —
          // that's when the "load full history" pill is worth offering.
          snapshotWasCappedRef.current = typeof message.data === "string" && message.data.length >= 350000
            && !deepReplayRoomsRef.current.has(activeSessionRoomRef.current || "");
          if (termRef.current) {
            // reset() (not clear()) so a stale cursor column, SGR attrs, or
            // leftover alt-screen/mouse-reporting mode from the previous
            // connection don't bleed into the freshly replayed snapshot.
            termRef.current.reset();
          }
          writeToTerminal(message.data);
          // Seed alt-screen state from the snapshot: reset() above cleared xterm's
          // modes, and the rendered snapshot doesn't re-emit the DECSET that the
          // live ?h/?l handlers would catch, so the server's flag is the only signal.
          if (typeof message.alternateScreen === "boolean") {
            remoteAltScreenRef.current = message.alternateScreen;
          }
          if (termRef.current) {
            // Respect cursor visibility state after snapshot restore.
            if (typeof message.cursorHidden === "boolean") {
              termRef.current.write(message.cursorHidden ? '\x1b[?25l' : '\x1b[?25h');
            } else if (message.alternateScreen) {
              // Fallback for older servers: alternate screen apps generally hide the cursor.
              termRef.current.write('\x1b[?25l');
            }
          }
          // Auto-fit and scroll to end once after snapshot load. Retry across
          // frames so a not-yet-measured render service doesn't leave the fresh
          // session at a stale (often too-wide) size. The fit's resize goes out
          // as claim:"attach": opening a session is intent, so it takes the
          // shared size immediately unless a peer typed in the last few seconds
          // — without the claim it lost the 60s idle election to any recently
          // active client and the page sat mis-wrapped until the first
          // keystroke ("one autofit away").
          if (viewModeRef.current === "fit") {
            attachClaimPendingRef.current = true;
            fitWhenReady(12, () => termRef.current?.scrollToBottom());
          }
          break;
        case "collab":
          setCollabMode(message.enabled);
          setControllerId(message.controllerId);
          pushNotice(message.enabled ? "Collaborative typing enabled" : "Control locked to a single editor");
          break;
        case "input_rejected":
          pushNotice(message.reason);
          break;
        case "active_size":
          // Remember the active user's size for Manual mode (overflow/panning),
          // but in Auto-fit mode DON'T resize to it — the local terminal is sized
          // to this viewport, and applying the active size here is exactly what
          // clobbered the post-load autofit (mobile snapping to a desktop/PTY
          // 80×24). Manual mode still matches the active size for correct render.
          activeSizeRef.current = { cols: message.cols, rows: message.rows };
          if (termRef.current && viewModeRef.current !== "fit") {
            const currentCols = termRef.current.cols;
            const currentRows = termRef.current.rows;
            if (message.cols !== currentCols || message.rows !== currentRows) {
              termRef.current.resize(message.cols, message.rows);
            }
          }
          break;
        case "session_ended":
          shouldReconnectRef.current = false;
          pushNotice(message.by ? `${message.message} (by ${message.by})` : message.message);
          ws.close();
          setStatus("ended");
          // A dead screen is a dead end — bring up the switcher so the next
          // session is one keystroke away. Delayed a beat so the ended notice
          // registers before the overlay covers it. Refresh the list so the
          // dead session isn't still presented as a live/current entry.
          fetchSessionsRef.current?.({ showLoading: false });
          window.setTimeout(() => setSwitcherOpen(true), 400);
          break;
        case "session_renamed":
          setSessionLabel(message.displayName);
          pushNotice(`Session renamed to ${message.displayName}`);
          break;
        case "cwd_changed":
          setLiveCwd(message.cwd);
          break;
        default:
          break;
      }
    });

    ws.addEventListener("close", () => {
      if (connectionNonce !== connectNonceRef.current) {
        return;
      }
      if (activeSessionRoomRef.current !== targetRoom) {
        return;
      }
      if (!shouldReconnectRef.current) {
        return;
      }
      optimisticEchoRef.current.reset();
      setStatus("disconnected");
      scheduleReconnect(nextSession);
    });

    ws.addEventListener("error", () => {
      if (connectionNonce !== connectNonceRef.current) {
        return;
      }
      if (activeSessionRoomRef.current !== targetRoom || !shouldReconnectRef.current) {
        return;
      }
      optimisticEchoRef.current.reset();
      setStatus("disconnected");
      // Error is usually followed by close, so don't double-schedule
    });
  };

  useEffect(() => {
    if (!session || !terminalReady) {
      return;
    }
    connect(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, terminalReady, reconnectToken]);

  useEffect(() => {
    if (!session || !containerRef.current || termRef.current) {
      return;
    }

    const terminal = new Terminal({
      // Single source of truth with the switcher preview/focus tiles: xterm
      // takes a string (can't read the CSS var), so resolve --font-terminal
      // once. Same stack the preview <pre> uses → previews match the session.
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim()
        || "Menlo, Monaco, 'Courier New', monospace",
      fontSize,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 50000,
      // Mouse-wheel speed. xterm defaults to scrollSensitivity 1 = one line per
      // wheel notch, with no acceleration — painfully slow over a long history,
      // and it applies BOTH to the local scrollback viewport and to fullscreen
      // apps: on the alternate screen (Claude Code, less, man) xterm has no
      // local scrollback, so it emits one Up/Down arrow per notch — the same
      // getLinesScrolled() count, scaled by scrollSensitivity. Raising it makes
      // a notch move several lines everywhere. fastScrollSensitivity is the
      // Shift+wheel multiplier for blasting through very long transcripts.
      scrollSensitivity: 4,
      fastScrollSensitivity: 12,
      minimumContrastRatio: contrastFloorFor(themeMode),
      theme: resolveTerminalTheme(themeMode)
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    // Desktop: URLs become real links (handles line-wrapped OAuth monsters).
    // window.open inside the click handler keeps the popup-blocker happy.
    terminal.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      window.open(uri, "_blank", "noopener");
    }));
    terminal.open(containerRef.current);

    // GPU-accelerated rendering (same renderer VS Code uses). Must load after
    // open(). If WebGL isn't available (old GPU, blocklisted driver) the
    // constructor/load throws and we silently stay on the DOM renderer; if the
    // browser evicts the context later (backgrounded mobile tab), dispose the
    // addon and xterm falls back to the DOM renderer on its own.
    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = null;
      });
      terminal.loadAddon(webglAddon);
    } catch {
      webglAddon?.dispose();
      webglAddon = null;
    }

    fitAddon.fit();

    termRef.current = terminal;
    fitRef.current = fitAddon;
    fitWhenReady();

    // Register OSC handlers for sequences xterm.js doesn't fully support
    // These swallow the sequences so they don't appear as visible text
    const oscIds = [
      4,   // Color palette query/set
      10,  // Foreground color query/set
      11,  // Background color query/set
      12,  // Cursor color query/set
      52,  // Clipboard operations
      104, // Reset color palette
      110, // Reset foreground color
      111, // Reset background color
      112  // Reset cursor color
    ];
    for (const id of oscIds) {
      terminal.parser.registerOscHandler(id, () => true);
    }

    // Register CSI handlers for focus reporting sequences
    // ESC[I = Focus In, ESC[O = Focus Out
    terminal.parser.registerCsiHandler({ final: 'I' }, () => true);
    terminal.parser.registerCsiHandler({ final: 'O' }, () => true);

    // A bell in the attached session while the tab is hidden marks the title
    // so the user can spot "my agent finished/asked something" from another tab.
    terminal.onBell(() => {
      if (document.hidden) {
        setTitleAlert(true);
        // One xterm bell is one server bellSeq increment, so firing once per
        // event keeps the attached session at one notification per bellSeq.
        if (notifyBellsRef.current) {
          fireBellNotification(sessionLabelRef.current || activeSessionRoomRef.current || "Terminal");
        }
      }
    });

    // Track the remote's alternate-screen state live so touch scrolling knows
    // whether to scroll the local viewport or send the app its own scroll keys.
    // ESC[?47h / ESC[?1047h / ESC[?1049h enter alt-screen; the `l` variants exit.
    // We only observe (update the ref) and return false so xterm still applies the
    // mode itself (switching buffers). Params can carry sub-params (number[]).
    const ALT_SCREEN_PARAMS = new Set([47, 1047, 1049]);
    const MOUSE_TRACK_PARAMS = new Set([1000, 1002, 1003]);
    const trackAltScreen = (params: (number | number[])[], enabled: boolean) => {
      for (const p of params) {
        const n = Array.isArray(p) ? p[0] : p;
        if (ALT_SCREEN_PARAMS.has(n)) remoteAltScreenRef.current = enabled;
        if (MOUSE_TRACK_PARAMS.has(n)) remoteMouseReportingRef.current = enabled;
        if (n === 1006) remoteMouseSgrRef.current = enabled;
      }
      return false; // let xterm's default handler apply the mode
    };
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => trackAltScreen(params, true));
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => trackAltScreen(params, false));

    setTerminalReady(true);

    // On mobile, disable the terminal's internal textarea to prevent:
    // 1. Native keyboard from appearing when touching terminal
    // 2. Double input from xterm's internal event handling
    if (isMobile) {
      const textarea = containerRef.current.querySelector('textarea');
      if (textarea) {
        textarea.setAttribute('readonly', 'true');
        textarea.setAttribute('tabindex', '-1');
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
      }
    } else {
      // Desktop: register onData for keyboard input
      terminal.onData(handleUserInput);
    }

    // Prevent browser from intercepting common terminal shortcuts
    terminal.attachCustomKeyEventHandler((event) => {
      // Shift+Enter: xterm.js would emit a plain \r (indistinguishable from
      // Enter), which apps like Claude Code treat as "submit". Synthesize the
      // kitty-protocol encoding (CSI 13;2u) when the remote app negotiated
      // enhanced keyboard reporting — OR when the foreground process is
      // Claude Code, which parses CSI-u unconditionally but (since ~July
      // 2026 builds) no longer advertises the protocol at boot, so waiting
      // for the enable never fires. A plain shell renders raw CSI-u as junk
      // text, hence the gate stays.
      if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
          && (remoteKbdEnhancedRef.current || foregroundIsClaude())) {
        if (event.type === 'keydown') {
          event.preventDefault();
          handleUserInput('\x1b[13;2u');
        }
        return false;
      }
      // Ctrl+Q ×2 kills the session — parity with the hop CLI binding. Two
      // presses within 2s, same confirm rhythm as the CLI (no modal).
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'q') {
        if (event.type === 'keydown') {
          const nowKill = Date.now();
          if (nowKill > killArmedAtRef.current) {
            killArmedAtRef.current = nowKill + 2000;
            pushNotice("Press Ctrl+Q again to kill this session for ALL participants");
          } else {
            killArmedAtRef.current = 0;
            sendMessage({ type: "kill_session" });
          }
        }
        return false;
      }
      // Cmd/Ctrl+F opens scrollback search instead of the browser's native find
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        if (event.type === 'keydown') {
          event.preventDefault();
          openSearch();
        }
        return false;
      }
      // Allow ctrl+shift+c/v for copy/paste
      if (event.ctrlKey && event.shiftKey && (event.key === 'c' || event.key === 'v')) {
        return false;
      }
      // Capture all other ctrl key combinations for the terminal
      if (event.ctrlKey && !event.altKey && !event.metaKey) {
        return true;
      }
      return true;
    });

    const resizeObserver = new ResizeObserver(() => {
      // Only auto-fit in fit mode
      if (viewModeRef.current === "fit") {
        fitToViewport();
        // Force a full refresh to clear any stale canvas content after resize
        terminal.refresh(0, terminal.rows - 1);
        handleResize();
      }
    });
    (terminal as any).__resizeObserver = resizeObserver;

    const scrollContainer = containerRef.current.closest(".terminal-scroll");
    if (scrollContainer) {
      resizeObserver.observe(scrollContainer);
    }

    // Track user scroll to implement follow-mode:
    // Auto-scroll stays on until the user scrolls up, and resumes when they scroll back to bottom.
    const xtermViewport = containerRef.current.querySelector('.xterm-viewport');
    if (xtermViewport) {
      xtermViewport.addEventListener('scroll', () => {
        const el = xtermViewport as HTMLElement;
        const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 5;
        userScrolledUpRef.current = !atBottom;
        // Hitting the very TOP of a bounded-replay buffer means the user
        // wants more history than the fast snapshot carried — offer the
        // full-depth reload.
        setHistoryPillVisible(el.scrollTop <= 2 && snapshotWasCappedRef.current);
      });
    }

    if (import.meta.env.VITE_E2E === "true") {
      (window as any).__hay = {
        terminal,
        getWebglAddon: () => webglAddon,
        getBufferText: () => {
          const buffer = terminal.buffer.active;
          let text = "";
          for (let i = 0; i < buffer.length; i += 1) {
            text += `${buffer.getLine(i)?.translateToString(true) ?? ""}\n`;
          }
          return text;
        }
      };
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (!isMobile || !terminalReady) {
      return;
    }

    const terminal = termRef.current;
    const container = containerRef.current?.closest(".terminal-scroll");
    if (!terminal || !container) {
      return;
    }

    if ((terminal as any).__touchCleanup) {
      (terminal as any).__touchCleanup();
      (terminal as any).__touchCleanup = null;
    }

    // Selection mode: use xterm.js built-in selection driven by touch events.
    // This supports selecting across the full scrollback buffer with auto-scroll.
    if (selectionMode) {
      const getCellDims = () => {
        const core = (terminal as any)._core;
        const w = core?._renderService?.dimensions?.css?.cell?.width;
        const h = core?._renderService?.dimensions?.css?.cell?.height;
        return { w: w && w > 0 ? w : 9, h: h && h > 0 ? h : 18 };
      };

      const getTermRect = () => {
        const el = containerRef.current?.querySelector('.xterm-screen');
        return el ? el.getBoundingClientRect() : null;
      };

      const touchToCell = (touch: Touch) => {
        const rect = getTermRect();
        if (!rect) return null;
        const cell = getCellDims();
        const col = Math.floor((touch.clientX - rect.left) / cell.w);
        const row = Math.floor((touch.clientY - rect.top) / cell.h);
        return { col: Math.max(0, col), row: Math.max(0, row) };
      };

      let selAnchor: { col: number; row: number } | null = null;
      let selScrollTimer: number | null = null;
      let lastTouchY = 0;
      let isDragging = false;

      const stopSelScroll = () => {
        if (selScrollTimer !== null) {
          clearInterval(selScrollTimer);
          selScrollTimer = null;
        }
      };

      const updateSelection = (anchorRow: number, anchorCol: number, endRow: number, endCol: number) => {
        const buffer = terminal.buffer.active;
        const absAnchorRow = buffer.viewportY + anchorRow;
        const absEndRow = buffer.viewportY + endRow;
        let startRow: number, startCol: number, finalRow: number, finalCol: number;
        if (absAnchorRow < absEndRow || (absAnchorRow === absEndRow && anchorCol <= endCol)) {
          startRow = absAnchorRow; startCol = anchorCol; finalRow = absEndRow; finalCol = endCol;
        } else {
          startRow = absEndRow; startCol = endCol; finalRow = absAnchorRow; finalCol = anchorCol;
        }
        // select() takes column, row (in buffer coords), and length
        // For multi-line, use selectLines then refine — or compute total length
        // Simplest: select line range then we get full lines
        if (startRow === finalRow) {
          const len = Math.max(1, finalCol - startCol + 1);
          terminal.select(startCol, startRow, len);
        } else {
          terminal.selectLines(startRow, finalRow);
        }
      };

      const handleSelTouchStart = (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        if (e.cancelable) e.preventDefault();
        const cell = touchToCell(e.touches[0]);
        if (!cell) return;
        terminal.clearSelection();
        selAnchor = cell;
        lastTouchY = e.touches[0].clientY;
        isDragging = false;
      };

      const handleSelTouchMove = (e: TouchEvent) => {
        if (e.touches.length !== 1 || !selAnchor) return;
        if (e.cancelable) e.preventDefault();
        isDragging = true;

        const touch = e.touches[0];
        lastTouchY = touch.clientY;
        const cell = touchToCell(touch);
        if (!cell) return;
        const endCol = cell.col;

        updateSelection(selAnchor.row, selAnchor.col, cell.row, cell.col);

        // Auto-scroll at edges
        const rect = getTermRect();
        if (!rect) return;
        const edgeZone = getCellDims().h * 2;

        stopSelScroll();
        if (touch.clientY < rect.top + edgeZone) {
          // Near top — scroll up, extending the selection to the top visible row.
          selScrollTimer = window.setInterval(() => {
            terminal.scrollLines(-1);
            if (selAnchor) {
              selAnchor.row += 1; // anchor moves relative to viewport
              updateSelection(selAnchor.row, selAnchor.col, 0, endCol);
            }
          }, 60);
        } else if (touch.clientY > rect.bottom - edgeZone) {
          // Near bottom — scroll down, extending to the bottom visible row.
          selScrollTimer = window.setInterval(() => {
            terminal.scrollLines(1);
            if (selAnchor) {
              selAnchor.row -= 1;
              updateSelection(selAnchor.row, selAnchor.col, terminal.rows - 1, endCol);
            }
          }, 60);
        }
      };

      const handleSelTouchEnd = (e: TouchEvent) => {
        stopSelScroll();
        if (isDragging && terminal.hasSelection()) {
          const text = terminal.getSelection();
          if (text) {
            navigator.clipboard.writeText(text).then(
              () => showToast(`Copied ${text.split("\n").length} line(s)`),
              () => showToast("Copy failed")
            );
          }
        } else {
          terminal.clearSelection();
        }
        selAnchor = null;
        isDragging = false;
      };

      container.addEventListener('touchstart', handleSelTouchStart, { passive: false, capture: true });
      container.addEventListener('touchmove', handleSelTouchMove, { passive: false, capture: true });
      container.addEventListener('touchend', handleSelTouchEnd, { passive: true, capture: true });
      container.addEventListener('touchcancel', handleSelTouchEnd, { passive: true, capture: true });

      (terminal as any).__touchCleanup = () => {
        stopSelScroll();
        container.removeEventListener('touchstart', handleSelTouchStart, { capture: true });
        container.removeEventListener('touchmove', handleSelTouchMove, { capture: true });
        container.removeEventListener('touchend', handleSelTouchEnd, { capture: true });
        container.removeEventListener('touchcancel', handleSelTouchEnd, { capture: true });
      };

      return () => {
        if ((terminal as any).__touchCleanup) {
          (terminal as any).__touchCleanup();
          (terminal as any).__touchCleanup = null;
        }
      };
    }

    // Mobile touch scrolling with momentum (native-feeling)
    // xterm.js has the viewport underneath the rows, so native scroll doesn't work
    // We implement our own with inertia/momentum for iOS-like feel
    let lastY = 0;
    let scrollDebt = 0; // Accumulated sub-line scroll distance
    let velocitySamples: number[] = []; // Recent velocities for smoothing
    // Tap detection (open-URL affordance): a touch that barely moves and ends
    // quickly is a tap, not a scroll.
    let tapStartX = 0;
    let tapStartY = 0;
    let tapStartAt = 0;
    let tapMoved = true;
    let lastMoveTime = 0;
    let momentumVelocity = 0;
    let momentumId: number | null = null;
    let isScrolling = false;
    let isPanning = false;
    let panStartScrollLeft = 0;
    let panStartScrollTop = 0;
    let panStartX = 0;
    let panStartY = 0;

    const getCellHeight = () => {
      const core = (terminal as any)._core;
      const cellHeight = core?._renderService?.dimensions?.css?.cell?.height;
      return cellHeight && cellHeight > 0 ? cellHeight : 18;
    };

    // Alt-screen scroll: the alternate buffer has no scrollback, so touch-dragging
    // can't move a local viewport. Instead send the app its own paging keys.
    // Claude Code (fullscreen) scrolls its transcript on PageUp/PageDown; this also
    // covers pagers like less/man. One page key is emitted per this many lines of
    // finger drag (kept modest so a normal swipe pages a few times, not dozens).
    const PAGE_UP_KEY = "\x1b[5~";
    const PAGE_DOWN_KEY = "\x1b[6~";
    const ALT_SCREEN_DRAG_LINES_PER_PAGE = 3;
    const sendScrollKey = (seq: string) => {
      sendMessage({ type: "input", data: seq });
    };
    // When the app itself requested SGR mouse tracking (Claude Code does),
    // scroll it with per-LINE wheel events instead of coarse Page keys —
    // smooth 1:1 tracking, and safe to drive with momentum.
    const altWheelAvailable = () =>
      remoteMouseReportingRef.current && remoteMouseSgrRef.current;
    const sendWheelLines = (lines: number) => {
      if (lines === 0) return;
      const term = termRef.current;
      const col = Math.max(1, Math.floor((term?.cols || 80) / 2));
      const row = Math.max(1, Math.floor((term?.rows || 24) / 2));
      const code = lines > 0 ? 65 : 64; // 65 = wheel down, 64 = wheel up
      const seq = `\x1b[<${code};${col};${row}M`.repeat(Math.min(Math.abs(lines), 40));
      sendMessage({ type: "input", data: seq });
    };

    const getTwoFingerCenter = (touches: TouchList) => {
      const x = (touches[0].clientX + touches[1].clientX) / 2;
      const y = (touches[0].clientY + touches[1].clientY) / 2;
      return { x, y };
    };

    const friction = 0.94; // Momentum decay (higher = longer coast)
    const minMomentumVelocity = 0.25; // Minimum px/frame to continue momentum

    const stopMomentum = () => {
      if (momentumId !== null) {
        cancelAnimationFrame(momentumId);
        momentumId = null;
      }
      momentumVelocity = 0;
    };

    // Apply accumulated touch-scroll debt at most once per frame. touchmove
    // fires at the digitizer rate (up to 120Hz), and applying scrollLines
    // synchronously per event meant several full render passes per display
    // frame while the main thread also parses streamed output — the source of
    // scroll jank on phones. rAF-coalescing caps it at one render per frame
    // without changing scroll distance (the debt accumulator already carries
    // fractional remainders).
    let scrollApplyId: number | null = null;
    const applyScrollDebt = () => {
      scrollApplyId = null;
      if (remoteAltScreenRef.current) {
        if (altWheelAvailable()) {
          // Wheel-capable app: one wheel event per LINE of finger travel —
          // smooth 1:1 tracking with a fractional carry, like native scroll.
          const lines = Math.trunc(scrollDebt / getCellHeight());
          if (lines !== 0) {
            sendWheelLines(lines);
            scrollDebt -= lines * getCellHeight();
          }
        } else {
          // Fallback (pagers without mouse support): coarse paging keys.
          // pages > 0 → scroll down (PageDown); < 0 → up (PageUp).
          const pagePx = getCellHeight() * ALT_SCREEN_DRAG_LINES_PER_PAGE;
          const pages = Math.trunc(scrollDebt / pagePx);
          if (pages !== 0) {
            const key = pages > 0 ? PAGE_DOWN_KEY : PAGE_UP_KEY;
            for (let i = 0; i < Math.abs(pages); i++) sendScrollKey(key);
            scrollDebt -= pages * pagePx;
          }
        }
      } else {
        // Normal screen: scroll the local xterm viewport (whole lines).
        const lines = Math.trunc(scrollDebt / getCellHeight());
        if (lines !== 0) {
          terminal.scrollLines(lines);
          scrollDebt -= lines * getCellHeight();
        }
      }
    };
    const scheduleScrollApply = () => {
      if (scrollApplyId === null) {
        scrollApplyId = requestAnimationFrame(applyScrollDebt);
      }
    };

    const applyMomentum = () => {
      if (Math.abs(momentumVelocity) < minMomentumVelocity) {
        momentumId = null;
        return;
      }

      // Apply momentum as fractional scroll through the same debt engine the
      // finger uses, so alt-screen wheel apps coast exactly like the local
      // viewport does (applyScrollDebt routes to the right sink).
      scrollDebt += momentumVelocity;
      applyScrollDebt();

      momentumVelocity *= friction;
      momentumId = requestAnimationFrame(applyMomentum);
    };

    const handleTouchStart = (e: TouchEvent) => {
      stopMomentum();
      if (e.cancelable) {
        e.preventDefault();
      }

      if (e.touches.length === 2) {
        isPanning = true;
        const center = getTwoFingerCenter(e.touches);
        panStartX = center.x;
        panStartY = center.y;
        const panTarget = containerRef.current?.closest(".terminal-scroll");
        if (panTarget) {
          panStartScrollLeft = panTarget.scrollLeft;
          panStartScrollTop = panTarget.scrollTop;
        }
        return;
      }

      if (e.touches.length !== 1) {
        isPanning = false;
        isScrolling = false;
        return;
      }

      isPanning = false;
      lastY = e.touches[0].clientY;
      lastMoveTime = Date.now();
      scrollDebt = 0;
      velocitySamples = [];
      isScrolling = true;
      tapStartX = e.touches[0].clientX;
      tapStartY = e.touches[0].clientY;
      tapStartAt = Date.now();
      tapMoved = false;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        if (!isPanning) {
          isPanning = true;
          const center = getTwoFingerCenter(e.touches);
          panStartX = center.x;
          panStartY = center.y;
          const panTarget = containerRef.current?.closest(".terminal-scroll");
          if (panTarget) {
            panStartScrollLeft = panTarget.scrollLeft;
            panStartScrollTop = panTarget.scrollTop;
          }
        }

        const center = getTwoFingerCenter(e.touches);
        const deltaX = panStartX - center.x;
        const deltaY = panStartY - center.y;
        const panTarget = containerRef.current?.closest(".terminal-scroll");
        if (panTarget) {
          panTarget.scrollLeft = panStartScrollLeft + deltaX;
          panTarget.scrollTop = panStartScrollTop + deltaY;
        }
        e.preventDefault();
        return;
      }

      if (e.touches.length !== 1) return;

      if (isPanning) {
        isPanning = false;
        isScrolling = true;
      }

      const touchY = e.touches[0].clientY;
      const now = Date.now();
      const deltaY = lastY - touchY; // positive = scroll down (finger up)
      const deltaTime = Math.max(1, now - lastMoveTime);

      if (!tapMoved && (Math.abs(e.touches[0].clientX - tapStartX) > 10 || Math.abs(touchY - tapStartY) > 10)) {
        tapMoved = true;
      }

      // ALWAYS track velocity (even before direction is locked)
      // This ensures quick flicks have velocity data
      if (deltaTime > 0 && deltaTime < 100) { // Ignore stale samples
        velocitySamples.push(deltaY / deltaTime);
        if (velocitySamples.length > 5) velocitySamples.shift();
      }

      e.preventDefault();
      // Accumulate scroll; deltaY > 0 = finger up = scroll toward newer/bottom.
      scrollDebt += deltaY;
      scheduleScrollApply();

      lastY = touchY;
      lastMoveTime = now;
    };

    const handleTouchEnd = () => {
      if (isPanning) {
        isPanning = false;
        return;
      }

      // Tap (not a scroll): if it landed on a URL, offer to open it.
      if (!tapMoved && Date.now() - tapStartAt < 400) {
        tapMoved = true;
        const term = termRef.current;
        const screenEl = containerRef.current?.querySelector(".xterm-screen");
        if (term && screenEl) {
          const rect = (screenEl as HTMLElement).getBoundingClientRect();
          const col = Math.floor(((tapStartX - rect.left) / rect.width) * term.cols);
          const row = Math.floor(((tapStartY - rect.top) / rect.height) * term.rows);
          if (col >= 0 && col < term.cols && row >= 0 && row < term.rows) {
            const url = extractUrlAtCell(term.buffer.active.viewportY + row, col);
            if (url) setLinkPrompt(url);
          }
        }
      }

      // Only apply momentum if we were scrolling vertically. On the alternate
      // screen it's allowed when the app takes wheel events (per-line, cheap);
      // it stays off for Page-key apps, where a flick would fire a burst of
      // page jumps.
      if (isScrolling && velocitySamples.length > 0 && (!remoteAltScreenRef.current || altWheelAvailable())) {
        // Use peak velocity (max absolute value) - users often slow down at end of flick
        // but we want to capture their flick intent, not their stopping motion
        let peakVelocity = 0;
        for (const v of velocitySamples) {
          if (Math.abs(v) > Math.abs(peakVelocity)) {
            peakVelocity = v;
          }
        }
        // Convert to pixels per frame (~16ms)
        momentumVelocity = peakVelocity * 16;

        // Start momentum if significant (lowered threshold for responsiveness)
        if (Math.abs(momentumVelocity) >= minMomentumVelocity) {
          momentumId = requestAnimationFrame(applyMomentum);
        }
      }
      isScrolling = false;
    };

    // Use capture: true to intercept events before xterm's internal handlers
    container.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true, capture: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true, capture: true });

    // Store cleanup handlers
    (terminal as any).__touchCleanup = () => {
      stopMomentum();
      if (scrollApplyId !== null) {
        cancelAnimationFrame(scrollApplyId);
        scrollApplyId = null;
      }
      container.removeEventListener('touchstart', handleTouchStart, { capture: true });
      container.removeEventListener('touchmove', handleTouchMove, { capture: true });
      container.removeEventListener('touchend', handleTouchEnd, { capture: true });
      container.removeEventListener('touchcancel', handleTouchEnd, { capture: true });
    };

    return () => {
      if ((terminal as any).__touchCleanup) {
        (terminal as any).__touchCleanup();
        (terminal as any).__touchCleanup = null;
      }
    };
  }, [isMobile, selectionMode, terminalReady]);

  useEffect(() => {
    if (!terminalReady || !isMobile) {
      return;
    }
    const terminal = termRef.current;
    if (!terminal) {
      return;
    }
    const viewport = (terminal as any)._core?.viewport;
    if (!viewport) {
      return;
    }

    if (!viewportTouchRef.current) {
      viewportTouchRef.current = {
        start: typeof viewport.handleTouchStart === "function" ? viewport.handleTouchStart.bind(viewport) : undefined,
        move: typeof viewport.handleTouchMove === "function" ? viewport.handleTouchMove.bind(viewport) : undefined
      };
    }

    // Selection mode: disable xterm's internal touch handlers so Safari's
    // selection handles can take priority (CSS toggles pointer-events).
    if (selectionMode) {
      viewport.handleTouchStart = () => {};
      viewport.handleTouchMove = () => true;
    } else if (viewportTouchRef.current) {
      if (viewportTouchRef.current.start) {
        viewport.handleTouchStart = viewportTouchRef.current.start;
      }
      if (viewportTouchRef.current.move) {
        viewport.handleTouchMove = viewportTouchRef.current.move;
      }
    }

    return () => {
      if (viewportTouchRef.current) {
        if (viewportTouchRef.current.start) {
          viewport.handleTouchStart = viewportTouchRef.current.start;
        }
        if (viewportTouchRef.current.move) {
          viewport.handleTouchMove = viewportTouchRef.current.move;
        }
      }
    };
  }, [terminalReady, isMobile, selectionMode]);

  // No separate native selection effect needed — xterm selection handles everything
  // in select mode via the touch handlers registered above.

  useEffect(() => {
    if (!session) {
      // Stop auto-reconnect when leaving session
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
      optimisticEchoRef.current.reset();
      reconnectAttemptRef.current = 0;
    }
  }, [session]);

  useEffect(() => {
    return () => {
      const terminal = termRef.current;
      const resizeObserver = (terminal as any)?.__resizeObserver as ResizeObserver | undefined;
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (terminal) {
        // Clear any custom touch cleanup hooks from the momentum handler.
        if ((terminal as any).__touchCleanup) {
          (terminal as any).__touchCleanup();
          (terminal as any).__touchCleanup = null;
        }
        terminal.dispose();
        termRef.current = null;
        fitRef.current = null;
      }

      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoom = getLocationRoom();
      const nextName =
        new URLSearchParams(window.location.search).get("name") ??
        localStorage.getItem("hay_name") ??
        name;
      if (!nextRoom) {
        if (!isEmbeddedInHop()) {
          setSession(null);
        }
        return;
      }
      setRoom(nextRoom);
      setSession((current) => {
        const resolvedName = current?.name ?? nextName ?? "User";
        if (current?.room === nextRoom && current.name === resolvedName) {
          return current;
        }
        return { name: resolvedName, room: nextRoom };
      });
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [name]);

  // Periodic re-render so presence activity labels ("active"/"idle") don't go stale
  const [, setPresenceTick] = useState(0);
  useEffect(() => {
    if (presence.length === 0) {
      return;
    }
    const id = window.setInterval(() => setPresenceTick((tick) => tick + 1), 20000);
    return () => window.clearInterval(id);
  }, [presence.length]);

  // Keep the FAB on-screen after rotation / window resize
  useEffect(() => {
    const clampFab = () => {
      setFabPosition((pos) => ({
        x: Math.max(0, Math.min(window.innerWidth - 56, pos.x)),
        y: Math.max(0, Math.min(window.innerHeight - 56, pos.y))
      }));
    };
    window.addEventListener("resize", clampFab);
    window.addEventListener("orientationchange", clampFab);
    return () => {
      window.removeEventListener("resize", clampFab);
      window.removeEventListener("orientationchange", clampFab);
    };
  }, []);

  const fetchSessions = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const { showLoading = true } = options;
    if (showLoading) {
      setLoadingSessions(true);
    }
    // Sequence guard: the periodic 5s poll and an action-triggered refresh
    // (rename/kill/create) can be in flight together. Without this, a slow
    // stale poll landing AFTER the rename refetch overwrote the new name with
    // the old one — the rename "didn't display" until the next poll ~5s later.
    const seq = ++fetchSeqRef.current;
    try {
      const res = await fetch("/api/sessions");
      const data = await res.json();
      const sessionMap = new Map<string, SessionInfo>();

      // Process sessions from the API
      for (const s of data.sessions || []) {
        sessionMap.set(s.name, {
          name: s.name,
          displayName: s.displayName || s.name,
          active: (data.active || []).includes(s.name),
          starting: (data.starting || []).includes(s.name),
          type: s.type,
          port: s.port,
          cwd: s.cwd,
          internalName: s.internalName || s.name,
          lastActivityAt: Number(s.lastActivityAt) || 0,
          bellSeq: Number(s.bellSeq) || 0,
          foregroundProcess: s.foregroundProcess,
          agentPermitted: s.agentPermitted === true,
          createdBy: s.createdBy === "agent" ? "agent" : "user",
          cols: Number.isInteger(s.cols) ? s.cols : undefined,
          rows: Number.isInteger(s.rows) ? s.rows : undefined
        });
      }

      // Add active sessions that might not be in sessions list
      for (const name of data.active || []) {
        if (!sessionMap.has(name)) {
          sessionMap.set(name, {
            name,
            displayName: name,
            active: true,
            starting: false,
            internalName: name,
            createdBy: "user"
          });
        }
      }

      // Reconcile seen-markers: a session first observed gets a silent baseline
      // (no retroactive "unread" noise); the attached session, while the tab is
      // visible, is continuously marked seen. Everything else diffs the server's
      // lastActivityAt/bellSeq against the marker to derive the indicators.
      const markers = loadSeenMarkers();
      const currentRoom = activeSessionRoomRef.current;
      const tabVisible = document.visibilityState === "visible";
      let markersDirty = false;
      const list = Array.from(sessionMap.values()).map((info) => {
        const key = info.internalName || info.name;
        const out = info.lastActivityAt || 0;
        const bell = info.bellSeq || 0;
        const isCurrent = currentRoom !== null && (info.internalName === currentRoom || info.name === currentRoom);
        let marker = markers[key];
        if (!marker) {
          marker = { out, bell };
          markers[key] = marker;
          markersDirty = true;
        } else if (isCurrent && tabVisible && (marker.out !== out || marker.bell !== bell)) {
          marker = { out, bell };
          markers[key] = marker;
          markersDirty = true;
        }
        return {
          ...info,
          unread: !isCurrent && out > marker.out,
          bellUnseen: !isCurrent && bell > marker.bell
        };
      });
      if (list.length > 0) {
        const liveKeys = new Set(list.map((info) => info.internalName || info.name));
        for (const key of Object.keys(markers)) {
          if (!liveKeys.has(key)) {
            delete markers[key];
            markersDirty = true;
          }
        }
      }
      if (markersDirty) {
        saveSeenMarkers(markers);
      }

      // Drop a response superseded by a newer fetch started while this was
      // in flight (see the sequence-guard note above).
      if (seq !== fetchSeqRef.current) return;
      setSessions(list);
      setSessionsError(false);
      sessionListLoadedRef.current = true;
      sessionListFetchedAtRef.current = Date.now();
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
      setSessionsError(true);
    } finally {
      if (showLoading) {
        setLoadingSessions(false);
      }
    }
  }, []);
  fetchSessionsRef.current = fetchSessions;

  // Fetch sessions when drawer opens
  useEffect(() => {
    if (drawerOpen) {
      const isFreshEnough = Date.now() - sessionListFetchedAtRef.current <= SESSION_LIST_STALE_MS;
      const shouldRefresh = !sessionListLoadedRef.current || !isFreshEnough;
      if (shouldRefresh) {
        fetchSessions({
          showLoading: !sessionListLoadedRef.current
        });
      }
    }
  }, [drawerOpen, fetchSessions]);

  // Fetch sessions once on mount; mobile keeps list warm for instant drawer open.
  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Keep the list fresh while attached so attention indicators (unread output,
  // bells in other sessions) update without opening the drawer. Background tabs
  // get throttled by the browser, which is fine — the check runs on refocus too.
  useEffect(() => {
    if (!session) {
      return;
    }
    const id = window.setInterval(() => fetchSessions({ showLoading: false }), 5000);
    return () => window.clearInterval(id);
  }, [session, fetchSessions]);

  // Returning to the tab clears the title alert and re-baselines the attached
  // session's seen marker (via the fetch's isCurrent+visible path).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setTitleAlert(false);
        fetchSessions({ showLoading: false });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [fetchSessions]);

  // Does any *other* session want attention? Bells outrank plain output.
  const otherAttention = useMemo(() => {
    const current = session?.room ?? null;
    let bell = false;
    let output = false;
    for (const s of sessions) {
      if (current && (s.internalName === current || s.name === current)) continue;
      if (s.bellUnseen) bell = true;
      else if (s.unread) output = true;
    }
    return { bell, output };
  }, [sessions, session?.room]);

  // Tab title: session name, with a dot when the attached session rang a bell
  // while hidden or another session has an unseen bell.
  useEffect(() => {
    const base = sessionLabel || session?.room || "hop";
    const alert = titleAlert || otherAttention.bell;
    document.title = `${alert ? "● " : ""}${base}`;
  }, [titleAlert, otherAttention.bell, sessionLabel, session?.room]);

  // Notify for bells in other sessions: the 5s poll flips bellUnseen false→true
  // when a session rings while unwatched. The seq map dedupes so a session that
  // stays unseen across polls (or re-rings the same seq) fires at most once per
  // bellSeq; clicking jumps straight to the session that rang.
  useEffect(() => {
    const prevUnseen = prevBellUnseenRef.current;
    const nextUnseen: Record<string, boolean> = {};
    for (const s of sessions) {
      const key = s.internalName || s.name;
      nextUnseen[key] = s.bellUnseen === true;
      if (!notifyBells || !s.bellUnseen || prevUnseen[key]) {
        continue;
      }
      const seq = s.bellSeq || 0;
      if ((notifiedBellSeqRef.current[key] ?? 0) >= seq) {
        continue;
      }
      notifiedBellSeqRef.current[key] = seq;
      fireBellNotification(s.displayName, () => switchSession(s));
    }
    prevBellUnseenRef.current = nextUnseen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, notifyBells]);

  // Update terminal font size when it changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      if (viewModeRef.current === "fit") {
        fitToViewport();
        handleResize();
      } else {
        termRef.current.refresh(0, termRef.current.rows - 1);
      }
    }
    localStorage.setItem("hay_font_size", String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    if (!isMobile || !terminalReady || !keyboardVisible || keyboardHeight <= 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (viewModeRef.current === "fit") {
        fitToViewport();
        handleResize();
      }
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isMobile, terminalReady, keyboardVisible, keyboardHeight]);

  const switchSession = (nextSession: SessionInfo) => {
    const nextPath = buildSessionPath(nextSession.name);
    const currentRoom = session?.room ?? sessionLabel;
    const canSwitchInPlace = sessionSwitchMode === "instant" && nextSession.type !== "port";
    // A switch is a deliberate human act — its attach claim wins the size
    // election outright (see the resize handler). Reconnects don't set this.
    deliberateAttachRef.current = true;

    // Switching to it counts as seeing it — clear its attention indicators.
    const markers = loadSeenMarkers();
    markers[nextSession.internalName || nextSession.name] = {
      out: nextSession.lastActivityAt || 0,
      bell: nextSession.bellSeq || 0
    };
    saveSeenMarkers(markers);

    if (!canSwitchInPlace) {
      window.location.href = nextPath;
      return;
    }

    if (currentRoom === nextSession.name) {
      setDrawerOpen(false);
      return;
    }

    optimisticEchoRef.current.reset();
    pendingInputRef.current = [];
    setPresence([]);
    setControllerId(null);
    setClientId(null);
    setLiveCwd(null);
    setStatus("connecting");
    setRoom(nextSession.name);
    setSessionLabel(nextSession.displayName || nextSession.name);
    setSession((current) => ({
      name: current?.name ?? name.trim() ?? "User",
      room: nextSession.name
    }));
    window.history.pushState({}, "", nextPath);
    setDrawerOpen(false);
  };
  // Keep the keyboard layer's ref current (it's defined earlier in the file).
  switchSessionRef.current = switchSession;

  // Keyboard-first focus: whenever every overlay is closed (palette, drawer,
  // help, find) and a session is up, the terminal gets focus back — switching
  // sessions or dismissing a panel should never require a click before
  // typing. Desktop only: focusing on mobile pops the system keyboard.
  useEffect(() => {
    if (isMobile || !session) return;
    if (switcherOpen || drawerOpen || shortcutHelpOpen || searchActive || renamingSession || creatingSession) return;
    if (focusedPaneId !== "primary") return; // a secondary pane owns the keyboard
    // Post-render: let the closing overlay unmount before taking focus.
    const t = window.setTimeout(() => termRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [switcherOpen, drawerOpen, shortcutHelpOpen, searchActive, renamingSession, creatingSession, session, focusedPaneId]);

  const handleJoin = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !room.trim()) {
      pushNotice("Enter a name and room to start.");
      return;
    }
    localStorage.setItem("hay_name", name.trim());
    setSession({ name: name.trim(), room: room.trim() });
  };

  const submitName = (event: FormEvent) => {
    event.preventDefault();
    const next = nameDraft.trim();
    setEditingName(false);
    if (!next || next === name) {
      return;
    }
    localStorage.setItem("hay_name", next);
    setName(next);
    // A new session object triggers the connect effect — the socket reconnects
    // carrying the new name, so presence updates for everyone.
    setSession((current) => (current ? { ...current, name: next } : current));
    pushNotice(`Display name set to ${next}`);
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    const next = renameDraft.trim();
    const current = sessionLabel || session?.room || "";
    if (!next || next === current) {
      setRenamingSession(false);
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(next)) {
      pushNotice("Only letters, numbers, - and _ allowed");
      return;
    }
    try {
      const res = await fetch("/api/sessions/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldName: current, newName: next })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { error?: string }));
        pushNotice(data.error || "Rename failed");
        return;
      }
      // The server broadcasts session_renamed, which updates the label.
      setRenamingSession(false);
      fetchSessions({ showLoading: false });
    } catch {
      pushNotice("Rename failed");
    }
  };

  const handleKillSession = () => {
    const label = sessionLabel || session?.room || "this session";
    if (!window.confirm(`Kill session "${label}" for all participants? Its running process is terminated.`)) {
      return;
    }
    sendMessage({ type: "kill_session" });
    setDrawerOpen(false);
  };

  const submitNewSession = async (event: FormEvent) => {
    event.preventDefault();
    const next = newSessionName.trim();
    if (!next) {
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(next)) {
      pushNotice("Only letters, numbers, - and _ allowed");
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
        pushNotice(data.error || "Failed to create session");
        return;
      }
      setCreatingSession(false);
      setNewSessionName("");
      switchSession({ name: data.name, displayName: data.name, active: false, starting: true, internalName: data.name });
      fetchSessions({ showLoading: false });
    } catch {
      pushNotice("Failed to create session");
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      pushNotice("Share link copied.");
    } catch {
      pushNotice("Copy failed. Select the link manually.");
    }
  };

  const handleToggleCollab = () => {
    sendMessage({ type: "toggle_collab", enabled: !collabMode });
  };

  const handleTakeControl = () => {
    sendMessage({ type: "take_control" });
  };

  const handleReleaseControl = () => {
    sendMessage({ type: "release_control" });
  };

  const handleNotifyToggle = (enabled: boolean) => {
    if (!enabled) {
      setNotifyBells(false);
      return;
    }
    // Optimistically flip On while the permission prompt is up; revert if the
    // user (or a prior browser-level block) denies it.
    setNotifyBells(true);
    if (Notification.permission === "granted") {
      return;
    }
    Notification.requestPermission().then((permission) => {
      if (permission !== "granted") {
        pushNotice("Notifications are blocked by the browser");
        setNotifyBells(false);
      }
    });
  };

  const handleFabDragStart = (clientX: number, clientY: number) => {
    fabDragRef.current = {
      dragging: false,
      startX: clientX,
      startY: clientY,
      startPosX: fabPosition.x,
      startPosY: fabPosition.y
    };
  };

  const handleFabDragMove = (clientX: number, clientY: number) => {
    if (!fabDragRef.current) return;
    const dx = clientX - fabDragRef.current.startX;
    const dy = clientY - fabDragRef.current.startY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      fabDragRef.current.dragging = true;
    }
    if (fabDragRef.current.dragging) {
      setFabPosition({
        x: Math.max(0, Math.min(window.innerWidth - 56, fabDragRef.current.startPosX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 56, fabDragRef.current.startPosY + dy))
      });
    }
  };

  const handleFabDragEnd = () => {
    if (fabDragRef.current && !fabDragRef.current.dragging) {
      // Mobile hub inversion: sessions are the front page, settings live
      // behind the switcher's gear. Standalone (non-hop) keeps the drawer,
      // since there's no session API to populate the switcher.
      if (isMobile && isEmbeddedInHop()) {
        setSwitcherOpen(true);
      } else {
        setDrawerOpen(true);
      }
    }
    fabDragRef.current = null;
  };

  const handleKeyboardToggle = useCallback(() => {
    setKeyboardVisible((prev) => !prev);
    // Refit terminal after keyboard toggle
    setTimeout(() => {
      if (viewModeRef.current === "fit") {
        fitToViewport();
        handleResize();
      }
    }, 100);
  }, []);

  const handleKeyboardInput = useCallback(
    (data: string) => {
      handleUserInput(data);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Mobile link opening: a tap on a URL offers Open/Copy. (The custom touch
  // layer disables native pointer events on terminal text, and remote apps
  // can't open the phone's browser — claude login prints a URL that was
  // otherwise un-tappable.)
  const [linkPrompt, setLinkPrompt] = useState<string | null>(null);
  // Passkey nudge: biometric sign-in works but is invisible — the login page
  // only offers Touch ID / Face ID once a credential exists for this
  // hostname, so a user who never opened the settings drawer never learns it
  // exists. Ask once per device, only when this domain has no passkey yet
  // and the browser supports WebAuthn.
  const [passkeyNudge, setPasskeyNudge] = useState(false);
  useEffect(() => {
    if (!isEmbeddedInHop()) return;
    if (typeof window === "undefined" || !window.PublicKeyCredential) return;
    if (localStorage.getItem("hay_passkey_nudge_done") === "1") return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/passkeys/login-options", { method: "POST" });
        const data = await res.json();
        // ok:true means credentials already exist for this hostname.
        if (!cancelled && data && data.ok === false) setPasskeyNudge(true);
      } catch { /* offline or old daemon — never nag */ }
    }, 4000);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, []);
  const dismissPasskeyNudge = () => {
    localStorage.setItem("hay_passkey_nudge_done", "1");
    setPasskeyNudge(false);
  };

  // Reconstruct the URL under a tapped cell. Wrapped rows are joined into the
  // logical line first — OAuth URLs span many screen rows.
  const extractUrlAtCell = useCallback((bufferRow: number, col: number): string | null => {
    const term = termRef.current;
    if (!term) return null;
    const buf = term.buffer.active;
    let start = bufferRow;
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    let text = "";
    let offset = -1;
    for (let r = start; r < buf.length; r++) {
      const line = buf.getLine(r);
      if (!line || (r > start && !line.isWrapped)) break;
      if (r === bufferRow) offset = text.length + Math.min(col, term.cols - 1);
      text += line.translateToString(false);
    }
    if (offset < 0) return null;
    const urlRe = /https?:\/\/[^\s"'`<>]+/g;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(text)) !== null) {
      if (offset >= m.index && offset <= m.index + m[0].length) {
        return m[0].replace(/[.,;:!?)\]}]+$/, "");
      }
    }
    return null;
  }, []);

  // Enroll this device's platform authenticator (Touch ID / Face ID) as a
  // passkey. Requires the authenticated cookie this page already has; the
  // credential is bound to the current hostname (rpID).
  const enrollPasskey = useCallback(async () => {
    const b64uToBuf = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const bufToB64u = (b: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    try {
      const optRes = await fetch("/api/passkeys/register-options", { method: "POST" });
      const opt = await optRes.json();
      if (!opt.ok) throw new Error(opt.error || "Could not start enrollment");
      const pub = opt.options;
      pub.challenge = b64uToBuf(pub.challenge);
      pub.user.id = b64uToBuf(pub.user.id);
      pub.excludeCredentials = (pub.excludeCredentials || []).map((c: { id: string }) => ({ ...c, id: b64uToBuf(c.id) }));
      const cred = (await navigator.credentials.create({ publicKey: pub })) as PublicKeyCredential;
      const resp = cred.response as AuthenticatorAttestationResponse;
      const vr = await fetch("/api/passkeys/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: opt.token,
          response: {
            id: cred.id,
            rawId: bufToB64u(cred.rawId),
            type: cred.type,
            authenticatorAttachment: (cred as PublicKeyCredential & { authenticatorAttachment?: string }).authenticatorAttachment || undefined,
            clientExtensionResults: cred.getClientExtensionResults(),
            response: {
              clientDataJSON: bufToB64u(resp.clientDataJSON),
              attestationObject: bufToB64u(resp.attestationObject),
              transports: (resp as AuthenticatorAttestationResponse & { getTransports?: () => string[] }).getTransports?.() || []
            }
          }
        })
      });
      const out = await vr.json();
      showToast(out.ok ? "Passkey added — biometric sign-in enabled on this domain" : `Passkey failed: ${out.error || "verification failed"}`, 4000);
    } catch (e) {
      if ((e as Error).name === "NotAllowedError") return; // user dismissed the OS prompt
      showToast(`Passkey: ${(e as Error).message}`, 4000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hub mode (landing page with nothing live): keep the session grid fresh
  // while the switcher is the whole page.
  useEffect(() => {
    if (session || !isEmbeddedInHop()) return;
    fetchSessions({ showLoading: false });
    // Poll only while visible — a backgrounded hub tab must not keep hitting
    // the daemon (and through it the host) forever.
    const id = window.setInterval(() => {
      if (!document.hidden) fetchSessions({ showLoading: false });
    }, 5000);
    const onVisible = () => { if (!document.hidden) fetchSessions({ showLoading: false }); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Desktop keyboard layer — capture phase so shortcuts win over the focused
  // terminal. ⌘-based (Ctrl+Shift elsewhere) to stay clear of readline/TUI
  // keys, which the terminal must keep receiving untouched.
  //   ⌘K session palette · ⌘J/⌘⇧J cycle sessions · ⌘, settings ·
  //   ⌘+/−/0 font size · ⌘/ shortcut help · Esc closes drawer/help
  useEffect(() => {
    if (!session || !isEmbeddedInHop()) return;
    const cycleSession = (dir: 1 | -1) => {
      const list = [...sessionsRef.current]
        .filter((s) => s.type !== "port")
        .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
      if (list.length < 2) return;
      const cur = list.findIndex((s) => s.name === activeSessionRoomRef.current || s.internalName === activeSessionRoomRef.current);
      const next = list[(cur + dir + list.length) % list.length];
      if (next) switchSessionRef.current?.(next);
    };
    const onKey = (event: KeyboardEvent) => {
      const mod = isMacPlatform
        ? event.metaKey && !event.ctrlKey && !event.altKey
        : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
      if (!mod) {
        if (event.key === "Escape" && (drawerOpenRef.current || shortcutHelpRef.current)) {
          event.preventDefault();
          event.stopPropagation();
          setDrawerOpen(false);
          setShortcutHelpOpen(false);
        }
        return;
      }
      const key = event.key.toLowerCase();
      const shifted = event.shiftKey;
      const grab = () => { event.preventDefault(); event.stopPropagation(); };
      if (key === "k" && (isMacPlatform ? !shifted : true)) { grab(); setSwitcherOpen((v) => !v); return; }
      if (key === "j") { grab(); cycleSession(shifted ? -1 : 1); return; }
      if (key === ",") { grab(); setDrawerOpen((v) => !v); return; }
      if (key === "/" || (shifted && key === "?")) { grab(); setShortcutHelpOpen((v) => !v); return; }
      if (shifted && key === "e") {
        const leaves = paneLeafIds(paneTreeRef.current).filter((id) => id !== "primary");
        const target = focusedPaneIdRef.current !== "primary"
          ? focusedPaneIdRef.current
          : (leaves.length === 1 ? leaves[0] : null);
        if (target) { grab(); paneOpsRef.current.swapPaneWithPrimary(target); }
        return;
      }
      if (key === "]" || key === "[") {
        const ids = paneLeafIds(paneTreeRef.current);
        if (ids.length > 1) {
          grab();
          const cur = Math.max(0, ids.indexOf(focusedPaneIdRef.current));
          setFocusedPaneId(ids[(cur + (key === "]" ? 1 : -1) + ids.length) % ids.length]);
        }
        return;
      }
      // Split-first-then-fill: ⌘\ side-by-side, ⌘⇧\ stacked; each opens an
      // empty pane and the palette to fill it. ⌘⇧K closes the focused pane.
      if (key === "\\" || key === "|") {
        grab();
        paneOpsRef.current.splitAndPick(shifted || key === "|" ? "col" : "row");
        return;
      }
      if (shifted && key === "k" && focusedPaneIdRef.current !== "primary") {
        grab();
        paneOpsRef.current.closePane(focusedPaneIdRef.current);
        return;
      }
      if (isMacPlatform && !shifted) {
        if (key === "=" || key === "+") { grab(); setFontSize((s) => Math.min(24, s + 1)); return; }
        if (key === "-") { grab(); setFontSize((s) => Math.max(8, s - 1)); return; }
        if (key === "0") { grab(); setFontSize(14); return; }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const sessionStyle = isMobile
    ? ({ "--mobile-keyboard-height": `${keyboardVisible ? keyboardHeight : 0}px` } as CSSProperties)
    : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div>
            {/* Wordmark only — no mascot tile. The cursor block is the one
                signature detail: terminal-native, quiet, unmistakable. */}
            <p className="brand-title">
              {isEmbeddedInHop() ? "hop" : "hay"}
              <span className="brand-cursor" aria-hidden="true" />
            </p>
            <p className="brand-subtitle">
              {isEmbeddedInHop() ? "terminals for humans and agents." : "Collaborative terminal sharing for Hop."}
            </p>
          </div>
        </div>
        <div className="presence-strip">
          {sortedPresence.map((client) => (
            <div
              key={client.id}
              className={`presence-chip ${client.id === clientId ? "self" : ""}`}
              title={`${client.name} · ${formatStatus(client)}`}
            >
              <span className="presence-dot" style={{ backgroundColor: client.color }} />
              <span className="presence-name">{client.name}</span>
              {!collabMode && controllerId === client.id && (
                <span className="presence-control" title="Has control">control</span>
              )}
              <span className={`presence-status ${formatStatus(client)}`}>{formatStatus(client)}</span>
            </div>
          ))}
          {sortedPresence.length === 0 && <span className="presence-empty">No viewers yet</span>}
        </div>
        {!isMobile && session && isEmbeddedInHop() && (
          <div className="topbar-actions">
            <button
              type="button"
              className="topbar-sessions-btn"
              title={`Sessions (${isMacPlatform ? "⌘K" : "Ctrl+Shift+K"})`}
              onClick={() => setSwitcherOpen(true)}
            >
              Sessions
              <kbd>{isMacPlatform ? "⌘K" : "⌃⇧K"}</kbd>
            </button>
            <button
              type="button"
              className="topbar-sessions-btn"
              aria-label="Session settings"
              title="Session settings"
              onClick={() => setDrawerOpen(true)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>
        )}
      </header>

      {!session && isEmbeddedInHop() ? (
        // Hub mode: hop's landing page with nothing to auto-join. The switcher
        // IS the page (the old server-rendered /sessions picker is gone) —
        // picking a session navigates into it, and it can't be dismissed into
        // nothing. Normally the daemon redirects the landing to the freshest
        // live session with ?home=1, so this renders only when nothing is live.
        <main className="hub">
          <SessionSwitcher
            open
            sessions={sessions}
            currentRoom={null}
            dismissable={false}
            onClose={() => {}}
            onSwitch={(next) => {
              window.location.href = buildSessionPath(next.displayName || next.name);
            }}
            onRefresh={() => fetchSessions({ showLoading: false })}
            onNotice={showToast}
            tileWsBase={resolveWsUrl()}
            userName={name}
            terminalTheme={resolveTerminalTheme(themeMode)}
          />
          {toast && <div className="terminal-toast" role="status" aria-live="polite">{toast}</div>}
        </main>
      ) : !session ? (
        <main className="join">
          <div className="join-card">
            <h1>Terminal session</h1>
            <p>Connect to an existing session or start a new one.</p>
            <form onSubmit={handleJoin} className="join-form">
              <label>
                Display name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Casey"
                />
              </label>
              <label>
                Session
                <input
                  value={room}
                  onChange={(event) => setRoom(event.target.value)}
                  placeholder="my-session"
                />
              </label>
              <button type="submit" className="primary">
                Connect
              </button>
            </form>
          </div>
        </main>
      ) : (
        <main
          className={`session${isMobile && keyboardVisible ? " has-keyboard" : ""}${selectionMode ? " selection-mode" : ""}`}
          style={sessionStyle}
        >
          {/* Connection state banner — on mobile the footer is hidden, and on
              desktop the footer dot alone is too easy to miss during an outage. */}
          {status !== "connected" && status !== "idle" && (
            <div
              className={`connection-banner${status === "ended" ? " ended" : ""}`}
              role="status"
              aria-live="polite"
            >
              <span>
                {status === "connecting"
                  ? "Connecting…"
                  : status === "ended"
                    ? "Session ended"
                    : "Disconnected — reconnecting…"}
              </span>
              {(status === "disconnected" || status === "ended") && (
                <button type="button" onClick={() => setReconnectToken((value) => value + 1)}>
                  Reconnect now
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            aria-label="Open menu"
            className="drawer-toggle"
            style={{ left: fabPosition.x, top: fabPosition.y, bottom: 'auto' }}
            onMouseDown={(e) => handleFabDragStart(e.clientX, e.clientY)}
            onMouseMove={(e) => handleFabDragMove(e.clientX, e.clientY)}
            onMouseUp={handleFabDragEnd}
            onMouseLeave={handleFabDragEnd}
            onTouchStart={(e) => handleFabDragStart(e.touches[0].clientX, e.touches[0].clientY)}
            onTouchMove={(e) => handleFabDragMove(e.touches[0].clientX, e.touches[0].clientY)}
            onTouchEnd={handleFabDragEnd}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="currentColor"/>
              <line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="currentColor"/>
              <line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2" fill="currentColor"/>
            </svg>
            {(otherAttention.bell || otherAttention.output) && (
              <span className={`fab-attention${otherAttention.bell ? " bell" : ""}`} aria-hidden="true" />
            )}
          </button>
          {drawerOpen && (
            <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} />
          )}
          <section className={`controls ${drawerOpen ? "open" : ""}`}>
            <button
              type="button"
              aria-label="Close menu"
              className="drawer-close"
              onClick={() => setDrawerOpen(false)}
            >
              ✕
            </button>
            {/* Session info */}
            <div className="room-info">
              <p className="room-label">Session</p>
              {renamingSession ? (
                <form className="inline-edit" onSubmit={submitRename}>
                  <input
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    maxLength={64}
                    autoFocus
                    aria-label="New session name"
                  />
                  <button type="submit">Save</button>
                  <button type="button" onClick={() => setRenamingSession(false)}>✕</button>
                </form>
              ) : (
                <div className="room-title-row">
                  <h2>{sessionLabel || session.room}</h2>
                  {isEmbeddedInHop() && (
                    <button
                      type="button"
                      className="icon-btn-inline"
                      title="Rename session"
                      aria-label="Rename session"
                      onClick={() => {
                        setRenameDraft(sessionLabel || session.room);
                        setRenamingSession(true);
                      }}
                    >
                      ✎
                    </button>
                  )}
                </div>
              )}
              {liveCwd && (
                <p className="room-cwd" title={liveCwd}>{shortenPath(liveCwd)}</p>
              )}
              <p className="room-meta">
                {status === "connected"
                  ? "Live"
                  : status === "connecting"
                    ? "Connecting"
                    : status === "ended"
                      ? "Ended"
                      : "Offline"}
              </p>
            </div>

            {/* Quick actions — utility icons grouped left, named actions right */}
            <div className="quick-actions">
              <div className="quick-group">
                {isMobile && (
                  <button type="button" className="quick-btn icon-btn" onClick={() => { handleKeyboardToggle(); setDrawerOpen(false); }} title={keyboardVisible ? "Hide keyboard" : "Show keyboard"} aria-label={keyboardVisible ? "Hide keyboard" : "Show keyboard"}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="14" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8"/>
                    </svg>
                  </button>
                )}
                <button type="button" className="quick-btn icon-btn" onClick={handleCopyLink} title="Copy share link" aria-label="Copy share link">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                  </svg>
                </button>
                {isMobile && (
                  <button type="button" className="quick-btn icon-btn" title="Find in scrollback" aria-label="Find in terminal" onClick={() => { setDrawerOpen(false); openSearch(); }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
                    </svg>
                  </button>
                )}
              </div>
              <div className="quick-group">
                <button type="button" className="quick-btn" onClick={() => { fitToViewport(); handleResize(); }}>
                  Fit
                </button>
                {/* Mobile gets the in-app switcher; desktop keeps the manager page */}
                {isMobile && isEmbeddedInHop() ? (
                  <button type="button" className="quick-btn" onClick={() => { setDrawerOpen(false); setSwitcherOpen(true); }}>
                    Sessions
                  </button>
                ) : (
                  <button type="button" className="quick-btn" onClick={() => { window.open('/sessions.html', '_blank'); }}>
                    Manage
                  </button>
                )}
                <button type="button" className="quick-btn danger" onClick={handleKillSession}>
                  Kill
                </button>
                {(status === "disconnected" || status === "ended") && (
                  <button type="button" className="quick-btn primary" onClick={() => setReconnectToken((value) => value + 1)}>
                    Reconnect
                  </button>
                )}
              </div>
            </div>

            {/* Input control: who is allowed to type */}
            <div className="drawer-group">
              <div className="drawer-row">
                <label>Name</label>
                {editingName ? (
                  <form className="inline-edit" onSubmit={submitName}>
                    <input
                      value={nameDraft}
                      onChange={(event) => setNameDraft(event.target.value)}
                      maxLength={24}
                      autoFocus
                      aria-label="Display name"
                    />
                    <button type="submit">Save</button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="name-edit-toggle"
                    title="Change your display name"
                    onClick={() => {
                      setNameDraft(name);
                      setEditingName(true);
                    }}
                  >
                    {name} <span aria-hidden="true">✎</span>
                  </button>
                )}
              </div>
              <div className="drawer-row">
                <label>Control</label>
                <span className="control-state">
                  {collabMode
                    ? "Everyone can type"
                    : controllerId === clientId
                      ? "You have control"
                      : controllerName
                        ? `Locked by ${controllerName}`
                        : "Locked"}
                </span>
              </div>
              <div className="drawer-row">
                <label>Typing</label>
                <div className="view-mode-buttons">
                  <button
                    type="button"
                    className={collabMode ? "active" : ""}
                    onClick={() => { if (!collabMode) handleToggleCollab(); }}
                  >
                    Everyone
                  </button>
                  <button
                    type="button"
                    className={!collabMode ? "active" : ""}
                    onClick={() => { if (collabMode) handleToggleCollab(); }}
                  >
                    One user
                  </button>
                </div>
              </div>
              {!collabMode && (
                <div className="drawer-row">
                  {controllerId === clientId ? (
                    <button type="button" className="quick-btn" onClick={handleReleaseControl}>
                      Release control
                    </button>
                  ) : (
                    <button type="button" className="quick-btn" onClick={handleTakeControl}>
                      Take control
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Display settings */}
            <div className="drawer-group">
              <div className="drawer-row">
                <label>Theme</label>
                <div className="view-mode-buttons">
                  <button type="button" className={themeMode === "system" ? "active" : ""} onClick={() => setThemeMode("system")}>Auto</button>
                  <button type="button" className={themeMode === "light" ? "active" : ""} onClick={() => setThemeMode("light")}>Light</button>
                  <button type="button" className={themeMode === "dark" ? "active" : ""} onClick={() => setThemeMode("dark")}>Dark</button>
                </div>
              </div>
              <div className="drawer-row">
                <label>Font</label>
                <div className="font-size-buttons">
                  <button type="button" onClick={() => setFontSize((s) => Math.max(8, s - 1))}>−</button>
                  <span>{fontSize}px</span>
                  <button type="button" onClick={() => setFontSize((s) => Math.min(24, s + 1))}>+</button>
                </div>
              </div>
              {isMobile && (
                <div className="drawer-row">
                  <label>Touch</label>
                  <div className="view-mode-buttons">
                    <button type="button" className={!selectionMode ? "active" : ""} onClick={() => setSelectionMode(false)}>Scroll</button>
                    <button type="button" className={selectionMode ? "active" : ""} onClick={() => setSelectionMode(true)}>Select</button>
                  </div>
                </div>
              )}
              {/* Copy output — segmented, consistent with the rows above */}
              <div className="drawer-row">
                <label>Copy</label>
                <div className="view-mode-buttons">
                  <button type="button" onClick={() => copyToClipboard(getVisibleText(), "Visible text")}>Screen</button>
                  <button type="button" onClick={() => copyToClipboard(getBufferText(), "Full buffer")}>All</button>
                </div>
              </div>
            </div>

            {/* Advanced settings — collapsed */}
            <details className="drawer-details">
              <summary>More settings</summary>
              <div className="drawer-group">
                {isEmbeddedInHop() && typeof window !== "undefined" && "PublicKeyCredential" in window && (
                  <div className="drawer-row">
                    <label>Passkey</label>
                    <button type="button" className="quick-btn" onClick={enrollPasskey}>
                      Add Touch ID / passkey
                    </button>
                  </div>
                )}
                <div className="drawer-row">
                  <label>View</label>
                  <div className="view-mode-buttons">
                    <button type="button" className={viewMode === "fit" ? "active" : ""} onClick={() => setViewMode("fit")}>Auto-fit</button>
                    <button type="button" className={viewMode === "full" ? "active" : ""} onClick={() => setViewMode("full")}>Manual</button>
                  </div>
                </div>
                <div className="drawer-row">
                  <label>Switch</label>
                  <div className="view-mode-buttons">
                    <button type="button" className={sessionSwitchMode === "page" ? "active" : ""} onClick={() => setSessionSwitchMode("page")}>Page</button>
                    <button type="button" className={sessionSwitchMode === "instant" ? "active" : ""} onClick={() => setSessionSwitchMode("instant")}>Instant</button>
                  </div>
                </div>
                {notificationsSupported && (
                  <div className="drawer-row">
                    <label>Notify</label>
                    <div className="view-mode-buttons">
                      <button type="button" className={!notifyBells ? "active" : ""} onClick={() => handleNotifyToggle(false)}>Off</button>
                      <button type="button" className={notifyBells ? "active" : ""} onClick={() => handleNotifyToggle(true)}>On</button>
                    </div>
                  </div>
                )}
                {isMobile && hapticsSupported && (
                  <div className="drawer-row">
                    <label>Haptics</label>
                    <div className="view-mode-buttons">
                      <button type="button" className={hapticsEnabled ? "active" : ""} onClick={() => setHapticsEnabled(true)}>On</button>
                      <button type="button" className={!hapticsEnabled ? "active" : ""} onClick={() => setHapticsEnabled(false)}>Off</button>
                    </div>
                  </div>
                )}
              </div>
            </details>
            {notice && <p className="notice" role="status" aria-live="polite">{notice}</p>}
            {/* Session switching lives in the ⌘K switcher on every device now —
                the drawer is settings-only. */}
            <button
              type="button"
              className="quick-btn drawer-sessions-btn"
              onClick={() => {
                setDrawerOpen(false);
                setSwitcherOpen(true);
              }}
            >
              Sessions{!isMobile && <kbd style={{ marginLeft: 8 }}>{isMacPlatform ? "⌘K" : "⌃⇧K"}</kbd>}
            </button>
            <p className="build-stamp">build {__BUILD_STAMP__}</p>
          </section>
          {(() => {
            // Primary terminal as a render-on-demand function: it must not be
            // evaluated on the hub page (session can be null there), and the
            // pane renderer places it wherever the tree's primary leaf sits.
            const renderPrimarySection = (): ReactElement => (
              <section className={`terminal${status === "disconnected" || status === "ended" ? " degraded" : ""}`}>
                <div
                  className="terminal-frame"
                  onClick={() => {
                    // On mobile, don't focus terminal to prevent system keyboard
                    if (!isMobile) {
                      termRef.current?.focus();
                    }
                  }}
                  onDragEnter={(e) => {
                    if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
                      e.preventDefault();
                      dragDepthRef.current += 1;
                      setDropActive(true);
                    }
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDragLeave={() => {
                    if (dragDepthRef.current > 0 && --dragDepthRef.current === 0) {
                      setDropActive(false);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dragDepthRef.current = 0;
                    setDropActive(false);
                    if ((e.dataTransfer?.files?.length || 0) > 0) {
                      pushNotice(originalPathHint(platformString));
                      return;
                    }
                    // A dragged text snippet (e.g. a path string) pastes like
                    // a paste — bracketed-paste markers included.
                    const text = e.dataTransfer?.getData("text/plain");
                    if (text) termRef.current?.paste(text);
                  }}
                >
                  <div className="terminal-scroll">
                    <div className="terminal-inner" ref={containerRef} />
                  </div>
                  {dropActive && (
                    <div className="terminal-drop-overlay" aria-hidden="true">
                      <span>{originalPathHint(platformString)}</span>
                    </div>
                  )}
                  {isMobile && status === "connecting" && (
                    <div className="terminal-loading" role="status" aria-live="polite">
                      <IosSpinner />
                      <span className="terminal-loading-label">Loading session…</span>
                    </div>
                  )}
                  {historyPillVisible && status === "connected" && (
                    <button
                      type="button"
                      className="history-pill"
                      onClick={(e) => {
                        e.stopPropagation();
                        const room = activeSessionRoomRef.current;
                        if (!room) return;
                        deepReplayRoomsRef.current.add(room);
                        setHistoryPillVisible(false);
                        pushNotice("Loading full history…");
                        setReconnectToken((value) => value + 1);
                      }}
                    >
                      ↑ top of fast snapshot — load full history
                    </button>
                  )}
                  {searchActive && (
                    <div className="terminal-find" onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={searchInputRef}
                        className="terminal-find-input"
                        placeholder="Find in scrollback…"
                        value={searchQuery}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          runSearch(e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            searchStep(e.shiftKey ? -1 : 1);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            closeSearch();
                          }
                        }}
                      />
                      <span className="terminal-find-count">
                        {searchInfo.total > 0 ? `${searchInfo.index}/${searchInfo.total}` : searchQuery ? "0/0" : ""}
                      </span>
                      <button type="button" className="terminal-find-btn" onClick={() => searchStep(-1)} aria-label="Previous match">↑</button>
                      <button type="button" className="terminal-find-btn" onClick={() => searchStep(1)} aria-label="Next match">↓</button>
                      <button type="button" className="terminal-find-btn" onClick={closeSearch} aria-label="Close search">✕</button>
                    </div>
                  )}
                </div>
                <div className="terminal-footer">
                  <span className="footer-chip">{sessionLabel || session.room}</span>
                  {liveCwd ? <span className="footer-cwd">{liveCwd}</span> : null}
                  <span className="footer-spacer" />
                  {status === "connected" ? (
                    <>
                      <button type="button" className="footer-find-toggle" aria-label="Find in terminal" onClick={openSearch}>
                        {isMacPlatform ? "⌘F" : "Ctrl+F"} find
                      </button>
                      {!isMobile && (
                        <button type="button" className="footer-find-toggle" aria-label="Keyboard shortcuts" onClick={() => setShortcutHelpOpen(true)}>
                          {isMacPlatform ? "⌘/" : "Ctrl+Shift+/"} keys
                        </button>
                      )}
                      <span>
                        {sortedPresence.length} viewer{sortedPresence.length === 1 ? "" : "s"}
                      </span>
                    </>
                  ) : status === "idle" ? (
                    <span>awaiting connection</span>
                  ) : status === "ended" ? (
                    <>
                      <span className="ended-label">session ended</span>
                      <button
                        type="button"
                        className="footer-reconnect"
                        onClick={() => setReconnectToken((value) => value + 1)}
                      >
                        Reconnect
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="reconnecting">
                        ⟳ {status === "connecting" ? "Connecting…" : "Reconnecting…"}
                      </span>
                      <button
                        type="button"
                        className="footer-reconnect"
                        onClick={() => setReconnectToken((value) => value + 1)}
                      >
                        Reconnect now
                      </button>
                    </>
                  )}
                  <span className={`footer-dot ${status}`} aria-hidden="true">
                    ●
                  </span>
                </div>
              </section>
            );
            const renderDivider = (node: Extract<PaneNode, { kind: "split" }>): ReactElement => (
              <div
                key={`div-${node.id}`}
                className="pane-divider"
                onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
                  const parent = (e.currentTarget as HTMLElement).parentElement;
                  if (!parent) return;
                  paneDragRef.current = { id: node.id, dir: node.dir, rect: parent.getBoundingClientRect() };
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e: ReactPointerEvent<HTMLDivElement>) => {
                  const d = paneDragRef.current;
                  if (!d || d.id !== node.id) return;
                  const r = d.dir === "row"
                    ? (e.clientX - d.rect.left) / Math.max(1, d.rect.width)
                    : (e.clientY - d.rect.top) / Math.max(1, d.rect.height);
                  setPaneRatio(d.id, Math.min(0.85, Math.max(0.15, r)));
                }}
                onPointerUp={() => { paneDragRef.current = null; }}
              />
            );
            const renderPaneNode = (node: PaneNode): ReactElement => {
              if (node.kind === "leaf") {
                if (node.session === null) {
                  return (
                    <div key="primary" className="primary-pane-wrap" onMouseDownCapture={() => setFocusedPaneId("primary")}>
                      {renderPrimarySection()}
                    </div>
                  );
                }
                if (node.session === "") {
                  // Empty pane awaiting a session (split-first, then fill).
                  return (
                    <div
                      key={node.id}
                      className={`empty-pane${focusedPaneId === node.id ? " focused" : ""}`}
                      onMouseDown={() => setFocusedPaneId(node.id)}
                    >
                      <button
                        type="button"
                        className="empty-pane-pick"
                        onClick={() => { setFocusedPaneId(node.id); paneTargetRef.current = node.id; setSwitcherOpen(true); }}
                      >
                        <span className="empty-pane-plus">+</span>
                        <span>Pick a session&ensp;<kbd>{isMacPlatform ? "⌘K" : "Ctrl+Shift+K"}</kbd></span>
                      </button>
                      <button type="button" className="empty-pane-close" aria-label="Close empty pane" onClick={(e) => { e.stopPropagation(); closePane(node.id); }}>✕</button>
                    </div>
                  );
                }
                const paneInfo = sessions.find((x) => x.name === node.session || x.internalName === node.session);
                const paneProcRaw = (paneInfo?.foregroundProcess || "").replace(/^-/, "");
                const paneProc = /^\d+\.\d+\.\d+$/.test(paneProcRaw) ? "claude" : paneProcRaw;
                return (
                  <SecondaryPane
                    key={node.id}
                    sessionName={node.session}
                    procLabel={paneProc === "zsh" || paneProc === "bash" ? "" : paneProc}
                    wsUrl={resolveWsUrl()}
                    userName={name}
                    cols={120}
                    rows={30}
                    fontSize={fontSize}
                    theme={resolveTerminalTheme(themeMode)}
                    focused={focusedPaneId === node.id}
                    onFocus={() => setFocusedPaneId(node.id)}
                    onClose={() => closePane(node.id)}
                    onPromote={() => swapPaneWithPrimary(node.id)}
                  />
                );
              }
              return (
                <div key={node.id} className={`pane-split ${node.dir === "row" ? "dir-row" : "dir-col"}`}>
                  <div className="pane-cell" style={{ flexGrow: node.ratio, flexBasis: 0 }}>{renderPaneNode(node.a)}</div>
                  {renderDivider(node)}
                  <div className="pane-cell" style={{ flexGrow: 1 - node.ratio, flexBasis: 0 }}>{renderPaneNode(node.b)}</div>
                </div>
              );
            };
            const primaryWrap = (
              <div key="primary" className="primary-pane-wrap" onMouseDownCapture={() => setFocusedPaneId("primary")}>
                {renderPrimarySection()}
              </div>
            );
            if (isMobile) return renderPrimarySection();
            // Stable scaffold: the primary's ancestor chain (pane-root → root
            // split → cell A) and keys are IDENTICAL with and without a split,
            // so adding/removing panes never re-parents the live terminal.
            const rootSplit = paneTree.kind === "split" ? paneTree : null;
            return (
              <div className="pane-root">
                <div key="rootsplit" className={`pane-split ${rootSplit?.dir === "col" ? "dir-col" : "dir-row"}`}>
                  <div key="cell-a" className="pane-cell" style={{ flexGrow: rootSplit ? rootSplit.ratio : 1, flexBasis: 0 }}>
                    {rootSplit && rootSplit.a.kind !== "leaf" ? renderPaneNode(rootSplit.a) : primaryWrap}
                  </div>
                  {rootSplit && renderDivider(rootSplit)}
                  {rootSplit && (
                    <div key="cell-b" className="pane-cell" style={{ flexGrow: 1 - rootSplit.ratio, flexBasis: 0 }}>
                      {renderPaneNode(rootSplit.b)}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
          <SessionSwitcher
            open={switcherOpen}
            sessions={sessions}
            // A killed/ended session is nobody's "current": presenting it as
            // such badged a dead room and anchored keyboard selection on it.
            currentRoom={status === "ended" ? null : session.room}
            onClose={() => { paneTargetRef.current = null; setSwitcherOpen(false); }}
            onSwitch={(next) => {
              const targetPane = paneTargetRef.current;
              if (targetPane) {
                paneTargetRef.current = null;
                fillPane(targetPane, next.name);
              } else {
                switchSession(next as SessionInfo);
              }
              setSwitcherOpen(false);
            }}
            onRefresh={() => fetchSessions({ showLoading: false })}
            onNotice={showToast}
            tileWsBase={resolveWsUrl()}
            userName={name}
            terminalTheme={resolveTerminalTheme(themeMode)}
            onOpenSettings={() => {
              setSwitcherOpen(false);
              setDrawerOpen(true);
            }}
            onToggleKeyboard={
              isMobile
                ? () => {
                    setSwitcherOpen(false);
                    handleKeyboardToggle();
                  }
                : undefined
            }
            onFind={
              isMobile
                ? () => {
                    setSwitcherOpen(false);
                    openSearch();
                  }
                : undefined
            }
          />
          {shortcutHelpOpen && !isMobile && (
            <>
              <div className="drawer-overlay" onClick={() => setShortcutHelpOpen(false)} />
              <div className="shortcut-help" role="dialog" aria-label="Keyboard shortcuts">
                <h3>Keyboard shortcuts</h3>
                {[
                  [isMacPlatform ? "⌘K" : "Ctrl+Shift+K", "session palette (type to filter, ↑↓, ⏎)"],
                  [isMacPlatform ? "⌘J / ⌘⇧J" : "Ctrl+Shift+J / +⇧", "next / previous session"],
                  [isMacPlatform ? "⌘," : "Ctrl+Shift+,", "settings drawer"],
                  [isMacPlatform ? "⌘F" : "Ctrl+Shift+F", "find in terminal"],
                  ...(isMacPlatform ? [["⌘+ / ⌘− / ⌘0", "terminal font size"]] : []),
                  ["Ctrl+Shift+C / V", "copy / paste"],
                  ["Shift+PgUp / PgDn", "scrollback"],
                  [isMacPlatform ? "⌘\\ / ⌘⇧\\" : "Ctrl+Shift+\\ / +|", "split pane — side / stacked"],
                  [isMacPlatform ? "⌘⇧K" : "Ctrl+Shift+K", "close focused pane"],
                  [isMacPlatform ? "⌘] / ⌘[" : "Ctrl+Shift+] / [", "next / previous pane"],
                  [isMacPlatform ? "⌘⇧E" : "Ctrl+Shift+E", "swap pane with primary"],
                  [isMacPlatform ? "⌘/" : "Ctrl+Shift+/", "this help"],
                  ["Esc", "close panels"]
                ].map(([keys, what]) => (
                  <div key={keys as string} className="shortcut-help-row">
                    <kbd>{keys}</kbd>
                    <span>{what}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {passkeyNudge && (
            <div className="link-prompt passkey-nudge" role="dialog" aria-label="Enable biometric sign-in">
              <span className="link-prompt-url">
                {isMacPlatform ? "Sign in with Touch ID / Face ID next time?" : "Sign in with a passkey next time?"}
              </span>
              <button
                type="button"
                className="link-prompt-open"
                onClick={async () => {
                  dismissPasskeyNudge();
                  await enrollPasskey();
                }}
              >
                Enable
              </button>
              <button type="button" onClick={dismissPasskeyNudge}>Not now</button>
            </div>
          )}
          {linkPrompt && (
            <div className="link-prompt" role="dialog" aria-label="Open link">
              <span className="link-prompt-url">{linkPrompt}</span>
              <button
                type="button"
                className="link-prompt-open"
                onClick={() => {
                  window.open(linkPrompt, "_blank", "noopener");
                  setLinkPrompt(null);
                }}
              >
                Open
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(linkPrompt);
                    showToast("Link copied");
                  } catch {
                    showToast("Clipboard denied — long-press the URL text instead");
                  }
                  setLinkPrompt(null);
                }}
              >
                Copy
              </button>
              <button type="button" aria-label="Dismiss" onClick={() => setLinkPrompt(null)}>✕</button>
            </div>
          )}
          {isMobile && (
            <MobileKeyboard
              onInput={handleKeyboardInput}
              // Hidden while the palette is open: its system-keyboard textarea
              // holds focus on phones, so leaving it mounted meant filter
              // typing went straight to the session.
              visible={keyboardVisible && !switcherOpen}
              onToggle={handleKeyboardToggle}
              onHeightChange={setKeyboardHeight}
              hapticsEnabled={hapticsEnabled}
              onPasteFailed={() =>
                showToast("Clipboard access denied — long-press the terminal to paste instead.", 3500)
              }
            />
          )}
          {toast && <div className="terminal-toast" role="status" aria-live="polite">{toast}</div>}
        </main>
      )}
    </div>
  );
};

export default App;
