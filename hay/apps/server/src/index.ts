import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { createPty } from "./pty";
import { RoomManager } from "./rooms";
import { sanitizeName, sanitizeRoom } from "./utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4001);
const SERVE_WEB = process.env.SERVE_WEB === "true";
const WEB_DIST_PATH = process.env.WEB_DIST_PATH;
const CWD = process.env.CWD; // Working directory for PTY sessions

const app = express();
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

if (SERVE_WEB && WEB_DIST_PATH) {
  const distPath = path.isAbsolute(WEB_DIST_PATH)
    ? WEB_DIST_PATH
    : path.resolve(__dirname, WEB_DIST_PATH);

  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const rooms = new RoomManager(createPty, CWD);

const toSocketAdapter = (ws: WebSocket) => {
  return {
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
    isOpen: () => ws.readyState === ws.OPEN
  };
};

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
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

  const room = rooms.getRoom(roomId, {
    cols: Number.isFinite(cols) ? cols : 80,
    rows: Number.isFinite(rows) ? rows : 24
  });

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
});

server.listen(PORT, () => {
  console.log(`Termshare server running on http://localhost:${PORT}`);
});
