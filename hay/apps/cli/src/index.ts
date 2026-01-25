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

const CONFIG_PATH = path.join(os.homedir(), ".hay-cli.json");
type CliConfig = { showHints?: boolean };

const loadConfig = (): CliConfig => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as CliConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
};

const saveConfig = (config: CliConfig) => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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
  Ctrl+G               Detach (session continues in background)
  Ctrl+Q               Kill session and exit
  Ctrl+T               Toggle hint bar (saved)
  ${keyLabelLong}+←/→/↑/↓        Pan viewport (Shift = faster)
  ${keyLabelLong}+A             Toggle autofit (resize remote to local)

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

const DETACH_EXIT_CODE = 10;
const KILL_EXIT_CODE = 11;
const TYPING_IDLE_MS = 1200;
const NOTICE_MS = 3500;
const PAN_STEP = 2;
const PAN_FAST_STEP = 10;
let cursorVisible = true;
const SCROLL_STEP = 3;
let pendingInput = "";
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
let exitCode = 0;
let exitMessage: string | null = null;

let collabMode = true;
let controllerId: string | null = null;
let presence: PresenceClient[] = [];
let notice: { message: string; expiresAt: number } | null = null;

let syncSize = true;
let mouseCapture = true;
let viewX = 0;
let viewY = 0;
let showHints = true;

let uiInitialized = false;
let renderScheduled = false;
let lastRenderCols = 0;
let lastRenderRows = 0;

const getLocalMetrics = () => {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const showBottomBar = rows >= 2;
  const showHintBar = showHints && rows >= 3;
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

const configFile = loadConfig();
showHints = configFile.showHints ?? true;

// Forward terminal-generated responses (eg. DSR cursor reports) back to the PTY.
terminal.onData((data) => {
  if (!data) return;
  sendMessage({ type: "input", data });
});

const filterFocusSequences = (data: string) => data.replace(/\x1b\[I/g, "").replace(/\x1b\[O/g, "");

const stripMouseSequences = (data: string) => {
  let didScroll = false;
  const cleaned = data.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_, buttonText, _x, _y, kind) => {
    const button = Number(buttonText);
    const isWheel = (button & 64) === 64;
    if (isWheel && kind === "M") {
      const direction = (button & 1) === 1 ? 1 : -1;
      viewY += direction * SCROLL_STEP;
      clampView();
      scheduleRender();
      didScroll = true;
    }
    return "";
  });
  return { cleaned, didScroll };
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

terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
  if (params.includes(25)) {
    setCursorVisible(false);
  }
  return false;
});

terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
  if (params.includes(25)) {
    setCursorVisible(true);
  }
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

const buildShareUrl = () => {
  const explicit = process.env.HAY_SHARE_URL || process.env.HOP_PUBLIC_URL || "";

  const normalize = (raw: string) => {
    try {
      const url = new URL(raw);
      return url.origin;
    } catch {
      return raw;
    }
  };

  if (explicit) {
    return normalize(explicit);
  }

  try {
    const wsUrl = new URL(config.server);
    const protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
    return normalize(`${protocol}//${wsUrl.host}`);
  } catch {
    return "";
  }
};

const setStatus = (nextStatus: typeof status) => {
  status = nextStatus;
  scheduleRender();
};

const applyRemoteSize = (cols: number, rows: number) => {
  const nextCols = Math.max(2, Math.min(cols, 500));
  const nextRows = Math.max(1, Math.min(rows, 200));
  if (remoteCols === nextCols && remoteRows === nextRows) return;
  remoteCols = nextCols;
  remoteRows = nextRows;
  terminal.resize(remoteCols, remoteRows);
  // Scroll to show cursor position after resize
  const buffer = terminal.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;
  viewY = Math.max(0, cursorRow - localMetrics.viewportRows + 1);
  clampView();
  scheduleRender();
};

const applySyncSize = () => {
  if (!syncSize) return;
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
  process.stdout.write("\x1b[?1000h\x1b[?1006h");
};

