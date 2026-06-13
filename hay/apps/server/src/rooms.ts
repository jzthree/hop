import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { readlink } from "node:fs";
import type { IPty } from "node-pty-prebuilt-multiarch";
import { clientMessageSchema, pickPresenceColor, safeParseClientMessage } from "hay-shared";
import type { ClientMessage, PresenceClient, ServerMessage } from "hay-shared";
import type { PtyFactory } from "./pty";

export type SocketAdapter = {
  send: (data: string) => void;
  onMessage: (handler: (data: string) => void) => void;
  onClose: (handler: () => void) => void;
  onError: (handler: (err: Error) => void) => void;
  close: () => void;
  isOpen: () => boolean;
};

export type ClientInfo = {
  id: string;
  name: string;
  source?: string;
  colorIndex: number;
  cols: number;
  rows: number;
};

export type RoomCreateOptions = {
  cwd: string;
  env?: Record<string, string>;
  shell?: string;
};

export type RoomSummary = {
  id: string;
  cwd: string;
  liveCwd: string;
  foregroundProcess: string;
  clientCount: number;
  localCliCount: number;
};

// Raw output retained for reattach snapshots. ~2MB of raw stream reconstructs
// roughly a full client scrollback (2000-5000 lines) of plain output; TUI
// streams are escape-dense and reconstruct less. Override with
// HAY_SNAPSHOT_BUFFER_BYTES (bytes of raw stream kept per room).
const MAX_BUFFER_SIZE = (() => {
  const env = Number(process.env.HAY_SNAPSHOT_BUFFER_BYTES);
  return Number.isFinite(env) && env > 0 ? env : 2_000_000;
})();
// Keep rooms alive indefinitely; only explicit kill/remove should end a session.
const CLEANUP_DELAY_MS = 0;
const CONTROL_SEQUENCE_TAIL = 32;
const DEBUG_STATE = process.env.HAY_DEBUG === "1";

const now = () => Date.now();

const clampBuffer = (value: string) => {
  if (value.length <= MAX_BUFFER_SIZE) {
    return value;
  }
  return value.slice(value.length - MAX_BUFFER_SIZE);
};

// Build a useful error for a payload that failed schema validation: name the
// message type and the offending field instead of a bare "Invalid message".
const describeInvalidMessage = (payload: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return "Invalid message: not valid JSON";
  }
  const type = typeof (parsed as { type?: unknown })?.type === "string" ? (parsed as { type: string }).type : null;
  if (!type) {
    return "Invalid message: missing type";
  }
  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path?.filter((part) => typeof part === "string").join(".");
    if (field) {
      return `Invalid ${type} message: ${field} ${issue.message.toLowerCase()}`;
    }
    return `Invalid ${type} message`;
  }
  return "Invalid message";
};

const toPresence = (client: ClientState): PresenceClient => ({
  id: client.id,
  name: client.name,
  color: client.color,
  typing: client.typing,
  lastActive: client.lastActive
});

class ClientState {
  id: string;
  name: string;
  color: string;
  typing = false;
  lastActive = now();
  // Timestamp of this client's last real keystroke input (not resize, not the
  // typing indicator, not connect). 0 = has never typed. Drives the active PTY
  // size election so size follows the active typer, not whoever last resized.
  lastInputAt = 0;
  socket: SocketAdapter;
  source: string;
  cols: number;
  rows: number;

  constructor(info: ClientInfo, socket: SocketAdapter) {
    this.id = info.id;
    this.name = info.name;
    this.source = info.source || "";
    this.color = pickPresenceColor(info.colorIndex);
    this.socket = socket;
    this.cols = info.cols;
    this.rows = info.rows;
  }
}

export class Room extends EventEmitter {
  id: string;
  private pty: IPty;
  private readonly initialCwd: string;
  private liveCwd: string;
  private foregroundProcess = "";
  private clients = new Map<string, ClientState>();
  private collabMode = true;
  private controllerId: string | null = null;
  private activeClientId: string | null = null;
  private activeCols: number;
  private activeRows: number;
  private outputBuffer = "";
  private alternateScreen = false;
  private cursorHidden = false;
  private controlSequenceTail = "";
  private oscBuffer = "";
  private cleanupTimer: NodeJS.Timeout | null = null;
  private ended = false;
  private cwdPollTimer: NodeJS.Timeout | null = null;
  // False until the first client attaches: that client is the one whose
  // connect created the room, so its hello carries created=true.
  private hasHadClient = false;

