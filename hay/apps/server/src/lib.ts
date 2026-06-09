// Termshare Server Library
// Export everything needed for embedding into other apps

export { Room, RoomManager, type SocketAdapter, type ClientInfo, type RoomSummary } from "./rooms";
export { createPty, type PtyFactory } from "./pty";
export { sanitizeName, sanitizeRoom } from "./utils";

// Re-export shared types
export {
  type ClientMessage,
  type ServerMessage,
  type PresenceClient,
  safeParseClientMessage,
  safeParseServerMessage,
  pickPresenceColor
} from "hay-shared";

import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { RoomManager, type SocketAdapter } from "./rooms";
import { createPty, type PtyFactory } from "./pty";
import { sanitizeName, sanitizeRoom } from "./utils";

export const generateClientId = () => randomUUID();

export const createSocketAdapter = (ws: WebSocket): SocketAdapter => ({
  send: (data: string) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  },
  onMessage: (handler: (data: string) => void) => {
    ws.on("message", (data) => handler(data.toString()));
  },
  onClose: (handler: () => void) => {
    ws.on("close", handler);
  },
  onError: (handler: (err: Error) => void) => {
    ws.on("error", handler);
  },
  close: () => {
    ws.close();
  },
  isOpen: () => ws.readyState === ws.OPEN
});

export type TermshareServerOptions = {
  /** HTTP server to attach WebSocket to */
  server: http.Server;
  /** WebSocket path (default: "/ws") */
  path?: string;
  /** Custom PTY factory (default: native pty) */
  ptyFactory?: PtyFactory;
  /** Working directory for new PTY sessions (default: process.cwd()) */
  cwd?: string;
  /** Called when a client connects */
  onConnect?: (clientId: string, roomId: string, name: string) => void;
  /** Called when a client disconnects */
  onDisconnect?: (clientId: string, roomId: string) => void;
};

/**
 * Attach termshare to an existing HTTP server.
 * This is the main entry point for embedding termshare into other apps.
 *
 * @example
 * ```ts
 * import http from "http";
 * import { attachTermshare } from "@termshare/server";
 *
 * const server = http.createServer();
 * const termshare = attachTermshare({ server });
 *
 * server.listen(4001, () => {
 *   console.log("Server running on http://localhost:4001");
 * });
 * ```
 */
export function attachTermshare(options: TermshareServerOptions) {
  const { server, path = "/ws", ptyFactory = createPty, cwd = process.cwd(), onConnect, onDisconnect } = options;

  const wss = new WebSocketServer({ noServer: true });
  const rooms = new RoomManager(ptyFactory);

  const toSocketAdapter = (ws: WebSocket): SocketAdapter => ({
    send: (data: string) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    },
    onMessage: (handler: (data: string) => void) => {
      ws.on("message", (data) => handler(data.toString()));
    },
    onClose: (handler: () => void) => {
      ws.on("close", handler);
    },
    onError: (handler: (err: Error) => void) => {
      ws.on("error", handler);
    },
    close: () => {
      ws.close();
    },
    isOpen: () => ws.readyState === ws.OPEN
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== path) {
      return; // Let other handlers deal with it
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const roomId = sanitizeRoom(url.searchParams.get("room"));
    const name = sanitizeName(url.searchParams.get("name"));
    const cols = Number(url.searchParams.get("cols") ?? 80);
    const rows = Number(url.searchParams.get("rows") ?? 24);

    const clientId = randomUUID();
    const colorIndex = Math.floor(Math.random() * 1000);

    const roomCwd = url.searchParams.get("cwd") || cwd;
    const room = rooms.getRoom(roomId, {
      cols: Number.isFinite(cols) ? cols : 80,
      rows: Number.isFinite(rows) ? rows : 24
    }, roomCwd);

    room.attachClient(
      {
        id: clientId,
        name,
        colorIndex,
        cols,
        rows
      },
      toSocketAdapter(ws)
    );

    onConnect?.(clientId, roomId, name);

    ws.on("close", () => {
      onDisconnect?.(clientId, roomId);
    });
  });

  return {
    /** The WebSocket server instance */
    wss,
    /** The room manager instance */
    rooms,
    /** Close all connections and clean up */
    close: () => {
      wss.close();
    }
  };
}
