#!/usr/bin/env node
import process from "node:process";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { safeParseServerMessage, type ClientMessage, type PresenceClient } from "hay-shared";

const args = process.argv.slice(2);

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
  Ctrl+]               Detach (session continues in background)
  Ctrl+Q               Kill session and exit
  Option+←/→/↑/↓        Pan viewport (Shift = faster)
  Option+A             Toggle autofit (resize remote to local)

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

let collabMode = true;
let controllerId: string | null = null;
let presence: PresenceClient[] = [];
let notice: { message: string; expiresAt: number } | null = null;

let syncSize = true;
let viewX = 0;
let viewY = 0;

let uiInitialized = false;
let renderScheduled = false;
let lastRenderCols = 0;
let lastRenderRows = 0;

const getLocalMetrics = () => {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const barRows = rows >= 3 ? 2 : 0;
  return {
    cols,
    rows,
    barRows,
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

const filterFocusSequences = (data: string) => data.replace(/\x1b\[I/g, "").replace(/\x1b\[O/g, "");

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const clampView = () => {
  const maxX = Math.max(0, remoteCols - localMetrics.viewportCols);
  const maxY = Math.max(0, remoteRows - localMetrics.viewportRows);
  viewX = clamp(viewX, 0, maxX);
  viewY = clamp(viewY, 0, maxY);
};

const ensureCursorVisible = (_force: boolean) => {
  const cursorX = terminal.buffer.active.cursorX;
  const cursorY = terminal.buffer.active.cursorY;
  let nextX = viewX;
  let nextY = viewY;

  if (cursorX < viewX) {
    nextX = cursorX;
  } else if (cursorX >= viewX + localMetrics.viewportCols) {
    nextX = cursorX - localMetrics.viewportCols + 1;
  }

  if (cursorY < viewY) {
    nextY = cursorY;
  } else if (cursorY >= viewY + localMetrics.viewportRows) {
    nextY = cursorY - localMetrics.viewportRows + 1;
  }

  viewX = nextX;
  viewY = nextY;
  clampView();
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
  clampView();
  ensureCursorVisible(true);
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

const initUi = () => {
  if (uiInitialized || !process.stdout.isTTY) return;
  uiInitialized = true;
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  lastRenderCols = 0;
  lastRenderRows = 0;
};

const restoreUi = () => {
  if (!uiInitialized || !process.stdout.isTTY) return;
  process.stdout.write("\x1b[?25h\x1b[?1049l\x1b[0m");
  uiInitialized = false;
};

const padOrTrim = (text: string, cols: number) => {
  if (text.length > cols) return text.slice(0, cols);
  if (text.length < cols) return text + " ".repeat(cols - text.length);
  return text;
};

const composeBar = (left: string, right: string, cols: number) => {
  if (!right) {
    return padOrTrim(left, cols);
  }
  if (right.length >= cols) {
    return padOrTrim(right.slice(0, cols), cols);
  }
  const availableLeft = Math.max(0, cols - right.length - 1);
  const trimmedLeft = left.length > availableLeft ? left.slice(0, availableLeft) : left;
  const gap = Math.max(1, cols - trimmedLeft.length - right.length);
  return padOrTrim(trimmedLeft + " ".repeat(gap) + right, cols);
};

const BAR_TOP_BG = "\x1b[48;5;238m";
const BAR_BOTTOM_BG = "\x1b[48;5;238m";
const BAR_FG = "\x1b[38;5;250m";
const BAR_ACCENT = "\x1b[38;5;110m\x1b[1m";
const BAR_OK = "\x1b[38;5;151m\x1b[1m";
const BAR_WARN = "\x1b[38;5;180m\x1b[1m";
const BAR_ERR = "\x1b[38;5;174m\x1b[1m";
const BAR_DIM = "\x1b[38;5;245m";
const BAR_RESET_FG = "\x1b[22m\x1b[38;5;250m";

const renderBar = (text: string, variant: "top" | "bottom") =>
  `${variant === "top" ? BAR_TOP_BG : BAR_BOTTOM_BG}${BAR_FG}${text}\x1b[0m`;

const decorateTop = (text: string) => {
  let output = text;
  output = output.replace(" HAY ", ` ${BAR_ACCENT}HAY${BAR_RESET_FG} `);
  if (output.includes("connected")) {
    output = output.replace("connected", `${BAR_OK}connected${BAR_RESET_FG}`);
  } else if (output.includes("reconnecting")) {
    output = output.replace("reconnecting", `${BAR_WARN}reconnecting${BAR_RESET_FG}`);
  } else if (output.includes("connecting")) {
    output = output.replace("connecting", `${BAR_WARN}connecting${BAR_RESET_FG}`);
  } else if (output.includes("disconnected")) {
    output = output.replace("disconnected", `${BAR_ERR}disconnected${BAR_RESET_FG}`);
  }
  return output;
};

const decorateBottom = (text: string) => {
  let output = text;
  output = output.replace("autofit on", `autofit ${BAR_OK}on${BAR_RESET_FG}`);
  output = output.replace("autofit off", `autofit ${BAR_DIM}off${BAR_RESET_FG}`);
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

  const fgMode = cell.isFgRGB() ? "rgb" : cell.isFgPalette() ? "palette" : "default";
  const bgMode = cell.isBgRGB() ? "rgb" : cell.isBgPalette() ? "palette" : "default";
  const fg = cell.getFgColor();
  const bg = cell.getBgColor();

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
  if (inverse) codes.push(7);
  if (invisible) codes.push(8);
  if (strike) codes.push(9);
  if (overline) codes.push(53);

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
    codes.push(39);
  } else if (fgMode === "palette") {
    pushPalette(fg, 30, 90, true);
  } else {
    const r = (fg >> 16) & 0xff;
    const g = (fg >> 8) & 0xff;
    const b = fg & 0xff;
    codes.push(38, 2, r, g, b);
  }

  if (bgMode === "default") {
    codes.push(49);
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
  const base = buffer.viewportY + viewY;
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
  const modeLabel = collabMode
    ? "collab"
    : controllerId
      ? `locked:${presence.find((c) => c.id === controllerId)?.name ?? "?"}`
      : "locked";
  const statusLabel = status === "connected" ? "connected" : status === "reconnecting" ? "reconnecting" : status;

  const topLeft = ` HAY ${config.room} @${config.name}`;
  const topRight = `${statusLabel}  ${modeLabel}`;
  const topLine = renderBar(decorateTop(composeBar(topLeft, topRight, localMetrics.cols)), "top");

  const noticeText = notice && notice.expiresAt > Date.now() ? ` ${notice.message} ` : "";
  const controls = " Opt+Arrows pan  Opt+A fit  Ctrl+] detach  Ctrl+Q kill ";
  const left = noticeText || controls;
  const autofitLabel = syncSize ? "autofit on" : "autofit off";
  const peerLabel = `peers ${presenceNames.length}`;
  const bottomRight = `${autofitLabel}  ${peerLabel}`;
  const bottomLine = renderBar(decorateBottom(composeBar(left, bottomRight, localMetrics.cols)), "bottom");

  const buffer = terminal.buffer.active;
  const showCursor = connected && cursorVisible;
  const cursorRow = showCursor ? buffer.baseY + buffer.cursorY : -1;
  const cursorCol = showCursor ? buffer.cursorX : -1;

  const lines: string[] = [];
  if (localMetrics.barRows > 0) {
    lines.push(topLine);
  }

  for (let row = 0; row < localMetrics.viewportRows; row++) {
    lines.push(renderLine(row, cursorRow, cursorCol));
  }

  if (localMetrics.barRows > 0) {
    lines.push(bottomLine);
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
          const filtered = filterFocusSequences(message.data);
          if (!filtered) return;
          terminal.write(filtered, () => {
            ensureCursorVisible(false);
            scheduleRender();
          });
        }
        break;
      case "snapshot":
        {
          terminal.clear();
          const filtered = filterFocusSequences(message.data);
          if (!filtered) return;
          terminal.write(filtered, () => {
            ensureCursorVisible(true);
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
  if (exitCode === DETACH_EXIT_CODE) {
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

  // Ctrl+Q to kill session
  if (input === "\x11") {
    shouldReconnect = false;
    exitCode = KILL_EXIT_CODE;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    sendMessage({ type: "kill_session" });
    setTimeout(() => ws?.close(), 100);
    return true;
  }

  // Ctrl+] to detach (telnet convention)
  if (input === "\x1d") {
    shouldReconnect = false;
    exitCode = DETACH_EXIT_CODE;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    ws?.close();
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
  if (altKey("0") || optionChar("º")) {
    ensureCursorVisible(true);
    pushNotice("Centered on cursor");
    return true;
  }

  return false;
};

process.stdin.on("data", (data) => {
  const input = data.toString();
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
    ensureCursorVisible(true);
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

connect();
