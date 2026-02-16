#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');

const HOST = '127.0.0.1';
const portFromEnv = Number.parseInt(process.env.HAY_HOST_PORT || '', 10);
const PORT = Number.isInteger(portFromEnv) && portFromEnv > 0 ? portFromEnv : 0;
const CWD = process.env.HAY_HOST_CWD || process.cwd();

async function main() {
    const libPath = path.join(__dirname, '..', 'hay', 'apps', 'server', 'dist', 'lib.js');
    const hay = await import(pathToFileURL(libPath));
    const rooms = new hay.RoomManager(hay.createPty, CWD);
    const server = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const wsUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        if (wsUrl.pathname !== '/ws') {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', (ws, req) => {
        const wsUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        const roomId = hay.sanitizeRoom(wsUrl.searchParams.get('room'));
        const name = hay.sanitizeName(wsUrl.searchParams.get('name'));
        const colsRaw = Number(wsUrl.searchParams.get('cols') || 80);
        const rowsRaw = Number(wsUrl.searchParams.get('rows') || 24);
        const cols = Number.isFinite(colsRaw) ? colsRaw : 80;
        const rows = Number.isFinite(rowsRaw) ? rowsRaw : 24;
        const room = rooms.getRoom(roomId, { cols, rows });

        room.attachClient(
            {
                id: randomUUID(),
                name,
                colorIndex: Math.floor(Math.random() * 1000),
                cols,
                rows
            },
            hay.createSocketAdapter(ws)
        );
    });

    const shutdown = () => {
        try {
            rooms.closeAll();
        } catch (e) { }
        try {
            wss.close();
        } catch (e) { }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500).unref();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    server.listen(PORT, HOST, () => {
        const address = server.address();
        const listeningPort = address && typeof address === 'object' ? address.port : PORT;
        process.stdout.write(`${JSON.stringify({ pid: process.pid, port: listeningPort })}\n`);
    });
}

main().catch((err) => {
    console.error(`[hay-host] ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
});
