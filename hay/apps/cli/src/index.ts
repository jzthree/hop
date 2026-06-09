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

type CliConfig = {
  showHints?: boolean;
  showStatusBar?: boolean;
  mouseCapture?: boolean;
  syncSize?: boolean;
  scrollOff?: number;
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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--server" || arg === "-s") {
      server = args[++i] || server;
    } else if (arg === "--room" || arg === "-r") {
      room = args[++i] || room;
    } else if (arg === "--name" || arg === "-n") {
      name = args[++i] || name;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
hay-cli - Connect to a hay room from your terminal

Usage:
  hay [options]

Options:
  -s, --server <url>   WebSocket server URL (default: ws://localhost:4001/ws)
  -r, --room <name>    Room name (required)
  -n, --name <name>    Display name (default: $USER)
  -h, --help           Show this help

Keyboard shortcuts:
  Ctrl+G               Detach (session keeps running)
  Ctrl+Q               Kill session and exit
  Ctrl+T               Toggle hint bar (saved)
  ${keyLabelLong}+←/→/↑/↓        Pan viewport (Shift = faster)
  ${keyLabelLong}+A             Toggle autofit (saved)
  ${keyLabelLong}+B             Toggle status bar (saved)
  ${keyLabelLong}+M             Toggle mouse capture (saved)

Examples:
  hay -r my-room
  hay -r my-room -n alice -s ws://example.com/ws
`);
      process.exit(0);
    } else if (!room) {
      room = arg;
    }
  }

  return { server, room, name };
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
let typingTimeout: NodeJS.Timeout | null = null;
let noticeTimer: NodeJS.Timeout | null = null;
let daemonPollTimer: NodeJS.Timeout | null = null;
let exitCode = 0;
let exitMessage: string | null = null;
let shortcutsEnabledAt = 0;
let persistenceNoticeShown = false;

let collabMode = true;
let controllerId: string | null = null;
let presence: PresenceClient[] = [];
let notice: { message: string; expiresAt: number } | null = null;

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
  const showHintBar = (showHints || hasNotice) && rows >= (showBottomBar ? 3 : 2);
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
  scrollback: 2000,
  allowProposedApi: true
});

// Forward terminal-generated responses (eg. DSR cursor reports) back to the PTY.
terminal.onData((data) => {
  if (!data) return;
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
    const text = line.translateToString(true);
    if (row === sel.start.row && row === sel.end.row) {
      lines.push(text.slice(sel.start.col, sel.end.col + 1));
    } else if (row === sel.start.row) {
      lines.push(text.slice(sel.start.col));
    } else if (row === sel.end.row) {
      lines.push(text.slice(0, sel.end.col + 1));
    } else {
      lines.push(text);
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
  pushNotice(`Copied ${text.split("\n").length} line(s)`);
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

const scheduleRender = () => {
  if (renderScheduled) return;
  renderScheduled = true;
  setTimeout(() => {
    renderScheduled = false;
    render();
  }, 0);
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

const pushNotice = (message: string) => {
  notice = { message, expiresAt: Date.now() + NOTICE_MS };
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
  )}&cols=${localMetrics.viewportCols}&rows=${localMetrics.viewportRows}`;
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
    sendMessage({ type: "resize", cols, rows });
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

const visibleLength = (text: string) => text.replace(ANSI_REGEX, "").length;

const truncateAnsi = (text: string, cols: number) => {
  if (cols <= 0) return "";
  let out = "";
  let visible = 0;
  for (let i = 0; i < text.length && visible < cols; i += 1) {
    const char = text[i];
    if (char === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i + 2);
      if (end === -1) {
        break;
      }
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    out += char;
    visible += 1;
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

const joinBarSegments = (segments: BarSegment[]) => segments.map((segment) => segment.text).join(" | ");

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

const BAR_TOP_BG = "\x1b[48;5;254m";
const BAR_BOTTOM_BG = "\x1b[48;5;254m";
const BAR_FG = "\x1b[38;5;234m";
const BAR_ACCENT = "\x1b[38;5;93m";
const BAR_DIM = "\x1b[38;5;245m";
const BAR_BOLD = "\x1b[1m";
const BAR_RESET_FG = "\x1b[22m\x1b[38;5;234m";

const renderBar = (text: string, variant: "top" | "bottom") =>
  `${variant === "top" ? BAR_TOP_BG : BAR_BOTTOM_BG}${BAR_FG}${text}\x1b[0m`;

const decorateTop = (text: string, secondaryTokens: string[], boldTokens: string[]) => {
  let output = text;
  output = output.replace("●", `${BAR_ACCENT}●${BAR_RESET_FG}`);
  output = output.replace(/ \| /g, ` ${BAR_DIM}|${BAR_RESET_FG} `);
  for (const token of boldTokens) {
    if (!token) continue;
    output = output.replace(token, `${BAR_BOLD}${token}${BAR_RESET_FG}`);
  }
  for (const token of secondaryTokens) {
    if (!token) continue;
    output = output.replace(token, `${BAR_DIM}${token}${BAR_RESET_FG}`);
  }
  return output;
};

const decorateBottom = (text: string, secondaryTokens: string[]) => {
  let output = text;
  output = output.replace(/ \| /g, ` ${BAR_DIM}|${BAR_RESET_FG} `);
  for (const token of secondaryTokens) {
    if (!token) continue;
    output = output.replace(token, `${BAR_DIM}${token}${BAR_RESET_FG}`);
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

    const style = styleKeyForCell(
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

  if (localMetrics.cols !== lastRenderCols || localMetrics.rows !== lastRenderRows) {
    process.stdout.write("\x1b[2J");
    lastRenderCols = localMetrics.cols;
    lastRenderRows = localMetrics.rows;
  }

  const presenceNames = presence.filter((client) => client.id !== clientId).map((client) => client.name);
  const statusLabel = status === "connected" ? "" : status;
  const shareUrl = buildShareUrl();
  const hopDaemonLabel = buildHopDaemonLabel();

  const cwdLabel = formatCwd(liveCwd);
  const cwdText = cwdLabel ? ` · ${cwdLabel}` : "";
  const bottomLeft = `● ${sessionLabel}${cwdText}`;
  const autofitLabel = syncSize ? "fit" : "manual";
  const persistenceLabel = "persists";
  const peerLabel = `peers ${presenceNames.length}`;
  const rightSegments = fitBarSegments(
    bottomLeft,
    [
      statusLabel ? { text: statusLabel } : null,
      hopDaemonLabel ? { text: hopDaemonLabel, secondary: true, dropPriority: 1 } : null,
      !statusLabel && shareUrl ? { text: shareUrl, secondary: true, dropPriority: 0 } : null,
      { text: persistenceLabel, secondary: true, dropPriority: 2 },
      { text: autofitLabel, secondary: true, dropPriority: 3 },
      { text: peerLabel, secondary: true, dropPriority: 4 }
    ].filter((segment): segment is BarSegment => !!segment),
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
    .filter((segment) => segment.text === hopDaemonLabel || segment.text === shareUrl || segment.text === persistenceLabel)
    .map((segment) => segment.text);
  const bottomPrimary = renderBar(
    decorateTop(composeBar(bottomLeft, rightPrimary, localMetrics.cols), topPriority, [sessionLabel]),
    "bottom"
  );

  const noticeText = notice && notice.expiresAt > Date.now()
    ? ` ${notice.message} `
    : "";
  const controls = `${keyLabelShort}: ←→↑↓ pan, 0 center, A fit, B status ${showStatusBar ? "on" : "off"}, M mouse ${mouseCapture ? "on" : "off"} | Ctrl: T hints, G detach, Q kill`;
  const hintLine = renderBar(
    composeBar(noticeText || `${BAR_DIM}${controls}${BAR_RESET_FG}`, "", localMetrics.cols),
    "bottom"
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

  const output = "\x1b[?25l\x1b[H" + lines.join("\n");
  process.stdout.write(output);
};

const scheduleReconnect = () => {
  if (!shouldReconnect) return;

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
  reconnectAttempt += 1;
  pushNotice(`Reconnecting in ${Math.round(delay / 1000)}s...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (shouldReconnect) {
      connect();
    }
  }, delay);
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
    remoteMouseModes.clear();
    remoteAlternateScreen = false;
    remoteApplicationCursor = false;
    pendingPrivateMode = "";
    shortcutsEnabledAt = Date.now() + 400;
    reconnectAttempt = 0;
    setStatus("connected");
    initUi();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    if (syncSize) {
      applySyncSize();
    }
    if (!persistenceNoticeShown) {
      persistenceNoticeShown = true;
      pushNotice("Session persists if Hop exits; Ctrl+Q kills it");
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
        scheduleRender();
        break;
      case "presence":
        presence = message.clients;
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
          terminal.clear();
          releaseScrollAnchor();
          followOutput = true;
          const filtered = filterFocusSequences(message.data);
          if (!filtered) return;
          terminal.write(filtered, () => {
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
        pushNotice(message.enabled ? "Collaborative typing enabled" : "Control locked");
        break;
      case "input_rejected":
        pushNotice(message.reason);
        break;
      case "active_size":
        applyRemoteSize(message.cols, message.rows);
        break;
      case "session_ended":
        shouldReconnect = false;
        exitMessage = message.message;
        exitCode = 0;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.close();
        } else {
          cleanupAndExit();
        }
        break;
      case "session_renamed":
        sessionLabel = message.displayName;
        pushNotice(`Session renamed to ${message.displayName}`);
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
    if (!shouldReconnect) {
      pushNotice(`Connection error: ${err.message}`);
    }
  });
};

const cleanupAndExit = () => {
  if (typingTimeout) {
    clearTimeout(typingTimeout);
  }
  stopDaemonPolling();
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
    console.log("[hay] Detaching (session continues in background)...");
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

  const shouldExitImmediately =
    !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
  const ctrlShortcutsReady = Date.now() >= shortcutsEnabledAt;

  // Ctrl+Q to kill session
  if (ctrlShortcutsReady && input === "\x11") {
    shouldReconnect = false;
    exitCode = KILL_EXIT_CODE;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    if (ws?.readyState === WebSocket.OPEN) {
      sendMessage({ type: "kill_session" });
      setTimeout(() => ws?.close(), 100);
    } else if (shouldExitImmediately) {
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
    } else if (shouldExitImmediately) {
      cleanupAndExit();
    }
    return true;
  }

  // Ctrl+T toggles hint bar
  if (ctrlShortcutsReady && input === "\x14") {
    showHints = !showHints;
    persistConfig({ showHints });
    pushNotice(`Hints ${showHints ? "on" : "off"}`);
    scheduleRender();
    return true;
  }

  const altKey = (key: string) => input === `\x1b${key}`;
  const altArrow = (seq: string) => input === seq;
  const optionChar = (char: string) => input === char;

  if (altKey("h") || altKey("H") || altArrow("\x1b[1;3D") || altArrow("\x1b\x1b[D")) {
    const step = altKey("H") ? PAN_FAST_STEP : PAN_STEP;
    viewX -= step;
    clampView();
    scheduleRender();
    return true;
  }
  if (altKey("l") || altKey("L") || altArrow("\x1b[1;3C") || altArrow("\x1b\x1b[C")) {
    const step = altKey("L") ? PAN_FAST_STEP : PAN_STEP;
    viewX += step;
    clampView();
    scheduleRender();
    return true;
  }
  if (altKey("k") || altKey("K") || altArrow("\x1b[1;3A") || altArrow("\x1b\x1b[A")) {
    const step = altKey("K") ? PAN_FAST_STEP : PAN_STEP;
    viewY -= step;
    clampView();
    updateFollowOutputFromViewport();
    scheduleRender();
    return true;
  }
  if (altKey("j") || altKey("J") || altArrow("\x1b[1;3B") || altArrow("\x1b\x1b[B")) {
    const step = altKey("J") ? PAN_FAST_STEP : PAN_STEP;
    viewY += step;
    clampView();
    updateFollowOutputFromViewport();
    scheduleRender();
    return true;
  }
  if (altKey("a") || altKey("A") || optionChar("å")) {
    syncSize = !syncSize;
    persistConfig({ syncSize });
    pushNotice(`Autofit ${syncSize ? "on" : "off"}`);
    if (syncSize) {
      applySyncSize();
    }
    return true;
  }
  if (altKey("b") || altKey("B") || optionChar("∫")) {
    showStatusBar = !showStatusBar;
    persistConfig({ showStatusBar });
    pushNotice(`Status bar ${showStatusBar ? "on" : "off"}`);
    scheduleRender();
    return true;
  }
  if (altKey("m") || altKey("M") || optionChar("µ")) {
    setMouseCapture(!mouseCapture);
    persistConfig({ mouseCapture });
    pushNotice(`Mouse capture ${mouseCapture ? "on" : "off"}`);
    return true;
  }
  if (altKey("0") || optionChar("º")) {
    ensureCursorVisible(true);
    pushNotice("Centered on cursor");
    return true;
  }

  return false;
};

process.stdin.on("data", (data) => {
  let input = pendingInput + data.toString();
  pendingInput = "";
  const lastMouseStart = input.lastIndexOf("\x1b[<");
  if (lastMouseStart !== -1) {
    const tail = input.slice(lastMouseStart);
    if (!/[Mm]/.test(tail)) {
      pendingInput = tail;
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
  if (handleLocalShortcut(input)) return;

  const sanitized = filterFocusSequences(input);
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

process.on("SIGINT", () => {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  ws?.close();
});

process.on("SIGTERM", () => {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  ws?.close();
});

process.on("exit", () => {
  stopDaemonPolling();
  restoreUi();
});

startDaemonPolling();
connect();
