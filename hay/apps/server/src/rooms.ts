import { EventEmitter } from "node:events";
import type { IPty } from "node-pty-prebuilt-multiarch";
import { pickPresenceColor, safeParseClientMessage } from "hay-shared";
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
  clientCount: number;
};

const MAX_BUFFER_SIZE = 200_000;
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
  socket: SocketAdapter;
  cols: number;
  rows: number;

  constructor(info: ClientInfo, socket: SocketAdapter) {
    this.id = info.id;
    this.name = info.name;
    this.color = pickPresenceColor(info.colorIndex);
    this.socket = socket;
    this.cols = info.cols;
    this.rows = info.rows;
  }
}

export class Room extends EventEmitter {
  id: string;
  private pty: IPty;
  private readonly cwd: string;
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
  private cleanupTimer: NodeJS.Timeout | null = null;
  private ended = false;

  constructor(id: string, ptyFactory: PtyFactory, initialSize: { cols: number; rows: number }, options: RoomCreateOptions) {
    super();
    this.id = id;
    this.cwd = options.cwd;
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
  }

  attachClient(info: ClientInfo, socket: SocketAdapter) {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const client = new ClientState(info, socket);
    this.clients.set(client.id, client);

    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: client.id,
        roomId: this.id,
        color: client.color,
        collabMode: this.collabMode,
        controllerId: this.controllerId
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

    this.broadcastPresence();

    socket.onMessage((payload) => {
      const message = safeParseClientMessage(payload);
      if (!message) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid message" } satisfies ServerMessage));
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
        this.kill();
        break;
      default:
        break;
    }
  }

  private updateTerminalState(data: string) {
    const combined = this.controlSequenceTail + data;
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

    this.controlSequenceTail = combined.slice(-CONTROL_SEQUENCE_TAIL);
  }

  kill() {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.pty.kill();
    this.endSession({ exitCode: null, signal: null, message: "Session terminated" });
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
    this.pty.write(data);
    this.emit("pty_input", { roomId: this.id, clientId: client.id, data, timestamp: now() });
  }

  private handleResize(client: ClientState, cols: number, rows: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols < 1 || cols > 500 || rows < 1 || rows > 200) return;

    client.cols = cols;
    client.rows = rows;
    // Treat resize as activity so the resizer becomes the active size source.
    client.lastActive = now();
    // Only resize PTY if this client is the most recently active (was typing)
    // This prevents disrupting the active typer when others resize their windows
    const isActive = [...this.clients.values()].every(c => c.lastActive <= client.lastActive);
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

  private endSession(payload: { exitCode: number | null; signal: string | null; message: string }) {
    if (this.ended) return;
    this.ended = true;
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const message = JSON.stringify({ type: "session_ended", ...payload } satisfies ServerMessage);
    for (const client of this.clients.values()) {
      if (client.socket.isOpen()) {
        client.socket.send(message);
      }
      client.socket.close();
    }
    this.clients.clear();
    this.emit("session_end", { roomId: this.id, ...payload, timestamp: now() });
    this.emit("empty");
  }

  getSummary(): RoomSummary {
    return {
      id: this.id,
      cwd: this.cwd,
      clientCount: this.clients.size
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
    room.kill();
    this.rooms.delete(roomId);
  }

  closeAll() {
    for (const roomId of this.rooms.keys()) {
      this.closeRoom(roomId);
    }
  }

  listRooms(): RoomSummary[] {
    return Array.from(this.rooms.values()).map((room) => room.getSummary());
  }
}