const disableMouseCapture = () => {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[?1006l\x1b[?1000l");
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

const composeBar = (left: string, right: string, cols: number) => {
  if (!right) {
    return padOrTrim(left, cols);
  }
  const rightLen = visibleLength(right);
  if (rightLen >= cols) {
    return padOrTrim(right.slice(0, cols), cols);
  }
  const availableLeft = Math.max(0, cols - rightLen - 1);
  const trimmedLeft = visibleLength(left) > availableLeft ? truncateAnsi(left, availableLeft) : left;
  const gap = Math.max(1, cols - visibleLength(trimmedLeft) - rightLen);
  return padOrTrim(trimmedLeft + " ".repeat(gap) + right, cols);
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
    const isCursorCell = isCursorLine && remoteCol === cursorCol;
    if (!cellData) {
      if (currentKey !== "default") {
        output += "\x1b[0m";
        currentKey = "default";
      }
      output += " ";
      continue;
    }

    let width = cellData.getWidth();
    let chars = cellData.getChars();
    if (!chars) {
      chars = " ";
    }

    if (width === 0 && !isCursorCell) {
      if (currentKey !== "default") {
        output += "\x1b[0m";
        currentKey = "default";
      }
      output += " ";
      continue;
    }
    if (width === 0 && isCursorCell) {
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
      isCursorCell
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

  const statusOrUrl = statusLabel || shareUrl;
  const bottomLeft = `● ${config.room}`;
  const autofitLabel = syncSize ? "autofit on" : "autofit off";
  const peerLabel = `peers ${presenceNames.length}`;
  const rightPrimary = decorateBottom(
    [statusOrUrl, autofitLabel, peerLabel].filter(Boolean).join(" | "),
    statusLabel ? [peerLabel] : [shareUrl, peerLabel]
  );
  const bottomPrimary = renderBar(
    decorateTop(composeBar(bottomLeft, rightPrimary, localMetrics.cols), statusLabel ? [] : [shareUrl], [config.room]),
    "bottom"
  );

  const noticeText = notice && notice.expiresAt > Date.now() ? ` ${notice.message} ` : "";
  const controls = `${keyLabelShort}: ←→↑↓ pan, 0 center, A fit, M mouse | Ctrl: T hints, G detach, Q kill`;
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
      case "output":
        {
          trackOscColors(message.data);
          const filtered = filterFocusSequences(message.data);
          if (!filtered) return;
          // Follow output if cursor was visible (standard terminal behavior)
          const buffer = terminal.buffer.active;
          const cursorRowBefore = buffer.baseY + buffer.cursorY;
          const cursorWasVisible = cursorRowBefore >= viewY && cursorRowBefore < viewY + localMetrics.viewportRows;
          terminal.write(filtered, () => {
            if (cursorWasVisible) {
              const cursorRowAfter = buffer.baseY + buffer.cursorY;
              viewY = Math.max(0, cursorRowAfter - localMetrics.viewportRows + 1);
              clampView();
            }
            scheduleRender();
          });
        }
        break;
      case "snapshot":
        {
          trackOscColors(message.data);
          terminal.clear();
          const filtered = filterFocusSequences(message.data);
          if (!filtered) return;
          terminal.write(filtered, () => {
            // Scroll to show cursor position on snapshot restore
            const buffer = terminal.buffer.active;
            const cursorRow = buffer.baseY + buffer.cursorY;
            // Position viewport so cursor is visible near the bottom
            viewY = Math.max(0, cursorRow - localMetrics.viewportRows + 1);
            clampView();
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

  const shouldExitImmediately =
    !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;

  // Ctrl+Q to kill session
  if (input === "\x11") {
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
  if (input === "\x07") {
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
  if (input === "\x14") {
    showHints = !showHints;
    saveConfig({ ...configFile, showHints });
    pushNotice(`Hints ${showHints ? "on" : "off"}`);
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
    scheduleRender();
    return true;
  }
  if (altKey("j") || altKey("J") || altArrow("\x1b[1;3B") || altArrow("\x1b\x1b[B")) {
    const step = altKey("J") ? PAN_FAST_STEP : PAN_STEP;
    viewY += step;
    clampView();
    scheduleRender();
    return true;
  }
  if (altKey("a") || altKey("A") || optionChar("å")) {
    syncSize = !syncSize;
    pushNotice(`Autofit ${syncSize ? "on" : "off"}`);
    if (syncSize) {
      applySyncSize();
    }
    return true;
  }
  if (altKey("m") || altKey("M") || optionChar("µ")) {
    setMouseCapture(!mouseCapture);
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
  restoreUi();
});

connect();