  constructor(id: string, ptyFactory: PtyFactory, initialSize: { cols: number; rows: number }, options: RoomCreateOptions) {
    super();
    this.id = id;
    this.initialCwd = options.cwd;
    this.liveCwd = options.cwd;
    this.pty = ptyFactory({
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: options.cwd,
      env: options.env,
      shell: options.shell
    });
    this.activeCols = initialSize.cols;
    this.activeRows = initialSize.rows;

    this.pty.onData((data: string) => {
      this.outputBuffer = clampBuffer(this.outputBuffer + data);
      this.updateTerminalState(data);
      this.broadcast({ type: "output", data });
      this.emit("pty_output", { roomId: this.id, data, timestamp: now() });
    });

    const handleExit = (exitCode?: number | null, signal?: number | string) => {
      const normalizedExit = Number.isFinite(exitCode) ? Number(exitCode) : null;
      const normalizedSignal = signal !== undefined && signal !== null ? String(signal) : null;
      console.log(
        `[hay] PTY exit room=${this.id} code=${normalizedExit ?? "null"} signal=${normalizedSignal ?? "null"}`
      );
      this.endSession({
        exitCode: normalizedExit,
        signal: normalizedSignal,
        message: "Session ended"
      });
    };

    if (typeof this.pty.onExit === "function") {
      this.pty.onExit((event) => {
        handleExit(event.exitCode, event.signal);
      });
    }

    const legacyOn = (this.pty as unknown as { on?: (event: string, handler: (...args: any[]) => void) => void }).on;
    if (typeof legacyOn === "function") {
      legacyOn.call(this.pty, "exit", (exitCode: number, signal?: number) => {
        handleExit(exitCode, signal);
      });
    }

    // Start PID-based cwd polling as fallback for shells without OSC 7
    this.startCwdPolling();
  }

