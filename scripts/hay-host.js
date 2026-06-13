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
const FALLBACK_CWD = process.env.HAY_HOST_CWD || process.cwd();

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk.toString();
        });
        req.on('end', () => {
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function normalizeEnv(rawEnv) {
    if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) return undefined;
    const normalized = {};
    for (const [key, value] of Object.entries(rawEnv)) {
        if (!key || typeof key !== 'string') continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            normalized[key] = String(value);
        }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function main() {
    const libPath = path.join(__dirname, '..', 'hay', 'apps', 'server', 'dist', 'lib.js');
    const hay = await import(pathToFileURL(libPath));
    const rooms = new hay.RoomManager(hay.createPty);
    const server = http.createServer(async (req, res) => {
        const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        if (reqUrl.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                capabilities: {
                    localCliCount: true
                }
            }));
            return;
        }
        if (reqUrl.pathname === '/rooms' && req.method === 'GET') {
            const listRooms = typeof rooms.listRooms === 'function' ? rooms.listRooms.bind(rooms) : null;
            const roomSummaries = listRooms ? listRooms() : [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ rooms: roomSummaries }));
            return;
        }
        if (reqUrl.pathname === '/rooms' && req.method === 'POST') {
            try {
                const body = await readJsonBody(req);
                const roomId = hay.sanitizeRoom(body.id);
                if (!roomId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid room id' }));
                    return;
                }
                const colsRaw = Number(body.cols || 80);
                const rowsRaw = Number(body.rows || 24);
                const cols = Number.isFinite(colsRaw) && colsRaw > 0 ? Math.floor(colsRaw) : 80;
                const rows = Number.isFinite(rowsRaw) && rowsRaw > 0 ? Math.floor(rowsRaw) : 24;
                const cwd = typeof body.cwd === 'string' && body.cwd.trim()
                    ? body.cwd
                    : FALLBACK_CWD;
                const shell = typeof body.shell === 'string' && body.shell.trim()
                    ? body.shell
                    : undefined;
                const env = normalizeEnv(body.env);
                const room = rooms.getRoom(roomId, { cols, rows }, { cwd, shell, env });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, room: room.getSummary() }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid room request' }));
            }
            return;
        }
        // On-demand preview source for the session manager: terminal size + a
        // bounded tail of raw output. Rendered to text by the daemon, only when
        // a card is expanded — idle/unwatched rooms do no work here.
        const previewMatch = reqUrl.pathname.match(/^\/rooms\/([^/]+)\/preview$/);
        if (previewMatch && req.method === 'GET') {
            const roomId = hay.sanitizeRoom(decodeURIComponent(previewMatch[1]));
            const getPreview = typeof rooms.getRoomPreviewSource === 'function'
                ? rooms.getRoomPreviewSource.bind(rooms)
                : null;
            const source = roomId && getPreview ? getPreview(roomId) : null;
            if (!source) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Room not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(source));
            return;
        }
        const deleteRoomMatch = reqUrl.pathname.match(/^\/rooms\/([^/]+)$/);
        if (deleteRoomMatch && req.method === 'DELETE') {
            const roomId = hay.sanitizeRoom(decodeURIComponent(deleteRoomMatch[1]));
            if (!roomId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid room id' }));
                return;
            }
            try {
                const exists = typeof rooms.hasRoom === 'function' ? rooms.hasRoom(roomId) : false;
                rooms.closeRoom(roomId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, existed: exists }));
            } catch (err) {
                console.error(`[hay-host] Error closing room "${roomId}":`, err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to close room' }));
            }
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
        const source = wsUrl.searchParams.get('source') || '';
        const colsRaw = Number(wsUrl.searchParams.get('cols') || 80);
        const rowsRaw = Number(wsUrl.searchParams.get('rows') || 24);
        const cols = Number.isFinite(colsRaw) ? colsRaw : 80;
        const rows = Number.isFinite(rowsRaw) ? rowsRaw : 24;
        const cwd = wsUrl.searchParams.get('cwd');
        if (!cwd) {
            console.error(`[hay-host] WARNING: no cwd query param for room "${roomId}", falling back to ${FALLBACK_CWD}`);
        }
        const room = rooms.getRoom(roomId, { cols, rows }, cwd || FALLBACK_CWD);

        room.attachClient(
            {
                id: randomUUID(),
                name,
                source,
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

process.on('uncaughtException', (err) => {
    console.error('[hay-host] uncaughtException (kept alive):', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[hay-host] unhandledRejection (kept alive):', reason);
});

main().catch((err) => {
    console.error(`[hay-host] ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
});
