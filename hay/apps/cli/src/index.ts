#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { safeParseServerMessage, type ClientMessage, type PresenceClient } from "hay-shared";

const args = process.argv.slice(2);
const isMac = process.platform === "darwin";
const keyLabelShort = isMac ? "Opt" : "Alt";
const keyLabelLong = isMac ? "Option" : "Alt";

type ThemeName = "auto" | "light" | "dark";
type CliConfig = {
  showHints?: boolean;
  showStatusBar?: boolean;
  mouseCapture?: boolean;
  syncSize?: boolean;
  scrollOff?: number;
  theme?: ThemeName;
};
type HopConfig = { "hay-cli"?: CliConfig };
const DEFAULT_SCROLL_OFF = 3;

// Config file locations (checked in order, first found wins)
const CONFIG_LOCATIONS = [
  // Local configs (current directory)
  { path: ".hay-cli.json", isLegacy: true, isLocal: true },
  { path: ".hop.json", isLegacy: false, isLocal: true },
  // Global configs (home directory)
  { path: path.join(os.homedir(), ".hay-cli.json"), isLegacy: true, isLocal: false },
  { path: path.join(os.homedir(), ".hop.json"), isLegacy: false, isLocal: false },
];

// Find which config file to use
const getConfigPath = (): { path: string; isLegacy: boolean; isLocal: boolean } | null => {
  for (const loc of CONFIG_LOCATIONS) {
    if (fs.existsSync(loc.path)) {
      return loc;
    }
  }
  return null;
};

// Get the path where we should save config (prefer global .hop.json)
const getSaveConfigPath = (): { path: string; isLegacy: boolean } => {
  // If a legacy file exists anywhere, use the global legacy path
  const existing = getConfigPath();
  if (existing?.isLegacy) {
    return { path: path.join(os.homedir(), ".hay-cli.json"), isLegacy: true };
  }
  // Otherwise use global .hop.json
  return { path: path.join(os.homedir(), ".hop.json"), isLegacy: false };
};

const loadConfig = (): CliConfig => {
  try {
    const loc = getConfigPath();
    if (!loc) return {};
    const raw = fs.readFileSync(loc.path, "utf8");
    const parsed = JSON.parse(raw);
    if (loc.isLegacy) {
      return (parsed as CliConfig) ?? {};
    }
    // Read from hay-cli key in .hop.json
    return (parsed as HopConfig)?.["hay-cli"] ?? {};
  } catch {
    return {};
  }
};

const saveConfig = (config: CliConfig) => {
  try {
    const { path: configPath, isLegacy } = getSaveConfigPath();
    if (isLegacy) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } else {
      // Read existing .hop.json and update hay-cli key
      let hopConfig: HopConfig = {};
      if (fs.existsSync(configPath)) {
        try {
          hopConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
        } catch {
          hopConfig = {};
        }
      }
      hopConfig["hay-cli"] = config;
      fs.writeFileSync(configPath, JSON.stringify(hopConfig, null, 2));
    }
  } catch {
    // Ignore config write errors
  }
};

const globalWindow = globalThis as typeof globalThis & {
  window?: typeof globalThis;
  requestIdleCallback?: (callback: (deadline: { timeRemaining: () => number; didTimeout: boolean }) => void) => NodeJS.Timeout;
  cancelIdleCallback?: (handle: NodeJS.Timeout) => void;
};

if (!globalWindow.window) {
  globalWindow.window = globalWindow;
}

if (!globalWindow.requestIdleCallback) {
  globalWindow.requestIdleCallback = (callback) => {
    return setTimeout(() => callback({ timeRemaining: () => 0, didTimeout: false }), 0);
  };
}

if (!globalWindow.cancelIdleCallback) {
  globalWindow.cancelIdleCallback = (handle) => {
    clearTimeout(handle);
  };
}

const require = createRequire(import.meta.url);
const { Terminal } = require("xterm-headless") as typeof import("xterm-headless");

function parseArgs() {
  let server = "ws://localhost:4001/ws";
  let room = "";
  let name = process.env.USER || "cli-user";
  let theme: ThemeName | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--server" || arg === "-s") {
      server = args[++i] || server;
    } else if (arg === "--room" || arg === "-r") {
      room = args[++i] || room;
    } else if (arg === "--name" || arg === "-n") {
      name = args[++i] || name;
    } else if (arg === "--theme") {
      const value = (args[++i] || "").toLowerCase();
      if (value !== "auto" && value !== "light" && value !== "dark") {
        console.error(`Invalid --theme value: ${value || "(none)"}. Use auto, light, or dark.`);
        process.exit(1);
      }
      theme = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
hay-cli - Connect to a hay room from your terminal

Usage:
  hay [options]

Options:
  -s, --server <url>   WebSocket server URL (default: ws://localhost:4001/ws)
  -r, --room <name>    Room name (required)
  -n, --name <name>    Display name (default: $USER)
  --theme <mode>       Bar theme: auto (default; matches the terminal background),
                       light, or dark. Persist it in .hop.json:
                       {"hay-cli": {"theme": "dark"}}
  -h, --help           Show this help

Keyboard shortcuts:
  Ctrl+G               Detach (session keeps running in the background)
  Ctrl+Q Ctrl+Q        Kill session for ALL participants (press twice to confirm)
  ${keyLabelLong}+←/→/↑/↓        Pan viewport (add Shift for faster panning)
  ${keyLabelLong}+H/J/K/L        Pan viewport, vim-style (Shift = faster)
  ${keyLabelLong}+0             Return to live output (center on cursor)
  ${keyLabelLong}+A             Toggle autofit of remote size to window (saved)
  ${keyLabelLong}+B             Toggle status bar (saved)
  ${keyLabelLong}+M             Toggle mouse capture (saved)
  ${keyLabelLong}+C             Take/release exclusive control
  ${keyLabelLong}+F             Search scrollback (Enter/↓ next, ↑ prev, Esc close)
  ${keyLabelLong}+T             Toggle hint bar (saved)
  ${keyLabelLong}+\\             Send the next key literally to the remote terminal
                       (lets reserved keys like Ctrl+Q/G reach remote programs)

${keyLabelLong}+<key> shortcuts arrive as ESC-prefixed keys; on non-macOS terminals
(and macOS terminals without "Option as Meta") enable option/alt-as-meta or
ESC-prefix in your terminal settings for them to work.

Sessions persist on the server when you detach or the client exits;
reattach with: hay -r <room>. Only Ctrl+Q (twice) ends the session itself.

Examples:
  hay -r my-room
  hay -r my-room -n alice -s ws://example.com/ws
`);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}. Run hay --help`);
      process.exit(1);
    } else if (!room) {
      room = arg;
    } else {
      console.error(`Unexpected argument: ${arg} (room is already '${room}'). Run hay --help`);
      process.exit(1);
    }
  }

  return { server, room, name, theme };
}

const config = parseArgs();

if (!config.room) {
  console.error("Error: Room name is required. Use -r <room> or pass room name as argument.");
  console.error("Run with --help for usage information.");
  process.exit(1);
}

let sessionLabel = config.room;
let liveCwd: string | null = null;

const DETACH_EXIT_CODE = 10;
const KILL_EXIT_CODE = 11;
// Ctrl+Q while the server is unreachable: nothing was killed, so exit on a
// distinct code instead of pretending the session ended.
const KILL_UNREACHABLE_EXIT_CODE = 12;
const KILL_CONFIRM_MS = 2000;
// Give up if the very first connection never succeeds after this many attempts.
const MAX_NEVER_CONNECTED_ATTEMPTS = 5;
const TYPING_IDLE_MS = 1200;
const NOTICE_MS = 3500;
const HOP_DAEMON_POLL_MS = 5000;
const PAN_STEP = 2;
const PAN_FAST_STEP = 10;
let cursorVisible = true;
const SCROLL_STEP = 3;
const REMOTE_MOUSE_MODE_PARAMS = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
const REMOTE_ALT_SCREEN_PARAMS = new Set([47, 1047, 1049]);
const REMOTE_APPLICATION_CURSOR_MODE_PARAM = 1;
const PRIVATE_MODE_TAIL_CHARS = 64;
let pendingInput = "";
let remoteMouseModes = new Set<number>();
let remoteAlternateScreen = false;
let remoteApplicationCursor = false;
let pendingPrivateMode = "";
type RgbColor = { r: number; g: number; b: number };
let defaultFg: RgbColor | null = null;
let defaultBg: RgbColor | null = null;
let defaultCursor: RgbColor | null = null;
let pendingOsc = "";

let ws: WebSocket | null = null;
let clientId: string | null = null;
let connected = false;
let status: "connecting" | "connected" | "reconnecting" | "disconnected" = "connecting";
let shouldReconnect = true;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let nextReconnectAt = 0;
let reconnectTicker: NodeJS.Timeout | null = null;
let typingTimeout: NodeJS.Timeout | null = null;
let noticeTimer: NodeJS.Timeout | null = null;
let daemonPollTimer: NodeJS.Timeout | null = null;
let exitCode = 0;
let exitMessage: string | null = null;
let shortcutsEnabledAt = 0;
let attachNoticeShown = false;
let pendingAttachNotice = false;
let everConnected = false;
let lastWsError: string | null = null;
let killArmedAt = 0; // Ctrl+Q pressed once; second press before this kills
let killRequested = false; // we sent kill_session ourselves
let literalNext = false; // Opt+\ armed: forward the next key verbatim

let collabMode = true;
let controllerId: string | null = null;
let presence: PresenceClient[] = [];
type NoticeKind = "info" | "ok" | "warn";
let notice: { message: string; kind: NoticeKind; expiresAt: number } | null = null;

let syncSize = true;
let mouseCapture = false;
let showStatusBar = true;
let viewX = 0;
let viewY = 0;
let followOutput = true;
let showHints = true;
let scrollOff = DEFAULT_SCROLL_OFF;

// Mouse selection state
type SelectionPoint = { row: number; col: number }; // buffer coordinates
let selectionAnchor: SelectionPoint | null = null;    // where drag started
let selectionEnd: SelectionPoint | null = null;       // where drag currently is
let isSelecting = false;
let selectionScrollTimer: NodeJS.Timeout | null = null;
const SELECTION_SCROLL_INTERVAL = 50;
const SELECTION_SCROLL_SPEED = 1;

// Scrollback search state (Opt+F). searchMatches are absolute buffer coords;
// col is the match start in the line's collapsed text (≈ buffer column for ASCII).
let searchMode = false;
let searchQuery = "";
let searchMatches: Array<{ row: number; col: number }> = [];
let searchMatchesByRow = new Map<number, number[]>(); // row → match start cols, for O(1) render lookups
let searchIndex = -1;
const SEARCH_MAX_MATCHES = 2000;

