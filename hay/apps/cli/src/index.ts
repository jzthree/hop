#!/usr/bin/env node
import { WebSocket } from "ws";
import { safeParseServerMessage, type ClientMessage } from "hay-shared";

const args = process.argv.slice(2);

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
  Ctrl+D               Detach (session continues in background)
  Ctrl+Q               Kill session and exit

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

let ws: WebSocket;
let clientId: string | null = null;
let connected = false;
let shouldReconnect = true;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

function getUrl() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const separator = config.server.includes("?") ? "&" : "?";
  return `${config.server}${separator}room=${encodeURIComponent(config.room)}&name=${encodeURIComponent(config.name)}&cols=${cols}&rows=${rows}`;
}

function sendMessage(message: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function scheduleReconnect() {
  if (!shouldReconnect) return;

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
  reconnectAttempt += 1;

  process.stdout.write(`\r\n\x1b[90m[hay] Reconnecting in ${Math.round(delay / 1000)}s...\x1b[0m\r\n`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (shouldReconnect) {
      connect();
    }
  }, delay);
}

function connect() {
  // Clear any pending reconnect
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const url = getUrl();
  ws = new WebSocket(url);

  ws.on("open", () => {
    connected = true;
    reconnectAttempt = 0; // Reset backoff on successful connection
    // Enter raw mode for terminal input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
  });

  ws.on("message", (data) => {
    const message = safeParseServerMessage(data.toString());
    if (!message) return;

    switch (message.type) {
      case "hello":
        clientId = message.clientId;
        // Clear screen and show connection info
        process.stdout.write("\x1b[2J\x1b[H");
        process.stdout.write(`\x1b[90m[hay] Connected to room "${config.room}" as "${config.name}"\x1b[0m\r\n`);
        process.stdout.write(`\x1b[90m[hay] Ctrl+D to detach, Ctrl+Q to kill session\x1b[0m\r\n\r\n`);
        break;

      case "output":
        process.stdout.write(message.data);
        break;

      case "snapshot":
        process.stdout.write(message.data);
        break;

      case "presence":
        // Show presence updates in terminal title
        const others = message.clients.filter(c => c.id !== clientId);
        const title = others.length > 0
          ? `hay: ${config.room} (${others.map(c => c.name).join(", ")})`
          : `hay: ${config.room}`;
        process.stdout.write(`\x1b]0;${title}\x07`);
        break;

      case "collab":
        const mode = message.enabled ? "collaborative" : "locked";
        process.stdout.write(`\r\n\x1b[90m[hay] Control mode: ${mode}\x1b[0m\r\n`);
        break;

      case "input_rejected":
        process.stdout.write(`\r\n\x1b[91m[hay] ${message.reason}\x1b[0m\r\n`);
        break;
    }
  });

  ws.on("close", () => {
    connected = false;
    if (shouldReconnect) {
      scheduleReconnect();
    } else {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdout.write("\r\n\x1b[90m[hay] Disconnected\x1b[0m\r\n");
      process.exit(0);
    }
  });

  ws.on("error", (err) => {
    // Error is usually followed by close, which handles reconnect
    if (!shouldReconnect) {
      console.error(`\r\n\x1b[91m[hay] Connection error: ${err.message}\x1b[0m`);
    }
  });
}

// WHITELIST: Only these patterns are user input
// Everything else (terminal responses) is rejected by default
const USER_INPUT_PATTERNS = [
  /^[\x20-\x7e]+$/,                    // Printable ASCII (typing)
  /^[\x00-\x1f]$/,                     // Single control char (Ctrl+A..Z, Enter, Tab, etc.)
  /^\x1b$/,                            // Bare escape
  /^\x1b\[[A-D]$/,                     // Arrow keys: ESC[A, ESC[B, ESC[C, ESC[D
  /^\x1b\[[HF]$/,                      // Home/End: ESC[H, ESC[F
  /^\x1b\[\d+~$/,                      // Function/nav keys: ESC[1~ through ESC[24~
  /^\x1b\[\d+;\d+~$/,                  // Modified function keys: ESC[1;5~ (Ctrl+Home, etc.)
  /^\x1b\[1;\d+[A-D]$/,                // Modified arrows: ESC[1;5A (Ctrl+Up, etc.)
  /^\x1bO[PQRS]$/,                     // F1-F4 alternate: ESCOP, ESCOQ, ESCOR, ESCOS
  /^\x1b\[\d+;\d+[HF]$/,               // Modified Home/End
  /^\x7f$/,                            // Backspace (DEL)
  // Mouse clicks (SGR format): ESC[<button;x;yM (press) or m (release)
  // Button 0=left, 1=middle, 2=right. Buttons 32+ are motion (excluded).
  /^\x1b\[<[0-2];\d+;\d+[Mm]$/,        // Mouse click press/release (buttons 0-2)
  /^\x1b\[<6[4-5];\d+;\d+[Mm]$/,       // Mouse scroll wheel (buttons 64-65)
];

function isUserInput(input: string): boolean {
  // Check if input matches any whitelisted pattern
  for (const pattern of USER_INPUT_PATTERNS) {
    if (pattern.test(input)) {
      return true;
    }
  }
  return false;
}

// Handle stdin
process.stdin.on("data", (data) => {
  const input = data.toString();
  if (!input) return;

  const isUser = isUserInput(input);

  // Ctrl+D to detach (keep backend alive)
  if (input === "\x04") {
    shouldReconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    process.stdout.write("\r\n\x1b[90m[hay] Detaching (session continues in background)...\x1b[0m\r\n");
    ws?.close();
    return;
  }

  // Ctrl+Q to detach and kill the session
  if (input === "\x11") {
    shouldReconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    process.stdout.write("\r\n\x1b[90m[hay] Killing session...\x1b[0m\r\n");
    sendMessage({ type: "kill_session" });
    // Give the server a moment to process, then close
    setTimeout(() => ws?.close(), 100);
    return;
  }

  // Ctrl+] to disconnect (standard telnet escape, same as Ctrl+D)
  if (input === "\x1d") {
    shouldReconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    ws?.close();
    return;
  }

  // For user input, send resize BEFORE input so PTY is correct size
  if (isUser) {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    sendMessage({ type: "resize", cols, rows });
  }

  // Then send input to server
  sendMessage({ type: "input", data: input });
});

// Handle terminal resize
process.stdout.on("resize", () => {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  sendMessage({ type: "resize", cols, rows });
});

// Clean exit
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

// Start connection
connect();