  attachClient(info: ClientInfo, socket: SocketAdapter) {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const client = new ClientState(info, socket);
    this.clients.set(client.id, client);
    const created = !this.hasHadClient;
    this.hasHadClient = true;

    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: client.id,
        roomId: this.id,
        color: client.color,
        collabMode: this.collabMode,
        controllerId: this.controllerId,
        created
      } satisfies ServerMessage)
    );

    socket.send(
      JSON.stringify({
        type: "active_size",
        clientId: this.activeClientId ?? client.id,
        cols: this.activeCols,
        rows: this.activeRows
      } satisfies ServerMessage)
    );

    if (this.outputBuffer) {
      socket.send(JSON.stringify({
        type: "snapshot",
        data: this.outputBuffer,
        alternateScreen: this.alternateScreen,
        cursorHidden: this.cursorHidden
      } satisfies ServerMessage));
    }

    // Send current cwd to the new client
    socket.send(JSON.stringify({
      type: "cwd_changed",
      cwd: this.liveCwd
    } satisfies ServerMessage));

    this.broadcastPresence();

    socket.onMessage((payload) => {
      const message = safeParseClientMessage(payload);
      if (!message) {
        socket.send(JSON.stringify({ type: "error", message: describeInvalidMessage(payload) } satisfies ServerMessage));
        return;
      }
      this.handleMessage(client.id, message);
    });

    socket.onClose(() => {
      this.removeClient(client.id);
    });

    socket.onError(() => {
      this.removeClient(client.id);
    });
  }

  private handleMessage(clientId: string, message: ClientMessage) {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    switch (message.type) {
      case "input":
        this.handleInput(client, message.data);
        break;
      case "resize":
        this.handleResize(client, message.cols, message.rows);
        break;
      case "typing":
        client.typing = message.active;
        client.lastActive = now();
        this.broadcastPresence();
        break;
      case "toggle_collab":
        this.collabMode = message.enabled;
        this.controllerId = message.enabled ? null : clientId;
        this.broadcastCollab();
        break;
      case "take_control":
        this.collabMode = false;
        this.controllerId = clientId;
        this.broadcastCollab();
        break;
      case "release_control":
        if (this.controllerId === clientId) {
          this.collabMode = true;
          this.controllerId = null;
          this.broadcastCollab();
        }
        break;
      case "ping":
        client.socket.send(JSON.stringify({ type: "pong", t: message.t } satisfies ServerMessage));
        break;
      case "kill_session":
        this.kill(client.name);
        break;
      default:
        break;
    }
  }

  private updateTerminalState(data: string) {
    const combined = this.controlSequenceTail + data;

    // Parse CSI mode sequences (cursor visibility, alternate screen)
    const regex = /\x1b\[\?([0-9;]*)([hl])/g;
    let match: RegExpExecArray | null;
    let nextAlternate = this.alternateScreen;
    let nextCursorHidden = this.cursorHidden;

    while ((match = regex.exec(combined)) !== null) {
      const params = match[1].split(";").filter(Boolean);
      const mode = match[2];
      for (const param of params) {
        if (param === "25") {
          nextCursorHidden = mode === "l";
        } else if (param === "47" || param === "1047" || param === "1049") {
          nextAlternate = mode === "h";
        }
      }
    }

    let stateChanged = false;
    if (nextAlternate !== this.alternateScreen) {
      if (DEBUG_STATE) {
        console.log(`[hay] room=${this.id} alternateScreen=${nextAlternate}`);
      }
      this.alternateScreen = nextAlternate;
      stateChanged = true;
    }
    if (nextCursorHidden !== this.cursorHidden) {
      if (DEBUG_STATE) {
        console.log(`[hay] room=${this.id} cursorHidden=${nextCursorHidden}`);
      }
      this.cursorHidden = nextCursorHidden;
      stateChanged = true;
    }

    if (stateChanged) {
      this.emit("pty_state", {
        roomId: this.id,
        alternateScreen: this.alternateScreen,
        cursorHidden: this.cursorHidden,
        timestamp: now()
      });
    }

    // Parse OSC 7 — only scan when ESC is present (fast path: skip most data chunks)
    if (data.includes("\x1b]7;") || this.oscBuffer) {
      this.parseOsc7(data);
    }

    this.controlSequenceTail = combined.slice(-CONTROL_SEQUENCE_TAIL);
  }

  // Regex: matches OSC 7 with BEL (\x07) or ST (\x1b\\) terminator
  private static readonly OSC7_RE = /\x1b\]7;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

  private parseOsc7(data: string) {
    const chunk = this.oscBuffer + data;
    this.oscBuffer = "";

    // Fast regex scan — no allocations when there's no match
    Room.OSC7_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = Room.OSC7_RE.exec(chunk)) !== null) {
      this.handleOsc7Uri(match[1]);
    }

    // Check for a partial OSC 7 at the end of the chunk (split across packets)
    const tailIdx = chunk.lastIndexOf("\x1b]7;");
    if (tailIdx !== -1) {
      const tail = chunk.slice(tailIdx);
      // If the regex didn't consume this position, it's incomplete
      if (tail.indexOf("\x07") === -1 && tail.indexOf("\x1b\\") === -1 && tail.length < 512) {
        this.oscBuffer = tail;
      }
    }
  }

  private handleOsc7Uri(uri: string) {
    // Parse file://hostname/path URI
    try {
      let cwdPath: string;
      if (uri.startsWith("file://")) {
        // Extract path portion, skipping hostname
        const withoutScheme = uri.slice(7);
        const slashIdx = withoutScheme.indexOf("/");
        if (slashIdx === -1) return;
        cwdPath = decodeURIComponent(withoutScheme.slice(slashIdx));
      } else if (uri.startsWith("/")) {
        cwdPath = decodeURIComponent(uri);
      } else {
        return;
      }

      if (cwdPath && cwdPath !== this.liveCwd) {
        if (DEBUG_STATE) {
          console.log(`[hay] room=${this.id} cwd=${cwdPath}`);
        }
        this.liveCwd = cwdPath;
        this.broadcast({ type: "cwd_changed", cwd: cwdPath });
        this.emit("cwd_changed", { roomId: this.id, cwd: cwdPath, timestamp: now() });
      }
    } catch {
      // Malformed URI — ignore
    }
  }

  /**
   * Start polling PID-based cwd as fallback for shells that don't emit OSC 7.
   * Uses a long interval to avoid system overhead (lsof is expensive on macOS).
   * OSC 7 parsing is the primary mechanism; this is a best-effort fallback.
   */
  startCwdPolling(intervalMs = 15000) {
    this.stopCwdPolling();
    const pid = (this.pty as unknown as { pid?: number }).pid;
    if (!pid) return;

    const updateCwd = (cwdPath: string) => {
      if (cwdPath && cwdPath !== this.liveCwd) {
        if (DEBUG_STATE) {
          console.log(`[hay] room=${this.id} cwd(poll)=${cwdPath}`);
        }
        this.liveCwd = cwdPath;
        this.broadcast({ type: "cwd_changed", cwd: cwdPath });
        this.emit("cwd_changed", { roomId: this.id, cwd: cwdPath, timestamp: now() });
      }
    };

    const poll = () => {
      if (this.ended) return;
      // node-pty exposes the foreground process name (already short, e.g. "vim",
      // "node", "claude"); cheap getter, sampled on the same cadence as cwd.
      const fg = (this.pty as unknown as { process?: string }).process;
      if (typeof fg === "string" && fg) {
        this.foregroundProcess = fg.replace(/^-/, ""); // strip login-shell "-zsh" dash
      }
      if (process.platform === "darwin") {
        execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 5000 }, (err, stdout) => {
          if (err || !stdout) return;
          for (const line of stdout.split("\n")) {
            if (line.startsWith("n/")) {
              updateCwd(line.slice(1));
              break;
            }
          }
        });
      } else if (process.platform === "linux") {
        readlink(`/proc/${pid}/cwd`, (err, target) => {
          if (err || !target) return;
          updateCwd(target);
        });
      }
    };

    this.cwdPollTimer = setInterval(poll, intervalMs);
    // Initial poll with a generous delay to not interfere with startup
    setTimeout(poll, 3000);
  }

  stopCwdPolling() {
    if (this.cwdPollTimer) {
      clearInterval(this.cwdPollTimer);
      this.cwdPollTimer = null;
    }
  }

  kill(by?: string) {
    this.stopCwdPolling();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    try {
      this.pty.kill();
    } catch (e) {
      /* swallow – PTY may already be dead */
    }
    this.endSession({ exitCode: null, signal: null, message: "Session terminated", by });
  }

  notifySessionRenamed(displayName: string) {
    this.broadcast({ type: "session_renamed", displayName });
  }

  sendSystemInput(data: string, source = "system") {
    if (!data) return;
    this.pty.write(data);
    this.emit("pty_input", {
      roomId: this.id,
      clientId: null,
      actor: "system",
      source,
      data,
      timestamp: now()
    });
  }

  private handleInput(client: ClientState, data: string) {
    if (!this.collabMode && this.controllerId !== client.id) {
      client.socket.send(
        JSON.stringify({ type: "input_rejected", reason: "Control is locked" } satisfies ServerMessage)
      );
      return;
    }
    client.lastActive = now();
    client.lastInputAt = now();
    this.pty.write(data);
    this.emit("pty_input", { roomId: this.id, clientId: client.id, data, timestamp: now() });
  }

  private handleResize(client: ClientState, cols: number, rows: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols < 1 || cols > 500 || rows < 1 || rows > 200) return;

    client.cols = cols;
    client.rows = rows;
    // The active PTY size follows whoever is actively typing — not whoever last
    // resized. Previously a resize bumped lastActive and then checked "am I the
    // most active?", which was trivially true for the resizer, so every resize
    // won: a passive viewer resizing their window yanked the size from the
    // active typer, and two differently-sized clients flapped. Elect on typing
    // recency (lastInputAt) instead. A client that has never typed (lastInputAt
    // 0) only wins when no one else has typed either — so the first/sole client
    // can still size the PTY before typing.
    const maxInputAt = Math.max(...[...this.clients.values()].map((c) => c.lastInputAt));
    const isActive = client.lastInputAt >= maxInputAt;
    if (isActive) {
      this.pty.resize(cols, rows);
      this.activeCols = cols;
      this.activeRows = rows;
      this.activeClientId = client.id;
      // Broadcast the new active size to other clients so they can adjust
      this.broadcastActiveSize(client);
      this.emit("pty_resize", { roomId: this.id, clientId: client.id, cols, rows, timestamp: now() });
    }
  }

  private broadcastActiveSize(client: ClientState) {
    // Broadcast to OTHER clients (not the one typing)
    const payload = JSON.stringify({
      type: "active_size",
      clientId: client.id,
      cols: client.cols,
      rows: client.rows
    } satisfies ServerMessage);
    for (const c of this.clients.values()) {
      if (c.id !== client.id && c.socket.isOpen()) {
        c.socket.send(payload);
      }
    }
  }

  private broadcast(message: ServerMessage) {
    const payload = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.socket.isOpen()) {
        client.socket.send(payload);
      }
    }
  }

  private broadcastPresence() {
    const clients = [...this.clients.values()].map(toPresence);
    this.broadcast({ type: "presence", clients });
  }

  private broadcastCollab() {
    this.broadcast({ type: "collab", enabled: this.collabMode, controllerId: this.controllerId });
  }

  private removeClient(clientId: string) {
    const wasController = this.controllerId === clientId;
    this.clients.delete(clientId);
    if (wasController && !this.collabMode) {
      this.collabMode = true;
      this.controllerId = null;
      this.broadcastCollab();
    }
    this.broadcastPresence();
    this.scheduleCleanup();
  }

  private scheduleCleanup() {
    if (CLEANUP_DELAY_MS <= 0) {
      return;
    }
    if (this.clients.size > 0 || this.cleanupTimer) {
      return;
    }
    this.cleanupTimer = setTimeout(() => {
      if (this.clients.size === 0) {
        this.pty.kill();
        this.emit("empty");
      }
    }, CLEANUP_DELAY_MS);
  }

  private endSession(payload: { exitCode: number | null; signal: string | null; message: string; by?: string }) {
    if (this.ended) return;
    this.ended = true;
    this.stopCwdPolling();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const message = JSON.stringify({ type: "session_ended", ...payload } satisfies ServerMessage);
    for (const client of this.clients.values()) {
      try {
        if (client.socket.isOpen()) {
          client.socket.send(message);
        }
        client.socket.close();
      } catch (e) {
        /* swallow – don't let one bad socket kill the loop */
      }
    }
    this.clients.clear();
    this.emit("session_end", { roomId: this.id, ...payload, timestamp: now() });
    this.emit("empty");
  }

  /**
   * Bounded source for an on-demand screen preview: the terminal's size plus a
   * tail of the raw output (enough to reconstruct the visible screen for the
   * common case of full-repaint TUIs). The actual rendering happens in the
   * daemon, on demand, only when someone is looking — so idle rooms cost nothing.
   */
  getPreviewSource(maxBytes = 65536): { cols: number; rows: number; output: string } {
    const buf = this.outputBuffer;
    const output = buf.length > maxBytes ? buf.slice(buf.length - maxBytes) : buf;
    return { cols: this.activeCols, rows: this.activeRows, output };
  }

  getSummary(): RoomSummary {
    const localCliCount = [...this.clients.values()].filter((client) => client.source === "local-cli").length;
    // Read the foreground process name fresh (cheap getter) so the session
    // manager reflects what's running now; fall back to the last polled sample.
    let foregroundProcess = this.foregroundProcess;
    try {
      const live = (this.pty as unknown as { process?: string }).process;
      if (typeof live === "string" && live) {
        foregroundProcess = live.replace(/^-/, "");
      }
    } catch {
      /* keep the polled fallback */
    }
    return {
      id: this.id,
      cwd: this.initialCwd,
      liveCwd: this.liveCwd,
      foregroundProcess,
      clientCount: this.clients.size,
      localCliCount
    };
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private ptyFactory: PtyFactory;

  constructor(ptyFactory: PtyFactory) {
    this.ptyFactory = ptyFactory;
  }

  getRoom(roomId: string, initialSize: { cols: number; rows: number }, cwdOrOptions: string | RoomCreateOptions) {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }
    const options = typeof cwdOrOptions === "string"
      ? { cwd: cwdOrOptions }
      : cwdOrOptions;
    if (!options.cwd) {
      throw new Error(`[RoomManager] cwd is required when creating room "${roomId}"`);
    }
    const room = new Room(roomId, this.ptyFactory, initialSize, options);
    room.on("empty", () => {
      this.rooms.delete(roomId);
    });
    this.rooms.set(roomId, room);
    return room;
  }

  hasRoom(roomId: string) {
    return this.rooms.has(roomId);
  }

  closeRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    try {
      room.kill();
    } catch (e) {
      /* swallow – ensure we still remove the room from the map */
    }
    this.rooms.delete(roomId);
  }

  closeAll() {
    for (const roomId of this.rooms.keys()) {
      this.closeRoom(roomId);
    }
  }

  getRoomPreviewSource(id: string, maxBytes?: number) {
    const room = this.rooms.get(id);
    return room ? room.getPreviewSource(maxBytes) : null;
  }

  listRooms(): RoomSummary[] {
    return Array.from(this.rooms.values()).map((room) => room.getSummary());
  }
}