let configFile = loadConfig();
const persistConfig = (patch: Partial<CliConfig>) => {
  configFile = { ...configFile, ...patch };
  saveConfig(configFile);
};
showHints = configFile.showHints ?? true;
showStatusBar = configFile.showStatusBar ?? true;
mouseCapture = configFile.mouseCapture ?? false;
syncSize = configFile.syncSize ?? true;
scrollOff = configFile.scrollOff ?? DEFAULT_SCROLL_OFF;

let uiInitialized = false;
let renderScheduled = false;
let lastRenderCols = 0;
let lastRenderRows = 0;
let lastRenderedLines: string[] = []; // previous frame's lines, for dirty-line diffing

// ---- Bar theme -------------------------------------------------------------
// The bars adapt to the terminal: "auto" (default) resolves light/dark from the
// terminal's reported background (OSC 11 query, with $COLORFGBG as an immediate
// guess until the reply arrives); "light"/"dark" pin a palette. Configure with
// --theme or {"hay-cli": {"theme": "dark"}} in .hop.json. Colors are truecolor
// when $COLORTERM advertises it, with 256-color fallbacks otherwise.
type BarColor = { rgb: [number, number, number]; c256: number };
type BarPalette = {
  statusBg: BarColor; // status line surface
  hintBg: BarColor; // hint line surface (one step fainter, for hierarchy)
  fg: BarColor;
  dim: BarColor;
  accent: BarColor;
  accentFg: BarColor; // text on accent (the session chip)
  ok: BarColor;
  warn: BarColor;
  err: BarColor;
};

const LIGHT_PALETTE: BarPalette = {
  statusBg: { rgb: [233, 233, 237], c256: 254 },
  hintBg: { rgb: [242, 242, 247], c256: 255 },
  fg: { rgb: [29, 29, 31], c256: 234 },
  dim: { rgb: [110, 110, 115], c256: 242 },
  accent: { rgb: [124, 58, 237], c256: 93 },
  accentFg: { rgb: [255, 255, 255], c256: 15 },
  ok: { rgb: [26, 127, 55], c256: 28 },
  warn: { rgb: [180, 83, 9], c256: 130 },
  err: { rgb: [207, 34, 46], c256: 160 }
};

const DARK_PALETTE: BarPalette = {
  statusBg: { rgb: [42, 42, 46], c256: 236 },
  hintBg: { rgb: [35, 35, 39], c256: 235 },
  fg: { rgb: [230, 230, 233], c256: 252 },
  dim: { rgb: [147, 147, 155], c256: 245 },
  accent: { rgb: [167, 139, 250], c256: 141 },
  accentFg: { rgb: [29, 29, 31], c256: 234 },
  ok: { rgb: [63, 185, 80], c256: 71 },
  warn: { rgb: [210, 153, 34], c256: 178 },
  err: { rgb: [248, 81, 73], c256: 203 }
};

const supportsTruecolor = /truecolor|24bit/i.test(process.env.COLORTERM || "");
const fgAnsi = (color: BarColor) =>
  supportsTruecolor ? `\x1b[38;2;${color.rgb.join(";")}m` : `\x1b[38;5;${color.c256}m`;
const bgAnsi = (color: BarColor) =>
  supportsTruecolor ? `\x1b[48;2;${color.rgb.join(";")}m` : `\x1b[48;5;${color.c256}m`;

const makeBarStyles = (p: BarPalette) => ({
  statusBg: bgAnsi(p.statusBg),
  hintBg: bgAnsi(p.hintBg),
  fg: fgAnsi(p.fg),
  dim: fgAnsi(p.dim),
  accent: fgAnsi(p.accent),
  ok: fgAnsi(p.ok),
  warn: fgAnsi(p.warn),
  err: fgAnsi(p.err),
  bold: "\x1b[1m",
  // Restore default bar text after a bold/colored token (keeps the bar bg).
  resetFg: `\x1b[22m${fgAnsi(p.fg)}`,
  // Session chip: accent pill; callers restore statusBg+fg afterwards.
  chip: `${bgAnsi(p.accent)}${fgAnsi(p.accentFg)}\x1b[1m`,
  reconnect: `\x1b[1m${fgAnsi(p.warn)}`
});

let BAR = makeBarStyles(LIGHT_PALETTE);
const applyResolvedTheme = (resolved: "light" | "dark") => {
  BAR = makeBarStyles(resolved === "dark" ? DARK_PALETTE : LIGHT_PALETTE);
  if (uiInitialized) {
    lastRenderedLines = [];
    scheduleRender();
  }
};

// $COLORFGBG looks like "15;0" (fg;bg) — bg 0-6 and 8 mean a dark background.
const guessThemeFromEnv = (): "light" | "dark" | null => {
  const raw = process.env.COLORFGBG;
  if (!raw) return null;
  const bg = Number(raw.split(";").pop());
  if (!Number.isFinite(bg)) return null;
  return bg <= 6 || bg === 8 ? "dark" : "light";
};

const themePref: ThemeName = config.theme ?? configFile.theme ?? "auto";
let themeQueryDeadline = 0; // OSC 11 reply capture window (auto detection)
let themeQueryAsked = false;
if (themePref === "light" || themePref === "dark") {
  applyResolvedTheme(themePref);
} else {
  applyResolvedTheme(guessThemeFromEnv() ?? "light");
}

const hopHomeDir = process.env.HOP_HOME || path.join(os.homedir(), ".hop2");
const hopTunnelStateFile = path.join(hopHomeDir, ".tunnel-state");
const explicitShareEnv = process.env.HAY_SHARE_URL || process.env.HOP_PUBLIC_URL || "";

const normalizeUrlOrigin = (raw: string) => {
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return raw;
  }
};

const inferServerOrigin = () => {
  try {
    const wsUrl = new URL(config.server);
    const protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
    return normalizeUrlOrigin(`${protocol}//${wsUrl.host}`);
  } catch {
    return "";
  }
};

const explicitShareUrl = explicitShareEnv ? normalizeUrlOrigin(explicitShareEnv) : "";
const defaultShareUrl = explicitShareUrl || inferServerOrigin();

const shouldTrackHopDaemon = (() => {
  if (process.env.HAY_TRACK_HOP_DAEMON === "1") return true;
  if (process.env.HAY_TRACK_HOP_DAEMON === "0") return false;
  try {
    const wsUrl = new URL(config.server);
    return wsUrl.hostname === "127.0.0.1" || wsUrl.hostname === "localhost" || wsUrl.hostname === "::1";
  } catch {
    return false;
  }
})();

let hopDaemonRunning = false;
let hopDaemonShareUrl = "";

const getLocalMetrics = () => {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const hasNotice = !!notice && notice.expiresAt > Date.now();
  const showBottomBar = showStatusBar && rows >= 2;
  // The persistent hint/controls line is subordinate to the status bar, so Opt+B
  // clears the whole bottom chrome (both lines), not just the status line. A
  // transient notice still flashes even with the status bar hidden; Opt+T still
  // toggles just the hint line while the status bar is shown. The reconnect
  // banner forces the line on regardless, so a dropped connection is never silent.
  const reconnecting = !connected && reconnectAttempt > 0;
  const showHintBar = ((showHints && showBottomBar) || hasNotice || reconnecting || searchMode) && rows >= (showBottomBar ? 3 : 2);
  const barRows = (showBottomBar ? 1 : 0) + (showHintBar ? 1 : 0);
  return {
    cols,
    rows,
    barRows,
    showBottomBar,
    showHintBar,
    viewportCols: Math.max(1, cols),
    viewportRows: Math.max(1, rows - barRows)
  };
};

let localMetrics = getLocalMetrics();

let remoteCols = Math.max(2, localMetrics.viewportCols);
let remoteRows = Math.max(1, localMetrics.viewportRows);

const terminal = new Terminal({
  cols: remoteCols,
  rows: remoteRows,
  scrollback: 50000,
  allowProposedApi: true
});

// True while replaying a snapshot's historical output into the terminal.
// Snapshots are raw PTY history that can contain DSR/DA/CPR/OSC queries; xterm
// answers them via onData, and forwarding those stale answers to the live PTY
// injects junk (e.g. "^[[1;9R") at the remote prompt on every reconnect.
let replayingSnapshot = false;

// Forward terminal-generated responses (eg. DSR cursor reports) back to the PTY.
terminal.onData((data) => {
  if (!data) return;
  if (replayingSnapshot) return;
  sendMessage({ type: "input", data });
});

const filterFocusSequences = (data: string) => data.replace(/\x1b\[I/g, "").replace(/\x1b\[O/g, "");

const getDirectionalKey = (direction: number) => {
  if (remoteApplicationCursor) {
    return direction > 0 ? "\x1bOB" : "\x1bOA";
  }
  return direction > 0 ? "\x1b[B" : "\x1b[A";
};

const stripMouseSequences = (data: string) => {
  const cleaned = data.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (sequence, buttonText, xText, yText, kind) => {
    if (!mouseCapture) {
      return "";
    }
    const button = Number(buttonText);
    const x = Number(xText);
    const y = Number(yText);

    // Handle wheel events first (existing logic)
    const isWheel = (button & 64) === 64;
    if (isWheel && kind === "M") {
      // Wheel left/right (buttons 66/67) arrive on touchpads with any
      // horizontal drift; treating them as vertical makes scrolling bounce.
      const wheelAxis = button & 3;
      if (wheelAxis >= 2) {
        return "";
      }
      // Wheel clears any active selection
      clearSelection();
      const direction = wheelAxis === 1 ? 1 : -1;
      const isTuiLikeMode = remoteAlternateScreen || remoteMouseModes.size > 0;
      if (isTuiLikeMode) {
        return getDirectionalKey(direction).repeat(SCROLL_STEP);
      }
      viewY += direction * SCROLL_STEP;
      clampView();
      updateFollowOutputFromViewport();
      scheduleRender();
      return "";
    }

    // Try local mouse selection handling
    const result = handleMouseEvent(button, x, y, kind);
    if (result === "handled") return "";
    if (result === "passthrough") return sequence;

    return "";
  });
  return { cleaned };
};

// ── Selection helpers ──

const selectionNormalized = (): { start: SelectionPoint; end: SelectionPoint } | null => {
  if (!selectionAnchor || !selectionEnd) return null;
  const a = selectionAnchor;
  const b = selectionEnd;
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) {
    return { start: a, end: b };
  }
  return { start: b, end: a };
};

