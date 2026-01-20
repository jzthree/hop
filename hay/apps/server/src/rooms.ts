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
  isOpen: () => boolean;
};

export type ClientInfo = {
  id: string;
  name: string;
  colorIndex: number;
  cols: number;
  rows: number;
};

const MAX_BUFFER_SIZE = 200_000;
// Keep rooms alive indefinitely; only explicit kill/remove should end a session.
const CLEANUP_DELAY_MS = 0;

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
  private clients = new Map<string, ClientState>();
  private collabMode = true;
  private controllerId: string | null = null;
  private activeClientId: string | null = null;
  private activeCols: number;
  private activeRows: number;
  private outputBuffer = "";
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(id: string, ptyFactory: PtyFactory, initialSize: { cols: number; rows: number }, cwd?: string) {
    super();
    this.id = id;
    this.pty = ptyFactory({ cols: initialSize.cols, rows: initialSize.rows, cwd });
    this.activeCols = initialSize.cols;
    this.activeRows = initialSize.rows;

    this.pty.onData((data: string) => {
      this.outputBuffer = clampBuffer(this.outputBuffer + data);
      this.broadcast({ type: "output", data });
    });
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
      socket.send(JSON.stringify({ type: "snapshot", data: this.outputBuffer } satisfies ServerMessage));
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

  kill() {
    // Cancel any pending cleanup
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Kill the PTY
    this.pty.kill();
    // Close all client connections
    for (const client of this.clients.values()) {
      if (client.socket.isOpen()) {
        client.socket.send(JSON.stringify({ type: "error", message: "Session terminated" } satisfies ServerMessage));
      }
    }
    this.clients.clear();
    // Emit empty to trigger cleanup in RoomManager
    this.emit("empty");
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
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private ptyFactory: PtyFactory;
  private cwd?: string;

  constructor(ptyFactory: PtyFactory, cwd?: string) {
    this.ptyFactory = ptyFactory;
    this.cwd = cwd;
  }

  getRoom(roomId: string, initialSize: { cols: number; rows: number }) {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }
    const room = new Room(roomId, this.ptyFactory, initialSize, this.cwd);
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
}