const isCellSelected = (bufferRow: number, bufferCol: number): boolean => {
  const sel = selectionNormalized();
  if (!sel) return false;
  const { start, end } = sel;
  if (bufferRow < start.row || bufferRow > end.row) return false;
  if (bufferRow === start.row && bufferRow === end.row) {
    return bufferCol >= start.col && bufferCol <= end.col;
  }
  if (bufferRow === start.row) return bufferCol >= start.col;
  if (bufferRow === end.row) return bufferCol <= end.col;
  return true;
};

const getSelectedText = (): string => {
  const sel = selectionNormalized();
  if (!sel) return "";
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = sel.start.row; row <= sel.end.row; row++) {
    const line = buffer.getLine(row);
    if (!line) { lines.push(""); continue; }
    // Slice by buffer columns via translateToString's range args, not by JS
    // string index — wide chars (CJK/emoji) span 2 columns but 1 code unit, so
    // a column index into the collapsed string copies the wrong span.
    if (row === sel.start.row && row === sel.end.row) {
      lines.push(line.translateToString(true, sel.start.col, sel.end.col + 1));
    } else if (row === sel.start.row) {
      lines.push(line.translateToString(true, sel.start.col));
    } else if (row === sel.end.row) {
      lines.push(line.translateToString(true, 0, sel.end.col + 1));
    } else {
      lines.push(line.translateToString(true));
    }
  }
  return lines.map(l => l.trimEnd()).join("\n");
};

const copySelectionToClipboard = () => {
  const text = getSelectedText();
  if (!text) return;
  // OSC 52: set clipboard. Base64-encode the text.
  const encoded = Buffer.from(text, "utf8").toString("base64");
  process.stdout.write(`\x1b]52;c;${encoded}\x07`);
  // Hedged wording: OSC 52 is fire-and-forget, the terminal may not support it.
  pushNotice(`Sent ${text.split("\n").length} line(s) to clipboard (OSC 52)`, "ok");
};

const clearSelection = () => {
  if (!selectionAnchor && !selectionEnd) return;
  selectionAnchor = null;
  selectionEnd = null;
  isSelecting = false;
  stopSelectionScroll();
  scheduleRender();
};

const stopSelectionScroll = () => {
  if (selectionScrollTimer) {
    clearInterval(selectionScrollTimer);
    selectionScrollTimer = null;
  }
};

const handleMouseEvent = (button: number, x: number, y: number, kind: string): string => {
  const isPress = kind === "M";
  const isRelease = kind === "m";
  const btnId = button & 3;     // 0=left, 1=middle, 2=right
  const isMotion = (button & 32) !== 0;
  const isWheel = (button & 64) !== 0;

  // Wheel events: handle scrolling (pass through to existing logic)
  if (isWheel) return "wheel";

  // If remote mouse modes are active, don't handle selection locally
  if (remoteMouseModes.size > 0) return "passthrough";

  // Convert 1-based terminal coords to 0-based buffer coords
  const screenRow = y - 1;  // 0-based viewport row
  const screenCol = x - 1;  // 0-based viewport col
  const bufferRow = viewY + screenRow;
  const bufferCol = viewX + screenCol;

  // Left button press: start selection
  if (btnId === 0 && isPress && !isMotion) {
    clearSelection();
    selectionAnchor = { row: bufferRow, col: bufferCol };
    selectionEnd = { row: bufferRow, col: bufferCol };
    isSelecting = true;
    return "handled";
  }

  // Motion with left button held: extend selection
  if (isMotion && isPress && isSelecting) {
    selectionEnd = { row: bufferRow, col: bufferCol };

    // Auto-scroll when dragging near viewport edges
    stopSelectionScroll();
    if (screenRow <= 0) {
      // Dragging above viewport — scroll up
      selectionScrollTimer = setInterval(() => {
        if (!isSelecting) { stopSelectionScroll(); return; }
        viewY = Math.max(0, viewY - SELECTION_SCROLL_SPEED);
        if (selectionEnd) selectionEnd = { row: selectionEnd.row - SELECTION_SCROLL_SPEED, col: selectionEnd.col };
        updateFollowOutputFromViewport();
        scheduleRender();
      }, SELECTION_SCROLL_INTERVAL);
    } else if (screenRow >= localMetrics.viewportRows - 1) {
      // Dragging below viewport — scroll down
      selectionScrollTimer = setInterval(() => {
        if (!isSelecting) { stopSelectionScroll(); return; }
        const maxView = terminal.buffer.active.length - localMetrics.viewportRows;
        viewY = Math.min(Math.max(0, maxView), viewY + SELECTION_SCROLL_SPEED);
        if (selectionEnd) selectionEnd = { row: selectionEnd.row + SELECTION_SCROLL_SPEED, col: selectionEnd.col };
        updateFollowOutputFromViewport();
        scheduleRender();
      }, SELECTION_SCROLL_INTERVAL);
    }

    scheduleRender();
    return "handled";
  }

  // Left button release: finalize selection
  if (btnId === 0 && isRelease) {
    stopSelectionScroll();
    isSelecting = false;
    const sel = selectionNormalized();
    if (sel && (sel.start.row !== sel.end.row || sel.start.col !== sel.end.col)) {
      copySelectionToClipboard();
    } else {
      // Click without drag — clear selection
      clearSelection();
    }
    return "handled";
  }

  return "unhandled";
};

const parseOscColor = (value: string): RgbColor | null => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "default") {
    return null;
  }
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
      return { r, g, b };
    }
    return null;
  }
  if (trimmed.startsWith("rgb:")) {
    const parts = trimmed.slice(4).split("/");
    if (parts.length < 3) return null;
    const parsePart = (part: string) => {
      if (!part) return null;
      const valueNum = parseInt(part, 16);
      if (Number.isNaN(valueNum)) return null;
      const max = Math.pow(16, part.length) - 1;
      return Math.round((valueNum / max) * 255);
    };
    const r = parsePart(parts[0]);
    const g = parsePart(parts[1]);
    const b = parsePart(parts[2]);
    if (r === null || g === null || b === null) return null;
    return { r, g, b };
  }
  return null;
};

const trackOscColors = (chunk: string) => {
  const data = pendingOsc + chunk;
  pendingOsc = "";
  const oscPattern = /\x1b\](10|11|12);([\s\S]*?)(\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  let lastMatchEnd = 0;
  while ((match = oscPattern.exec(data))) {
    lastMatchEnd = oscPattern.lastIndex;
    const id = Number(match[1]);
    const payload = match[2].trim();
    if (payload === "?") {
      continue;
    }
    const color = parseOscColor(payload);
    if (id === 10) {
      defaultFg = color;
    } else if (id === 11) {
      defaultBg = color;
    } else if (id === 12) {
      defaultCursor = color;
    }
  }
  const tailIndex = data.lastIndexOf("\x1b]");
  if (tailIndex !== -1 && tailIndex >= lastMatchEnd) {
    const tail = data.slice(tailIndex);
    if (!tail.includes("\x07") && !tail.includes("\x1b\\")) {
      pendingOsc = tail;
    }
  }
  if (lastMatchEnd > 0) {
    scheduleRender();
  }
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const getMaxViewY = () => {
  const buffer = terminal.buffer.active;
  const max = buffer.length - localMetrics.viewportRows;
  return Math.max(0, max);
};

const clampView = () => {
  const maxX = Math.max(0, remoteCols - localMetrics.viewportCols);
  const maxY = getMaxViewY();
  viewX = clamp(viewX, 0, maxX);
  viewY = clamp(viewY, 0, maxY);
};

const isViewportAtBottom = () => viewY >= getMaxViewY();

// Anchor the scrolled viewport to a buffer line marker. viewY is an absolute
// buffer index, so once scrollback is full every trimmed line drags a fixed
// viewY toward the bottom while output streams. The marker tracks the line
// across trims/reflows so the view stays put.
type ScrollAnchor = NonNullable<ReturnType<typeof terminal.registerMarker>>;
let scrollAnchor: ScrollAnchor | null = null;

const releaseScrollAnchor = () => {
  if (scrollAnchor) {
    if (!scrollAnchor.isDisposed) scrollAnchor.dispose();
    scrollAnchor = null;
  }
};

const updateScrollAnchor = () => {
  releaseScrollAnchor();
  if (followOutput) return;
  const buffer = terminal.buffer.active;
  const cursorAbs = buffer.baseY + buffer.cursorY;
  scrollAnchor = terminal.registerMarker(viewY - cursorAbs) ?? null;
};

const restoreViewFromAnchor = () => {
  if (!followOutput && scrollAnchor) {
    if (scrollAnchor.line >= 0) {
      viewY = scrollAnchor.line;
    } else {
      // The anchored line was trimmed out of scrollback — hold at the top.
      viewY = 0;
    }
  }
  clampView();
  if (!followOutput && (!scrollAnchor || scrollAnchor.isDisposed)) {
    updateScrollAnchor();
  }
};

const updateFollowOutputFromViewport = () => {
  followOutput = isViewportAtBottom();
  updateScrollAnchor();
};

const followCursorWithMargin = () => {
  const buffer = terminal.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;
  const margin = Math.min(scrollOff, Math.floor(localMetrics.viewportRows / 2));
  if (cursorRow < viewY + margin) {
    viewY = Math.max(0, cursorRow - margin);
  } else if (cursorRow >= viewY + localMetrics.viewportRows - margin) {
    viewY = cursorRow - localMetrics.viewportRows + margin + 1;
  }
  clampView();
};

const ensureCursorVisible = (_force: boolean) => {
  const buffer = terminal.buffer.active;
  const cursorX = buffer.cursorX;
  const cursorRow = buffer.baseY + buffer.cursorY;
  let nextX = viewX;
  let nextY = viewY;
  const maxY = getMaxViewY();

  if (cursorX < viewX) {
    nextX = cursorX;
  } else if (cursorX >= viewX + localMetrics.viewportCols) {
    nextX = cursorX - localMetrics.viewportCols + 1;
  }

  if (cursorRow < viewY) {
    nextY = cursorRow;
  } else if (cursorRow >= viewY + localMetrics.viewportRows) {
    nextY = cursorRow - localMetrics.viewportRows + 1;
  }

  viewX = nextX;
  viewY = clamp(nextY, 0, maxY);
  followOutput = true;
  releaseScrollAnchor();
};

// Coalesce a burst of output chunks into one repaint per frame (~60fps) instead
// of one per chunk. Imperceptible locally; meaningfully less work and wire
// traffic over a slow remote link.
const RENDER_THROTTLE_MS = 16;
const scheduleRender = () => {
  if (renderScheduled) return;
  renderScheduled = true;
  setTimeout(() => {
    renderScheduled = false;
    render();
  }, RENDER_THROTTLE_MS);
};

// ── Scrollback search ──

// "active" = the current match (bright), "match" = any other match (dim).
const getSearchMatchKind = (row: number, col: number): "active" | "match" | null => {
  if (searchMatches.length === 0) return null;
  const startCols = searchMatchesByRow.get(row);
  if (!startCols) return null;
  for (const start of startCols) {
    if (col >= start && col < start + searchQuery.length) {
      const active = searchMatches[searchIndex];
      return active && active.row === row && active.col === start ? "active" : "match";
    }
  }
  return null;
};

const computeSearchMatches = () => {
  searchMatches = [];
  searchMatchesByRow = new Map();
  searchIndex = -1;
  if (!searchQuery) return;
  const buffer = terminal.buffer.active;
  const needle = searchQuery.toLowerCase();
  for (let row = 0; row < buffer.length && searchMatches.length < SEARCH_MAX_MATCHES; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true).toLowerCase();
    let from = 0;
    while (searchMatches.length < SEARCH_MAX_MATCHES) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      searchMatches.push({ row, col: idx });
      const rowCols = searchMatchesByRow.get(row);
      if (rowCols) rowCols.push(idx);
      else searchMatchesByRow.set(row, [idx]);
      from = idx + needle.length;
    }
  }
};

const jumpToMatch = (index: number) => {
  if (searchMatches.length === 0) { searchIndex = -1; return; }
  searchIndex = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
  const m = searchMatches[searchIndex];
  followOutput = false;
  releaseScrollAnchor();
  viewY = m.row - Math.floor(localMetrics.viewportRows / 2);
  clampView();
  scheduleRender();
};

const enterSearch = () => {
  searchMode = true;
  searchQuery = "";
  searchMatches = [];
  searchMatchesByRow = new Map();
  searchIndex = -1;
  scheduleRender();
};

const exitSearch = () => {
  searchMode = false;
  searchMatches = [];
  searchMatchesByRow = new Map();
  searchIndex = -1;
  // Keep the scrollback position (less/tmux convention) but anchor it so output
  // doesn't drag it, and point the way back to the live view.
  if (!followOutput) {
    updateScrollAnchor();
    pushNotice(`${keyLabelShort}+0 to return to live output`);
  }
  scheduleRender();
};

// Handle a stdin chunk while in search mode. Consumes the input (never forwarded
// to the remote): Esc exits, Enter/↓ jumps to the next match, ↑ to the previous,
// Backspace edits, and printable characters extend the query (which live-jumps
// to the first match).
const handleSearchInput = (input: string) => {
  if (input === "\x1b") { exitSearch(); return; }
  if (input === "\x1b[A" || input === "\x1bOA") {
    if (searchMatches.length > 0) jumpToMatch(searchIndex - 1);
    return;
  }
  if (input === "\x1b[B" || input === "\x1bOB") {
    if (searchMatches.length > 0) jumpToMatch(searchIndex + 1);
    return;
  }
  // Ignore other escape sequences (alt-combos etc.) so their bytes don't pollute the query.
  if (input.startsWith("\x1b") && input.length > 1) { return; }
  if (input === "\r" || input === "\n") {
    if (searchMatches.length > 0) jumpToMatch(searchIndex + 1);
    else scheduleRender();
    return;
  }
  if (input === "\x7f" || input === "\b") {
    searchQuery = searchQuery.slice(0, -1);
    computeSearchMatches();
    if (searchMatches.length > 0) jumpToMatch(0);
    else scheduleRender();
    return;
  }
  // Append only printable characters; ignore control/escape sequences (arrows etc.).
  const printable = Array.from(input).filter((ch) => ch >= " " && ch !== "\x7f").join("");
  if (!printable) { scheduleRender(); return; }
  searchQuery += printable;
  computeSearchMatches();
  if (searchMatches.length > 0) jumpToMatch(0);
  else scheduleRender();
};

const setCursorVisible = (visible: boolean) => {
  cursorVisible = visible;
  scheduleRender();
};

const applyPrivateModes = (params: readonly number[], enabled: boolean) => {
  for (const param of params) {
    if (param === REMOTE_APPLICATION_CURSOR_MODE_PARAM) {
      remoteApplicationCursor = enabled;
      continue;
    }
    if (param === 25) {
      setCursorVisible(enabled);
      continue;
    }
    if (REMOTE_MOUSE_MODE_PARAMS.has(param)) {
      if (enabled) {
        remoteMouseModes.add(param);
      } else {
        remoteMouseModes.delete(param);
      }
      continue;
    }
    if (REMOTE_ALT_SCREEN_PARAMS.has(param)) {
      remoteAlternateScreen = enabled;
    }
  }
};

const trackPrivateModes = (chunk: string) => {
  if (!chunk) return;
  const combined = pendingPrivateMode + chunk;
  const modeRegex = /\x1b\[\?([0-9;]*)([hl])/g;
  let match: RegExpExecArray | null;
  let lastCompleteIndex = 0;
  while ((match = modeRegex.exec(combined)) !== null) {
    const params = match[1]
      .split(";")
      .filter(Boolean)
      .map((param) => Number.parseInt(param, 10))
      .filter((param) => Number.isFinite(param));
    applyPrivateModes(params, match[2] === "h");
    lastCompleteIndex = modeRegex.lastIndex;
  }

  const trailingStart = combined.lastIndexOf("\x1b[?");
  if (trailingStart !== -1 && trailingStart >= lastCompleteIndex) {
    const trailing = combined.slice(trailingStart);
    if (!/[hl]/.test(trailing)) {
      pendingPrivateMode = trailing.slice(-PRIVATE_MODE_TAIL_CHARS);
      return;
    }
  }

  pendingPrivateMode = combined.slice(-PRIVATE_MODE_TAIL_CHARS);
};

terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
  applyPrivateModes(params, false);
  return false;
});

terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
  applyPrivateModes(params, true);
  return false;
});

const pushNotice = (message: string, kind: NoticeKind = "info") => {
  notice = { message, kind, expiresAt: Date.now() + NOTICE_MS };
  if (noticeTimer) {
    clearTimeout(noticeTimer);
  }
  noticeTimer = setTimeout(() => {
    notice = null;
    scheduleRender();
  }, NOTICE_MS);
  scheduleRender();
};

const sendMessage = (message: ClientMessage) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
};

const sendOscResponse = (id: number, color: RgbColor | null) => {
  if (!color) return;
  // Don't answer color queries that surface while replaying snapshot history.
  if (replayingSnapshot) return;
  const toHex4 = (value: number) => Math.round(value * 257).toString(16).padStart(4, "0");
  const payload = `\x1b]${id};rgb:${toHex4(color.r)}/${toHex4(color.g)}/${toHex4(color.b)}\x1b\\`;
  sendMessage({ type: "input", data: payload });
};

terminal.parser.registerOscHandler(10, (data) => {
  if (data.trim() === "?") {
    sendOscResponse(10, defaultFg);
    return true;
  }
  defaultFg = parseOscColor(data);
  scheduleRender();
  return true;
});

terminal.parser.registerOscHandler(11, (data) => {
  if (data.trim() === "?") {
    sendOscResponse(11, defaultBg);
    return true;
  }
  defaultBg = parseOscColor(data);
  scheduleRender();
  return true;
});

terminal.parser.registerOscHandler(12, (data) => {
  if (data.trim() === "?") {
    sendOscResponse(12, defaultCursor);
    return true;
  }
  defaultCursor = parseOscColor(data);
  return true;
});

const sendTyping = (active: boolean) => {
  sendMessage({ type: "typing", active });
};

const handleTyping = () => {
  sendTyping(true);
  if (typingTimeout) {
    clearTimeout(typingTimeout);
  }
  typingTimeout = setTimeout(() => {
    sendTyping(false);
  }, TYPING_IDLE_MS);
};

const getUrl = () => {
  const separator = config.server.includes("?") ? "&" : "?";
  return `${config.server}${separator}room=${encodeURIComponent(config.room)}&name=${encodeURIComponent(
    config.name
  )}&cols=${Math.max(2, localMetrics.viewportCols)}&rows=${Math.max(2, localMetrics.viewportRows)}`;
};

const isPidAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readHopDaemonRuntime = () => {
  if (!shouldTrackHopDaemon) {
    return { running: false, shareUrl: "" };
  }
  if (!fs.existsSync(hopTunnelStateFile)) {
    return { running: false, shareUrl: "" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(hopTunnelStateFile, "utf8"));
    const pid = Number(parsed?.pid);
    if (!isPidAlive(pid)) {
      return { running: false, shareUrl: "" };
    }
    const shareUrlRaw = typeof parsed?.url === "string" ? parsed.url.trim() : "";
    return {
      running: true,
      shareUrl: shareUrlRaw ? normalizeUrlOrigin(shareUrlRaw) : ""
    };
  } catch {
    return { running: false, shareUrl: "" };
  }
};

const refreshHopDaemonRuntime = () => {
  if (!shouldTrackHopDaemon) return;
  const next = readHopDaemonRuntime();
  if (next.running !== hopDaemonRunning || next.shareUrl !== hopDaemonShareUrl) {
    hopDaemonRunning = next.running;
    hopDaemonShareUrl = next.shareUrl;
    scheduleRender();
  }
};

const startDaemonPolling = () => {
  if (!shouldTrackHopDaemon || daemonPollTimer) return;
  refreshHopDaemonRuntime();
  daemonPollTimer = setInterval(() => {
    refreshHopDaemonRuntime();
  }, HOP_DAEMON_POLL_MS);
  daemonPollTimer.unref?.();
};

const stopDaemonPolling = () => {
  if (!daemonPollTimer) return;
  clearInterval(daemonPollTimer);
  daemonPollTimer = null;
};

const buildShareUrl = () => {
  if (shouldTrackHopDaemon && hopDaemonShareUrl) {
    return hopDaemonShareUrl;
  }
  return defaultShareUrl;
};

const buildHopDaemonLabel = () => {
  if (!shouldTrackHopDaemon) return "";
  if (!hopDaemonRunning) return "hop offline";
  if (!hopDaemonShareUrl) return "hop starting";
  return "hop online";
};

const setStatus = (nextStatus: typeof status) => {
  status = nextStatus;
  scheduleRender();
};

const applyRemoteSize = (cols: number, rows: number) => {
  localMetrics = getLocalMetrics();
  const nextCols = Math.max(2, Math.min(cols, 500));
  const nextRows = Math.max(1, Math.min(rows, 200));
  if (remoteCols === nextCols && remoteRows === nextRows) return;
  remoteCols = nextCols;
  remoteRows = nextRows;
  terminal.resize(remoteCols, remoteRows);
  if (followOutput) {
    followCursorWithMargin();
  } else {
    // Markers survive reflow, so the anchor re-locates the viewed content.
    restoreViewFromAnchor();
  }
  scheduleRender();
};

const applySyncSize = () => {
  if (!syncSize) return;
  localMetrics = getLocalMetrics();
  const cols = localMetrics.viewportCols;
  const rows = localMetrics.viewportRows;
  const needsResize = cols !== remoteCols || rows !== remoteRows;
  applyRemoteSize(cols, rows);
  if (needsResize) {
    // Protocol rejects resize below 2x2 — clamp so tiny terminals don't send
    // messages the server refuses.
    sendMessage({ type: "resize", cols: Math.max(2, cols), rows: Math.max(2, rows) });
  }
};

const enableMouseCapture = () => {
  if (!process.stdout.isTTY) return;
  // 1000=normal tracking, 1002=button-event tracking (motion while pressed), 1006=SGR encoding
  process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
};

const disableMouseCapture = () => {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
};

const setMouseCapture = (enabled: boolean) => {
  mouseCapture = enabled;
  if (uiInitialized) {
    if (mouseCapture) {
      enableMouseCapture();
    } else {
      disableMouseCapture();
    }
  }
  scheduleRender();
};

const initUi = () => {
  if (uiInitialized || !process.stdout.isTTY) return;
  uiInitialized = true;
  // Enable alternate screen (mouse capture is optional)
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  if (mouseCapture) {
    enableMouseCapture();
  } else {
    disableMouseCapture();
  }
  lastRenderCols = 0;
  lastRenderRows = 0;
};

const restoreUi = () => {
  if (!uiInitialized || !process.stdout.isTTY) return;
  disableMouseCapture();
  process.stdout.write("\x1b[?25h\x1b[?1049l\x1b[0m");
  uiInitialized = false;
};

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

// Display width of a single code point in terminal cells. Wide (CJK/emoji) = 2,
// combining marks / zero-width / control = 0, everything else = 1. Without this
// the status bar measures user data (session name, cwd) in UTF-16 code units, so
// a CJK path over-pads past the terminal width and wraps/garbles the bottom row.
const isWideCodePoint = (cp: number): boolean =>
  cp >= 0x1100 && (
    cp <= 0x115f ||                       // Hangul Jamo
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||     // CJK Radicals .. Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) ||     // Hiragana .. CJK compat symbols
    (cp >= 0x3400 && cp <= 0x4dbf) ||     // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) ||     // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||     // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||     // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||     // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) ||     // Vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) ||     // CJK Compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) ||     // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||   // emoji & symbols
    (cp >= 0x20000 && cp <= 0x3fffd)      // CJK Ext B and beyond
  );

const isZeroWidthCodePoint = (cp: number): boolean =>
  cp === 0x200d ||                        // zero-width joiner
  (cp >= 0x0300 && cp <= 0x036f) ||       // combining diacritical marks
  (cp >= 0x1ab0 && cp <= 0x1aff) ||
  (cp >= 0x1dc0 && cp <= 0x1dff) ||
  (cp >= 0x20d0 && cp <= 0x20ff) ||       // combining marks for symbols
  (cp >= 0xfe00 && cp <= 0xfe0f) ||       // variation selectors
  (cp >= 0xfe20 && cp <= 0xfe2f);         // combining half marks

const charDisplayWidth = (cp: number): number => {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0; // C0/C1 control
  if (isZeroWidthCodePoint(cp)) return 0;
  return isWideCodePoint(cp) ? 2 : 1;
};

const stringWidth = (text: string): number => {
  let width = 0;
  for (const ch of text) {
    width += charDisplayWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
};

const visibleLength = (text: string) => stringWidth(text.replace(ANSI_REGEX, ""));

const truncateAnsi = (text: string, cols: number) => {
  if (cols <= 0) return "";
  let out = "";
  let width = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i + 2);
      if (end === -1) {
        break;
      }
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const cw = charDisplayWidth(cp);
    if (width + cw > cols) break;
    out += ch;
    width += cw;
    i += ch.length; // advance past surrogate pairs
  }
  return out;
};

const padOrTrim = (text: string, cols: number) => {
  const len = visibleLength(text);
  if (len > cols) return truncateAnsi(text, cols);
  if (len < cols) return text + " ".repeat(cols - len);
  return text;
};

type BarSegment = {
  text: string;
  secondary?: boolean;
  dropPriority?: number;
};

const joinBarSegments = (segments: BarSegment[]) => segments.map((segment) => segment.text).join(" · ");

const fitBarSegments = (left: string, segments: BarSegment[], cols: number) => {
  const active = segments.filter((segment) => segment.text);
  while (active.length > 0) {
    const right = joinBarSegments(active);
    const rightLen = visibleLength(right);
    const availableLeft = right ? Math.max(0, cols - rightLen - 1) : cols;
    if (rightLen < cols && visibleLength(left) <= availableLeft) {
      break;
    }

    let optionalIndex = -1;
    let optionalPriority = Number.POSITIVE_INFINITY;
    for (let i = 0; i < active.length; i += 1) {
      const priority = active[i].dropPriority;
      if (priority === undefined) continue;
      if (priority < optionalPriority) {
        optionalPriority = priority;
        optionalIndex = i;
      }
    }
    if (optionalIndex === -1) {
      break;
    }
    active.splice(optionalIndex, 1);
  }
  return active;
};

const composeBar = (left: string, right: string, cols: number) => {
  if (!right) {
    return padOrTrim(left, cols);
  }
  const rightLen = visibleLength(right);
  if (rightLen >= cols) {
    return padOrTrim(truncateAnsi(right, cols), cols);
  }
  const availableLeft = Math.max(0, cols - rightLen - 1);
  const trimmedLeft = visibleLength(left) > availableLeft ? truncateAnsi(left, availableLeft) : left;
  const gap = Math.max(1, cols - visibleLength(trimmedLeft) - rightLen);
  return padOrTrim(trimmedLeft + " ".repeat(gap) + right, cols);
};

const formatCwd = (cwdPath: string | null) => {
  if (!cwdPath) return "";
  const homeDir = os.homedir();
  if (cwdPath === homeDir) return "~";
  if (cwdPath.startsWith(`${homeDir}${path.sep}`)) {
    return `~${cwdPath.slice(homeDir.length)}`;
  }
  return cwdPath;
};

const renderBar = (text: string, variant: "status" | "hint") =>
  `${variant === "status" ? BAR.statusBg : BAR.hintBg}${BAR.fg}${text}\x1b[0m`;

// Status line decoration: semantic state dot, session chip, dim separators and
// secondary tokens. Token replacement is best-effort — if composeBar truncated
// a token away, the replace simply doesn't match.
const decorateTop = (text: string, secondaryTokens: string[], chipToken: string, dotAnsi: string) => {
  let output = text;
  output = output.replace("●", `${dotAnsi}●${BAR.resetFg}`);
  if (chipToken) {
    output = output.replace(chipToken, `${BAR.chip}${chipToken}\x1b[22m${BAR.statusBg}${BAR.fg}`);
  }
  output = output.replace(/ · /g, ` ${BAR.dim}·${BAR.resetFg} `);
  for (const token of secondaryTokens) {
    if (!token) continue;
    output = output.replace(token, `${BAR.dim}${token}${BAR.resetFg}`);
  }
  return output;
};

const decorateBottom = (text: string, secondaryTokens: string[]) => {
  let output = text;
  output = output.replace(/ · /g, ` ${BAR.dim}·${BAR.resetFg} `);
  for (const token of secondaryTokens) {
    if (!token) continue;
    output = output.replace(token, `${BAR.dim}${token}${BAR.resetFg}`);
  }
  return output;
};

type CellStyle = {
  key: string;
  ansi: string;
};

const styleKeyForCell = (
  cell: ReturnType<typeof terminal.buffer.active.getNullCell>,
  forceInverse: boolean
): CellStyle => {
  const bold = !!cell.isBold();
  const dim = !!cell.isDim();
  const italic = !!cell.isItalic();
  const underline = !!cell.isUnderline();
  const blink = !!cell.isBlink();
  const inverse = forceInverse || !!cell.isInverse();
  const invisible = !!cell.isInvisible();
  const strike = !!cell.isStrikethrough();
  const overline = !!cell.isOverline();

  let fgMode = cell.isFgRGB() ? "rgb" : cell.isFgPalette() ? "palette" : "default";
  let bgMode = cell.isBgRGB() ? "rgb" : cell.isBgPalette() ? "palette" : "default";
  let fg = cell.getFgColor();
  let bg = cell.getBgColor();
  const inverseUsesDefault = inverse && fgMode === "default" && bgMode === "default";
  if (inverseUsesDefault && (defaultFg || defaultBg)) {
    fgMode = defaultBg ? "rgb" : "default";
    bgMode = defaultFg ? "rgb" : "default";
    fg = defaultBg ? (defaultBg.r << 16) + (defaultBg.g << 8) + defaultBg.b : -1;
    bg = defaultFg ? (defaultFg.r << 16) + (defaultFg.g << 8) + defaultFg.b : -1;
  } else if (inverse && !inverseUsesDefault) {
    [fgMode, bgMode] = [bgMode, fgMode];
    [fg, bg] = [bg, fg];
  }

  const key = [
    bold ? 1 : 0,
    dim ? 1 : 0,
    italic ? 1 : 0,
    underline ? 1 : 0,
    blink ? 1 : 0,
    inverse ? 1 : 0,
    invisible ? 1 : 0,
    strike ? 1 : 0,
    overline ? 1 : 0,
    fgMode,
    fg,
    bgMode,
    bg
  ].join(":");

  const codes: number[] = [0];
  if (bold) codes.push(1);
  if (dim) codes.push(2);
  if (italic) codes.push(3);
  if (underline) codes.push(4);
  if (blink) codes.push(5);
  if (invisible) codes.push(8);
  if (strike) codes.push(9);
  if (overline) codes.push(53);
  if (inverseUsesDefault) codes.push(7);

  const pushPalette = (value: number, base: number, brightBase: number, isFg: boolean) => {
    if (value < 8) {
      codes.push(base + value);
      return;
    }
    if (value < 16) {
      codes.push(brightBase + (value - 8));
      return;
    }
    codes.push(isFg ? 38 : 48, 5, value);
  };

  if (fgMode === "default") {
    if (defaultFg) {
      codes.push(38, 2, defaultFg.r, defaultFg.g, defaultFg.b);
    } else {
      codes.push(39);
    }
  } else if (fgMode === "palette") {
    pushPalette(fg, 30, 90, true);
  } else {
    const r = (fg >> 16) & 0xff;
    const g = (fg >> 8) & 0xff;
    const b = fg & 0xff;
    codes.push(38, 2, r, g, b);
  }

  if (bgMode === "default") {
    if (defaultBg) {
      codes.push(48, 2, defaultBg.r, defaultBg.g, defaultBg.b);
    } else {
      codes.push(49);
    }
  } else if (bgMode === "palette") {
    pushPalette(bg, 40, 100, false);
  } else {
    const r = (bg >> 16) & 0xff;
    const g = (bg >> 8) & 0xff;
    const b = bg & 0xff;
    codes.push(48, 2, r, g, b);
  }

  return {
    key,
    ansi: `\x1b[${codes.join(";")}m`
  };
};

const renderLine = (lineIndex: number, cursorRow: number, cursorCol: number) => {
  const buffer = terminal.buffer.active;
  const base = viewY;
  const isCursorLine = base + lineIndex === cursorRow;
  const line = buffer.getLine(base + lineIndex);
  const blankLine = " ".repeat(localMetrics.viewportCols);
  if (!line) {
    return blankLine;
  }

  const cell = buffer.getNullCell();
  let output = "";
  let currentKey = "default";

  for (let col = 0; col < localMetrics.viewportCols; col++) {
    const remoteCol = viewX + col;
    if (remoteCol >= remoteCols) {
      if (currentKey !== "default") {
        output += "\x1b[0m";
        currentKey = "default";
      }
      output += " ";
      continue;
    }
    const cellData = line.getCell(remoteCol, cell);
    const bufferRow = base + lineIndex;
    const isCursorCell = isCursorLine && remoteCol === cursorCol;
    const isSelected = isCellSelected(bufferRow, remoteCol);
    if (!cellData) {
      if (isSelected) {
        output += "\x1b[7m \x1b[0m";
        currentKey = "default";
      } else {
        if (currentKey !== "default") {
          output += "\x1b[0m";
          currentKey = "default";
        }
        output += " ";
      }
      continue;
    }

    let width = cellData.getWidth();
    let chars = cellData.getChars();
    if (!chars) {
      chars = " ";
    }

    if (width === 0 && !isCursorCell && !isSelected) {
      if (currentKey !== "default") {
        output += "\x1b[0m";
        currentKey = "default";
      }
      output += " ";
      continue;
    }
    if (width === 0 && (isCursorCell || isSelected)) {
      width = 1;
      chars = " ";
    }

    if (width === 2 && col === localMetrics.viewportCols - 1) {
      if (currentKey !== "default") {
        output += "\x1b[0m";
        currentKey = "default";
      }
      output += " ";
      continue;
    }

    // Search hits: the current match gets a bright yellow highlight, all other
    // matches a dim grey one (cursor still wins so it stays visible on a match).
    const searchKind = !isCursorCell ? getSearchMatchKind(bufferRow, remoteCol) : null;
    const style = searchKind
      ? (searchKind === "active"
        ? { key: "search-active", ansi: "\x1b[0m\x1b[43m\x1b[30m" }
        : { key: "search-match", ansi: "\x1b[0m\x1b[48;5;240m\x1b[37m" })
      : styleKeyForCell(
        cellData as ReturnType<typeof terminal.buffer.active.getNullCell>,
        isCursorCell || isSelected
      );
    if (style.key !== currentKey) {
      output += style.ansi;
      currentKey = style.key;
    }

    output += chars;
    if (width === 2) {
      col += 1;
    }
  }

  if (currentKey !== "default") {
    output += "\x1b[0m";
  }
  output += "\x1b[K";
  return output;
};

const render = () => {
  if (!process.stdout.isTTY) return;
  initUi();

  localMetrics = getLocalMetrics();
  clampView();

  let forceFull = false;
  if (localMetrics.cols !== lastRenderCols || localMetrics.rows !== lastRenderRows) {
    process.stdout.write("\x1b[2J");
    lastRenderCols = localMetrics.cols;
    lastRenderRows = localMetrics.rows;
    lastRenderedLines = []; // dimensions changed — repaint everything
    forceFull = true;
  }

  const others = presence.filter((client) => client.id !== clientId);
  const controllerName = controllerId
    ? (controllerId === clientId ? "you" : (presence.find((c) => c.id === controllerId)?.name || "peer"))
    : null;
  const statusLabel = status === "connected" ? "" : status;
  const shareUrl = buildShareUrl();
  const hopDaemonLabel = buildHopDaemonLabel();

  const cwdLabel = formatCwd(liveCwd);
  // Session name renders as an accent chip at the left edge; the semantic state
  // dot sits alone in the right corner (clear of the solid chip): green
  // connected · amber connecting/reconnecting · red disconnected · accent
  // (purple) when control is locked.
  const dotAnsi =
    status === "connected"
      ? (!collabMode ? BAR.accent : BAR.ok)
      : status === "disconnected"
        ? BAR.err
        : BAR.warn;
  const chipToken = ` ${sessionLabel} `;
  // Chip is flush with the left edge, tab-style (its padding is inside the pill).
  const bottomLeft = `${chipToken}${cwdLabel ? ` ${cwdLabel}` : ""}`;
  // Only surface the non-default state (GUI convention): autofit is on by default.
  const autofitLabel = syncSize ? "" : "manual";
  // Viewport detached from live output: show where we are in the scrollback and
  // how to get back. No dropPriority — it must survive narrow widths.
  const bufferLineCount = terminal.buffer.active.length;
  const scrollLabel = !followOutput
    ? `scroll ${Math.min(viewY + localMetrics.viewportRows, bufferLineCount)}/${bufferLineCount} · ${keyLabelShort}+0 live`
    : "";
  // Show peer names (with a * typing marker) instead of just a count, and a
  // control-lock indicator when collaborative typing is off — parity with web.
  const peerNames = others.map((c) => (c.typing ? `${c.name}*` : c.name)).join(", ");
  const peerLabel = others.length ? `peers: ${peerNames}` : "";
  const controlLabel = (!collabMode && controllerName) ? `locked: ${controllerName}` : "";
  const candidateSegments: Array<BarSegment | null> = [
    scrollLabel ? { text: scrollLabel } : null,
    statusLabel ? { text: statusLabel } : null,
    hopDaemonLabel ? { text: hopDaemonLabel, secondary: true, dropPriority: 1 } : null,
    !statusLabel && shareUrl ? { text: shareUrl, secondary: true, dropPriority: 0 } : null,
    autofitLabel ? { text: autofitLabel, secondary: true, dropPriority: 3 } : null,
    peerLabel ? { text: peerLabel, secondary: true, dropPriority: 4 } : null,
    controlLabel ? { text: controlLabel, secondary: true, dropPriority: 6 } : null,
    { text: "● " } // state dot, rightmost; no dropPriority — always visible
  ];
  const rightSegments = fitBarSegments(
    bottomLeft,
    candidateSegments.filter((segment): segment is BarSegment => !!segment),
    localMetrics.cols
  );
  const rightPriority = rightSegments
    .filter((segment) => segment.secondary)
    .map((segment) => segment.text);
  const rightPrimary = decorateBottom(
    joinBarSegments(rightSegments),
    rightPriority
  );
  const topPriority = rightSegments
    .filter((segment) => segment.text === hopDaemonLabel || segment.text === shareUrl)
    .map((segment) => segment.text)
    .concat(cwdLabel ? [cwdLabel] : []); // cwd is secondary next to the chip
  const bottomPrimary = renderBar(
    decorateTop(composeBar(bottomLeft, rightPrimary, localMetrics.cols), topPriority, chipToken, dotAnsi),
    "status"
  );

  // Notices render as toasts: ✓ confirmations, ! warnings, accent edge for info.
  const noticeText = notice && notice.expiresAt > Date.now()
    ? (notice.kind === "ok"
        ? ` ${BAR.ok}✓ ${BAR.resetFg}${notice.message} `
        : notice.kind === "warn"
          ? ` ${BAR.warn}${BAR.bold}! ${BAR.resetFg}${notice.message} `
          : ` ${BAR.accent}▎${BAR.resetFg}${notice.message} `)
    : "";
  // Keycap-style hints: keys at full strength, labels dim. Exit hints
  // (detach/kill) lead so right-edge truncation never drops the way out.
  const kCtrl = (k: string) => (isMac ? `⌃${k}` : `Ctrl+${k}`);
  const kOpt = (k: string) => (isMac ? `⌥${k}` : `Alt+${k}`);
  const hintPairs: Array<[string, string]> = [
    [kCtrl("G"), "detach"],
    [kCtrl("Q"), "kill"],
    [kOpt("←→↑↓"), "pan"],
    [kOpt("0"), "live"],
    [kOpt("A"), "autofit"],
    [kOpt("B"), `status ${showStatusBar ? "on" : "off"}`],
    [kOpt("M"), `mouse ${mouseCapture ? "on" : "off"}`],
    [kOpt("F"), "find"],
    [kOpt("C"), "control"],
    [kOpt("T"), "hints"],
    [kOpt("\\"), "literal"]
  ];
  const controls = ` ${hintPairs.map(([key, label]) => `${BAR.fg}${key} ${BAR.dim}${label}`).join(" · ")}`;
  const reconnecting = !connected && reconnectAttempt > 0;
  let hintInner: string;
  if (searchMode) {
    const count = searchQuery
      ? (searchMatches.length > 0
          ? `${searchIndex + 1}/${searchMatches.length}`
          : `${BAR.warn}no matches${BAR.dim}`)
      : "";
    hintInner = `${BAR.accent} /${searchQuery}${BAR.resetFg}${BAR.dim}  ${count} · Enter/↓ next · ↑ prev · Esc close${BAR.resetFg}`;
  } else if (reconnecting) {
    const secsLeft = nextReconnectAt > Date.now() ? Math.ceil((nextReconnectAt - Date.now()) / 1000) : 0;
    const detail = secsLeft > 0 ? `retry in ${secsLeft}s` : "connecting…";
    const reason = lastWsError ? ` (${lastWsError})` : "";
    hintInner = `${BAR.reconnect} ⟳ Reconnecting${reason} — ${detail} · attempt ${reconnectAttempt} · ${kCtrl("G")} detach ${BAR.resetFg}`;
  } else {
    hintInner = noticeText || controls;
  }
  const hintLine = renderBar(
    composeBar(hintInner, "", localMetrics.cols),
    "hint"
  );

  const buffer = terminal.buffer.active;
  const showCursor = connected && cursorVisible;
  const cursorRow = showCursor ? buffer.baseY + buffer.cursorY : -1;
  const cursorCol = showCursor ? buffer.cursorX : -1;

  const lines: string[] = [];
  for (let row = 0; row < localMetrics.viewportRows; row++) {
    lines.push(renderLine(row, cursorRow, cursorCol));
  }

  if (localMetrics.showBottomBar) {
    lines.push(bottomPrimary);
  }
  if (localMetrics.showHintBar) {
    lines.push(hintLine);
  }

  // Dirty-line diff: position to and rewrite only the rows that changed since
  // the last frame. Each rendered line already pads/clears to the row width
  // (renderLine ends with \x1b[K; bars are width-padded), so a positioned write
  // fully replaces the old content. Typing one character now repaints ~1-2 rows
  // instead of the whole screen.
  let output = "\x1b[?25l";
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (forceFull || lines[i] !== lastRenderedLines[i]) {
      output += `\x1b[${i + 1};1H` + lines[i];
      changed += 1;
    }
  }
  lastRenderedLines = lines;
  if (changed > 0) {
    process.stdout.write(output);
  }
};

const scheduleReconnect = () => {
  if (!shouldReconnect) return;

  // Never managed to connect at all: retrying forever just hides the problem.
  if (!everConnected && reconnectAttempt >= MAX_NEVER_CONNECTED_ATTEMPTS) {
    shouldReconnect = false;
    exitMessage = `Could not connect to ${config.server} after ${reconnectAttempt + 1} attempts${
      lastWsError ? ` (${lastWsError})` : ""
    }. Is the server running?`;
    exitCode = 1;
    cleanupAndExit();
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
  reconnectAttempt += 1;
  nextReconnectAt = Date.now() + delay;
  // Keep a live countdown on screen for the whole backoff (up to 30s), not just
  // the 3.5s notice flash, so the frozen viewport is obviously not live.
  if (!reconnectTicker) {
    reconnectTicker = setInterval(() => scheduleRender(), 1000);
    reconnectTicker.unref?.();
  }
  scheduleRender();

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (shouldReconnect) {
      connect();
    }
  }, delay);
};

const clearReconnectTicker = () => {
  if (reconnectTicker) {
    clearInterval(reconnectTicker);
    reconnectTicker = null;
  }
  nextReconnectAt = 0;
};

const connect = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const url = getUrl();
  ws = new WebSocket(url);
  setStatus("connecting");

  ws.on("open", () => {
    connected = true;
    everConnected = true;
    lastWsError = null;
    remoteMouseModes.clear();
    remoteAlternateScreen = false;
    remoteApplicationCursor = false;
    pendingPrivateMode = "";
    pendingOsc = "";
    replayingSnapshot = false;
    shortcutsEnabledAt = Date.now() + 400;
    reconnectAttempt = 0;
    clearReconnectTicker();
    setStatus("connected");
    initUi();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    // Auto theme: ask the local terminal for its background color (OSC 11).
    // The reply arrives on stdin and is captured (and stripped) there.
    if (themePref === "auto" && process.stdout.isTTY && !themeQueryAsked) {
      themeQueryAsked = true;
      themeQueryDeadline = Date.now() + 2000;
      process.stdout.write("\x1b]11;?\x1b\\");
    }
    if (syncSize) {
      applySyncSize();
    }
    scheduleRender();
  });

  ws.on("message", (data) => {
    const message = safeParseServerMessage(data.toString());
    if (!message) return;

    switch (message.type) {
      case "hello":
        clientId = message.clientId;
        collabMode = message.collabMode;
        controllerId = message.controllerId;
        if (!attachNoticeShown) {
          attachNoticeShown = true;
          if (message.created === true) {
            // Surface accidental room creation (e.g. a typo'd room name).
            pushNotice(`Created new session '${sessionLabel}' — persists until killed (Ctrl+Q twice)`);
          } else if (message.created === false) {
            // Wait for the presence roster (sent right after hello) for the count.
            pendingAttachNotice = true;
          } else {
            // Older server without the created flag.
            pushNotice("Session persists if Hop exits; Ctrl+Q (twice) kills it");
          }
        }
        scheduleRender();
        break;
      case "presence":
        presence = message.clients;
        if (pendingAttachNotice) {
          pendingAttachNotice = false;
          const count = presence.length;
          pushNotice(`Attached to '${sessionLabel}' (${count} participant${count === 1 ? "" : "s"})`, "ok");
        }
        scheduleRender();
        break;
      case "cwd_changed":
        liveCwd = message.cwd;
        scheduleRender();
        break;
      case "output":
        {
          trackPrivateModes(message.data);
          trackOscColors(message.data);
          const filtered = filterFocusSequences(message.data);
          if (!filtered) return;
          terminal.write(filtered, () => {
            if (followOutput) {
              followCursorWithMargin();
            } else {
              restoreViewFromAnchor();
            }
            scheduleRender();
          });
        }
        break;
      case "snapshot":
        {
          trackPrivateModes(message.data);
          if (typeof message.alternateScreen === "boolean") {
            remoteAlternateScreen = message.alternateScreen;
          }
          trackOscColors(message.data);
          // reset() (not clear()) so the stale cursor position, SGR attrs, and
          // mode state from the previous connection don't bleed into the replay.
          terminal.reset();
          releaseScrollAnchor();
          followOutput = true;
          const filtered = filterFocusSequences(message.data);
          if (!filtered) return;
          replayingSnapshot = true;
          terminal.write(filtered, () => {
            replayingSnapshot = false;
            if (followOutput) {
              followCursorWithMargin();
            } else {
              clampView();
            }
            scheduleRender();
          });
        }
        break;
      case "collab":
        collabMode = message.enabled;
        controllerId = message.controllerId;
        if (message.enabled) {
          pushNotice("Control released — everyone can type", "ok");
        } else if (controllerId === clientId) {
          pushNotice(`You have exclusive control (${keyLabelShort}+C to release)`, "ok");
        } else {
          const takerName = presence.find((c) => c.id === controllerId)?.name || "another user";
          pushNotice(`${takerName} took control — ${keyLabelShort}+C to take it back`, "warn");
        }
        break;
      case "input_rejected": {
        let reasonText = message.reason;
        if (/control is locked/i.test(message.reason)) {
          const lockerName = (controllerId && controllerId !== clientId
            ? presence.find((c) => c.id === controllerId)?.name
            : null) || "another user";
          reasonText = `Control locked by ${lockerName} — ${keyLabelShort}+C to take control`;
        }
        // Rapid rejected keystrokes shouldn't restart the flash on every press.
        if (!(notice && notice.message === reasonText && notice.expiresAt > Date.now())) {
          pushNotice(reasonText, "warn");
        }
        break;
      }
      case "active_size":
        applyRemoteSize(message.cols, message.rows);
        break;
      case "session_ended": {
        shouldReconnect = false;
        // Attribute the kill unless we requested it ourselves; surface a
        // non-zero exit code / signal so crashes aren't indistinguishable
        // from clean exits.
        let endText = message.by && !killRequested
          ? `Session terminated by ${message.by}`
          : message.message;
        const endDetails: string[] = [];
        if (typeof message.exitCode === "number" && message.exitCode !== 0) {
          endDetails.push(`exit ${message.exitCode}`);
        }
        if (message.signal) {
          endDetails.push(message.signal);
        }
        if (endDetails.length > 0) {
          endText = `${endText} (${endDetails.join(", ")})`;
        }
        exitMessage = endText;
        exitCode = 0;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.close();
        } else {
          cleanupAndExit();
        }
        break;
      }
      case "session_renamed":
        sessionLabel = message.displayName;
        pushNotice(`Session renamed to ${message.displayName}`, "ok");
        scheduleRender();
        break;
      case "error":
        pushNotice(message.message);
        break;
      default:
        break;
    }
  });

  ws.on("close", () => {
    connected = false;
    if (shouldReconnect) {
      setStatus("reconnecting");
      scheduleReconnect();
    } else {
      cleanupAndExit();
    }
  });

  ws.on("error", (err) => {
    // Remember why the connection drops so the reconnect banner can say so.
    lastWsError = err.message;
    if (!shouldReconnect) {
      pushNotice(`Connection error: ${err.message}`, "warn");
    }
  });
};

const cleanupAndExit = () => {
  if (typingTimeout) {
    clearTimeout(typingTimeout);
  }
  stopDaemonPolling();
  clearReconnectTicker();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  if (noticeTimer) {
    clearTimeout(noticeTimer);
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  restoreUi();
  if (exitMessage) {
    console.log(`[hay] ${exitMessage}`);
  } else if (exitCode === DETACH_EXIT_CODE) {
    console.log(`[hay] Detached — session continues in background. Reattach with: hay -r ${config.room}`);
  } else if (exitCode === KILL_EXIT_CODE) {
    console.log("[hay] Session terminated.");
  } else {
    console.log("[hay] Disconnected");
  }
  process.exit(exitCode);
};

const handleLocalShortcut = (input: string) => {
  if (!input) return false;

  // Escape clears selection if active (before passing to remote)
  if (input === "\x1b" && selectionAnchor) {
    clearSelection();
    return true;
  }

  // Any non-mouse input clears selection
  if (selectionAnchor && !input.startsWith("\x1b[<")) {
    clearSelection();
  }

  // Opt+\ arms literal mode (consumed in the stdin handler): the next key is
  // forwarded verbatim so reserved keys (Ctrl+Q/G, Opt+…) can reach remote
  // programs.
  if (input === "\x1b\\" || (isMac && input === "«")) {
    literalNext = true;
    pushNotice("Next key will be sent to the remote terminal");
    return true;
  }

  // Anything other than an OPEN socket (CONNECTING included) means we can't
  // round-trip through the server, so the Ctrl+Q/Ctrl+G handlers below exit
  // locally rather than poisoning state and waiting on a close that never comes.
  const ctrlShortcutsReady = Date.now() >= shortcutsEnabledAt;

  // During the brief post-connect grace window, swallow the reserved Ctrl keys
  // instead of leaking them to the remote shell.
  if (!ctrlShortcutsReady && (input === "\x11" || input === "\x07")) {
    return true;
  }

  // Ctrl+Q (twice within 2s) to kill the session for everyone
  if (ctrlShortcutsReady && input === "\x11") {
    if (Date.now() > killArmedAt) {
      killArmedAt = Date.now() + KILL_CONFIRM_MS;
      pushNotice("Press Ctrl+Q again to kill the session for ALL participants (Ctrl+G detaches)", "warn");
      return true;
    }
    killArmedAt = 0;
    shouldReconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    if (ws?.readyState === WebSocket.OPEN) {
      killRequested = true;
      exitCode = KILL_EXIT_CODE;
      sendMessage({ type: "kill_session" });
      setTimeout(() => ws?.close(), 100);
    } else {
      // Nothing was killed — don't claim the session ended.
      exitCode = KILL_UNREACHABLE_EXIT_CODE;
      exitMessage = `Could not reach server — the session may still be running. Reattach with: hay -r ${config.room}`;
      try { ws?.close(); } catch (e) { /* connecting socket */ }
      cleanupAndExit();
    }
    return true;
  }

  // Ctrl+G to detach
  if (ctrlShortcutsReady && input === "\x07") {
    shouldReconnect = false;
    exitCode = DETACH_EXIT_CODE;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    if (ws?.readyState === WebSocket.OPEN) {
      ws.close();
    } else {
      try { ws?.close(); } catch (e) { /* connecting socket */ }
      cleanupAndExit();
    }
    return true;
  }

  const altKey = (key: string) => input === `\x1b${key}`;
  const altArrow = (seq: string) => input === seq;
  // Option+letter shortcuts only on macOS — elsewhere these glyphs (å, µ, º…)
  // are real AltGr characters and the ESC-prefixed altKey forms cover the keys.
  const optionChar = (char: string) => isMac && input === char;

  // CSI 1;3X = Alt+Arrow, CSI 1;4X = Shift+Alt+Arrow (fast pan).
  if (altKey("h") || altKey("H") || altArrow("\x1b[1;3D") || altArrow("\x1b[1;4D") || altArrow("\x1b\x1b[D")) {
    const step = altKey("H") || altArrow("\x1b[1;4D") ? PAN_FAST_STEP : PAN_STEP;
    viewX -= step;
    clampView();
    scheduleRender();
    return true;
  }
  if (altKey("l") || altKey("L") || altArrow("\x1b[1;3C") || altArrow("\x1b[1;4C") || altArrow("\x1b\x1b[C")) {
    const step = altKey("L") || altArrow("\x1b[1;4C") ? PAN_FAST_STEP : PAN_STEP;
    viewX += step;
    clampView();
    scheduleRender();
    return true;
  }
  if (altKey("k") || altKey("K") || altArrow("\x1b[1;3A") || altArrow("\x1b[1;4A") || altArrow("\x1b\x1b[A")) {
    const step = altKey("K") || altArrow("\x1b[1;4A") ? PAN_FAST_STEP : PAN_STEP;
    viewY -= step;
    clampView();
    updateFollowOutputFromViewport();
    scheduleRender();
    return true;
  }
  if (altKey("j") || altKey("J") || altArrow("\x1b[1;3B") || altArrow("\x1b[1;4B") || altArrow("\x1b\x1b[B")) {
    const step = altKey("J") || altArrow("\x1b[1;4B") ? PAN_FAST_STEP : PAN_STEP;
    viewY += step;
    clampView();
    updateFollowOutputFromViewport();
    scheduleRender();
    return true;
  }
  if (altKey("a") || altKey("A") || optionChar("å")) {
    syncSize = !syncSize;
    persistConfig({ syncSize });
    pushNotice(`Autofit ${syncSize ? "on" : "off"}`, "ok");
    if (syncSize) {
      applySyncSize();
    }
    return true;
  }
  if (altKey("b") || altKey("B") || optionChar("∫")) {
    showStatusBar = !showStatusBar;
    persistConfig({ showStatusBar });
    pushNotice(`Status bar ${showStatusBar ? "on" : "off"}`, "ok");
    scheduleRender();
    return true;
  }
  if (altKey("m") || altKey("M") || optionChar("µ")) {
    setMouseCapture(!mouseCapture);
    persistConfig({ mouseCapture });
    pushNotice(`Mouse capture ${mouseCapture ? "on" : "off"}`, "ok");
    return true;
  }
  if (altKey("t") || altKey("T") || optionChar("†")) {
    showHints = !showHints;
    persistConfig({ showHints });
    pushNotice(`Hints ${showHints ? "on" : "off"}`, "ok");
    scheduleRender();
    return true;
  }
  if (altKey("0") || optionChar("º")) {
    ensureCursorVisible(true);
    pushNotice("Following live output", "ok");
    scheduleRender();
    return true;
  }
  if (altKey("f") || altKey("F") || optionChar("ƒ")) {
    enterSearch();
    return true;
  }
  if (altKey("c") || altKey("C") || optionChar("ç")) {
    // Toggle exclusive control, mirroring the web Take/Release controls so a CLI
    // user on a locked shared session isn't stuck.
    if (!collabMode && controllerId === clientId) {
      sendMessage({ type: "release_control" });
      pushNotice("Releasing control (collaborative typing)…");
    } else if (collabMode) {
      sendMessage({ type: "take_control" });
      pushNotice("Taking exclusive control…");
    } else {
      sendMessage({ type: "take_control" });
      pushNotice("Seizing control…");
    }
    return true;
  }

  return false;
};

// Split a stdin chunk into atomic key tokens (ESC/CSI/SS3 sequences and single
// code points). Each token is a verbatim substring, so concatenating the tokens
// that aren't shortcuts reproduces the exact bytes to forward. This lets batched
// keypresses (key autorepeat, SSH coalescing) match shortcuts per-key instead of
// the whole chunk matching nothing and leaking raw escape sequences to the shell.
const tokenizeInput = (input: string): string[] => {
  const tokens: string[] = [];
  const n = input.length;
  let i = 0;
  const consumeCsi = (start: number) => {
    let j = start;
    while (j < n && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x3f) j += 1;
    if (j < n) j += 1; // include the final byte (0x40-0x7e)
    return j;
  };
  while (i < n) {
    if (input[i] === "\x1b") {
      if (input[i + 1] === "\x1b" && input[i + 2] === "[") {
        const j = consumeCsi(i + 3); // ESC ESC CSI (e.g. Alt+Arrow "\x1b\x1b[D")
        tokens.push(input.slice(i, j));
        i = j;
        continue;
      }
      if (input[i + 1] === "[") {
        const j = consumeCsi(i + 2); // CSI
        tokens.push(input.slice(i, j));
        i = j;
        continue;
      }
      if (input[i + 1] === "O") {
        const j = Math.min(i + 3, n); // SS3
        tokens.push(input.slice(i, j));
        i = j;
        continue;
      }
      if (i + 1 < n) {
        const cp = input.codePointAt(i + 1) ?? 0; // ESC + single code point (alt-letter)
        const len = 1 + String.fromCodePoint(cp).length;
        tokens.push(input.slice(i, i + len));
        i += len;
        continue;
      }
      tokens.push("\x1b"); // lone trailing ESC
      i += 1;
      continue;
    }
    const cp = input.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    tokens.push(ch);
    i += ch.length;
  }
  return tokens;
};

process.stdin.on("data", (data) => {
  let input = pendingInput + data.toString();
  pendingInput = "";
  // Auto theme: capture the terminal's OSC 11 background reply and keep it out
  // of the remote stream. The window closes 2s after the query.
  if (themeQueryDeadline) {
    if (Date.now() > themeQueryDeadline) {
      themeQueryDeadline = 0;
    } else {
      const reply = input.match(/\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)/);
      if (reply) {
        themeQueryDeadline = 0;
        input = input.replace(reply[0], "");
        const color = parseOscColor(reply[1]);
        if (color) {
          const luminance = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
          applyResolvedTheme(luminance > 0.55 ? "light" : "dark");
        }
      } else {
        // Reply split across chunks: stash a partial tail. Must be more than a
        // bare ESC so a real Escape keypress is never delayed.
        const partial = input.match(/\x1b(?:\](?:1(?:1(?:;[^\x07\x1b]*)?)?)?)?$/);
        if (partial && partial[0].length > 1) {
          pendingInput = partial[0];
          input = input.slice(0, -partial[0].length);
        }
      }
      if (!input) return;
    }
  }
  const lastMouseStart = input.lastIndexOf("\x1b[<");
  if (lastMouseStart !== -1) {
    const tail = input.slice(lastMouseStart);
    if (!/[Mm]/.test(tail)) {
      // Prepend: a stashed OSC-reply tail (above) must stay after the mouse
      // tail so the original stream order is preserved on the next chunk.
      pendingInput = tail + pendingInput;
      input = input.slice(0, lastMouseStart);
    }
  }
  // A mouse sequence can also split right inside its "\x1b[<" prefix. Stash a
  // trailing bare ESC / "\x1b[" only when it follows other input, so a real
  // lone Escape keypress still goes through immediately.
  if (mouseCapture && !pendingInput) {
    const partialPrefix = input.endsWith("\x1b[") ? "\x1b[" : input.endsWith("\x1b") ? "\x1b" : "";
    if (partialPrefix && input.length > partialPrefix.length) {
      pendingInput = partialPrefix;
      input = input.slice(0, -partialPrefix.length);
    }
  }
  if (!input) return;
  const mouseResult = stripMouseSequences(input);
  input = mouseResult.cleaned;
  if (!input) return;

  // While searching, all keys edit the query / navigate matches (never forwarded).
  if (searchMode) {
    handleSearchInput(input);
    return;
  }

  let remote = "";
  if (literalNext) {
    // Opt+\ armed: bypass all local shortcuts and forward this key verbatim.
    literalNext = false;
    remote = input;
  } else {
    // Fast path: a single keypress chunk that is a shortcut (the common case).
    if (handleLocalShortcut(input)) return;

    // Otherwise split into individual key tokens so a batched chunk can have its
    // shortcut keys handled locally while the rest is forwarded to the shell.
    const tokens = tokenizeInput(input);
    for (const token of tokens) {
      if (handleLocalShortcut(token)) continue;
      remote += token;
    }
  }
  if (!remote) return;

  const sanitized = filterFocusSequences(remote);
  if (!sanitized) return;

  if (syncSize) {
    applySyncSize();
  }

  followOutput = true;
  releaseScrollAnchor();
  sendMessage({ type: "input", data: sanitized });
  handleTyping();
});

process.stdout.on("resize", () => {
  localMetrics = getLocalMetrics();
  if (syncSize) {
    applySyncSize();
  } else {
    clampView();
  }
  scheduleRender();
});

const handleSignalExit = () => {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // If the socket is OPEN, let its close event drive cleanup; otherwise (closed,
  // connecting, or mid-reconnect backoff) close() is a no-op that fires no event,
  // so exit directly — else the process hangs in the alternate screen forever.
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  } else {
    try { ws?.close(); } catch (e) { /* ignore */ }
    cleanupAndExit();
  }
};

process.on("SIGINT", handleSignalExit);
process.on("SIGTERM", handleSignalExit);

process.on("exit", () => {
  stopDaemonPolling();
  restoreUi();
});

startDaemonPolling();
connect();
