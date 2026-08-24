#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');

// Timestamp every log line: freeze forensics are impossible without knowing
// WHEN "[hay] PTY exit ..." happened relative to a reported hang.
for (const level of ['log', 'error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(`[${new Date().toISOString()}]`, ...args);
}

// Event-loop lag watchdog: the host is single-threaded — any synchronous work
// (pty spawns, giant string ops) freezes EVERY session at once. A 50ms
// heartbeat that arrives late tells us the loop was blocked and for how long;
// with timestamps we can correlate against room lifecycle lines. (A live
// incident froze the loop for 10-18s with nothing in the log to show for it.)
{
    const HEARTBEAT_MS = 50;
    const REPORT_STALL_MS = 250;
    const memLine = () => {
        const m = process.memoryUsage();
        const mb = (n) => Math.round(n / 1048576);
        return `rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ext=${mb(m.external)}MB`;
    };
    let last = Date.now();
    setInterval(() => {
        const nowTs = Date.now();
        const lag = nowTs - last - HEARTBEAT_MS;
        if (lag > REPORT_STALL_MS) {
            // Memory on every stall line: the 2026-07-23 death spiral (stalls
            // growing 500ms -> 18s over two minutes until the daemon shot the
            // host) left no way to tell a heap/GC spiral from CPU-bound work.
            console.error(`[hay-host] event-loop stalled ~${lag}ms ${memLine()}`);
        }
        last = nowTs;
    }, HEARTBEAT_MS).unref();
    // Hourly baseline so a slow leak is visible before it becomes a stall.
    setInterval(() => console.error(`[hay-host] mem ${memLine()}`), 3600_000).unref();
    setTimeout(() => console.error(`[hay-host] mem ${memLine()}`), 30_000).unref();
}

const HOST = '127.0.0.1';
const portFromEnv = Number.parseInt(process.env.HAY_HOST_PORT || '', 10);
const PORT = Number.isInteger(portFromEnv) && portFromEnv > 0 ? portFromEnv : 0;
const FALLBACK_CWD = process.env.HAY_HOST_CWD || process.cwd();

// Where we stash each room's tail buffer on shutdown so `hop restore` can replay
// a plain-shell session's last screen. Mirrors the daemon's HOP_HOME (~/.hop2).
const HOP_HOME = process.env.HOP_HOME || path.join(os.homedir(), '.hop2');

// EPHEMERAL homes die with their daemon. Integration tests spawn a daemon in
// a mkdtemp HOP_HOME, which spawns this host — and a test run killed
// mid-flight (a timeout, a crash) leaked the host forever: 18 of them were
// found idling with 242MB after a week of test runs. A host under the OS
// temp dir polls its daemon's pid from .tunnel-state and exits once it has
// been gone for two checks. A REAL home never does this: the production
// host deliberately outlives daemon restarts — that is what keeps sessions
// alive through deploys.
if (HOP_HOME.startsWith(os.tmpdir())) {
  let daemonMissing = 0;
  setInterval(() => {
    let pid = null;
    try { pid = Number(JSON.parse(fs.readFileSync(path.join(HOP_HOME, '.tunnel-state'), 'utf8')).pid); } catch (e) { /* not written yet */ }
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch (e) { /* dead */ }
    }
    daemonMissing = alive ? 0 : daemonMissing + 1;
    if (daemonMissing >= 2) {
      console.error('[hay-host] ephemeral home and the daemon is gone — exiting');
      process.exit(0);
    }
  }, 30000).unref();
}
const BUFFER_DIR = path.join(HOP_HOME, 'session-buffers');
const CLAUDE_SESSIONS_DIR = path.join(HOP_HOME, 'claude-sessions');

// Scrub Claude Code SESSION markers from our environment before any PTY is
// spawned. If hop was ever (re)started from inside a Claude Code session,
// these inherited markers make every claude launched in a hop session think
// it is a child session — and SILENTLY DISABLE TRANSCRIPT SAVING (breaking
// hop restore's --resume and losing history). CLAUDE_CONFIG_DIR is scrubbed
// too: it is the PARENT session's config root (e.g. ~/.claude_fable when hop
// was restarted from a fable session), and inheriting it sent every restored
// `claude --resume` to the wrong root ("No conversation found", 2026-07-23).
// A hop PTY runs a login shell, so a config dir the user actually wants comes
// back via their shell rc. Auth vars (CLAUDE_CODE_OAUTH_TOKEN*) are kept.
// Color suppressors belong to whatever launched us (an agent's tool shell
// sets NO_COLOR=1 for machine-readable output), never to the interactive
// terminals we host. Scrub at the host root so every PTY starts clean.
delete process.env.NO_COLOR;
if (process.env.FORCE_COLOR === '0') delete process.env.FORCE_COLOR;

for (const key of Object.keys(process.env)) {
    if (key === 'CLAUDECODE' || key === 'CLAUDE_EFFORT' ||
        key === 'CLAUDE_CONFIG_DIR' || key === 'CLAUDE_PID' ||
        (key.startsWith('CLAUDE_CODE_') && !key.startsWith('CLAUDE_CODE_OAUTH_TOKEN'))) {
        delete process.env[key];
    }
}

// A recorded cwd can stop existing (deleted temp dir, unmounted volume).
// Spawning a PTY there dies instantly with exit 1, and recreate loops churn
// forever. Fall back to $HOME and let the shell say so via the room name.
function existingCwdOr(cwd, fallback) {
    if (typeof cwd === 'string' && cwd) {
        try { if (fs.statSync(cwd).isDirectory()) return cwd; } catch (e) { /* gone */ }
        console.log(`[hay-host] cwd missing for new room, falling back to home: ${cwd}`);
    }
    return fallback;
}

// True once the host starts shutting down. Rooms killed by shutdown must KEEP
// their restore records — surviving a host stop is exactly what `hop restore`
// is for. Only rooms that end while the host stays up (pty exit, explicit
// kill) are truly over and must not be resurrected.
let shuttingDown = false;

// When a room ends, the ONLY thing safe to drop is the transient replay
// buffer. The restore records (.json SessionStart, .turn counter, .meta) are
// deliberately KEPT: a PTY exit is not consent to forget the conversation —
// it may be a crash, a SIGKILL, an app closing, or a relaunch-teardown, and
// deleting the records made the session unrestorable (hopboard, 2026-08-24:
// a killed shell nuked its own records, then reopened as a bare shell with
// its conversation orphaned). Records are removed in exactly ONE place now:
// an EXPLICIT user delete, daemon-side (removeClaudeSessionRecord). A stale
// record for a truly-finished session is harmless — restore re-checks
// liveness and the transcript, and the user can delete what they don't want.
const watchedRooms = new WeakSet();
// Room ids the daemon is closing in order to RELAUNCH (targeted `hop
// restore <name>`): their records must survive the close, exactly as they
// survive a host shutdown. Consumed once, on the next session_end.
const preserveRecordsOnClose = new Set();
function watchRoomEnd(room) {
    if (!room || typeof room.on !== 'function' || watchedRooms.has(room)) return room;
    watchedRooms.add(room);
    room.on('session_end', () => {
        if (shuttingDown) return;
        const id = String(room.id || '');
        if (!/^[A-Za-z0-9_.-]+$/.test(id)) return; // never let an id escape the dirs
        // A relaunch-close keeps even the buffer: the daemon is about to bring
        // this same session back with `claude --resume`.
        if (preserveRecordsOnClose.delete(id)) return;
        // Restore records are NEVER deleted here — only the stale replay
        // buffer. See the note on watchedRooms above: a room ending is not a
        // request to forget its conversation; that is an explicit delete's
        // job, daemon-side.
        try { fs.unlinkSync(path.join(BUFFER_DIR, `${id}.raw`)); } catch (e) { /* best effort */ }
    });
    return room;
}

// Persist live rooms' tail output, called on graceful shutdown (before the PTYs
// are killed). Best-effort: any failure here must not block the shutdown path.
function persistRoomBuffers(rooms) {
    if (typeof rooms.getPersistableBuffers !== 'function') return;
    let buffers;
    try {
        buffers = rooms.getPersistableBuffers();
    } catch (e) {
        return;
    }
    if (!buffers || !buffers.length) return;
    try {
        fs.mkdirSync(BUFFER_DIR, { recursive: true });
    } catch (e) {
        return;
    }
    for (const { id, output } of buffers) {
        if (!id || !output) continue;
        if (!/^[A-Za-z0-9_.-]+$/.test(id)) continue; // never let an id escape BUFFER_DIR
        try {
            fs.writeFileSync(path.join(BUFFER_DIR, `${id}.raw`), output, { mode: 0o600 });
        } catch (e) {
            /* skip this room, keep persisting the rest */
        }
    }
}

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
                    localCliCount: true,
                    outputSince: true
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
                const seedOutput = typeof body.seedOutput === 'string' && body.seedOutput
                    ? body.seedOutput
                    : undefined;
                const __t0 = Date.now();
                // `command`: launch the room ON this command (argv) rather
                // than typing it in after the shell is up — see pty.ts.
                const command = typeof body.command === 'string' && body.command.trim() ? body.command : undefined;
                const room = watchRoomEnd(rooms.getRoom(roomId, { cols, rows }, { cwd: existingCwdOr(cwd, FALLBACK_CWD), shell, env, seedOutput, command }));
                if (Date.now() - __t0 > 100) console.log(`[hay-host] slow room create (POST) room=${roomId} ${Date.now() - __t0}ms`);
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
        // Serialized screen at ROOM-TRUE geometry — the same bytes and dims a
        // live attach snapshots. The daemon serves tile previews from this so
        // a preview and the terminal it becomes cannot disagree.
        const serializedMatch = reqUrl.pathname.match(/^\/rooms\/([^/]+)\/serialized$/);
        if (serializedMatch && req.method === 'GET') {
            const roomId = hay.sanitizeRoom(decodeURIComponent(serializedMatch[1]));
            const fn = typeof rooms.serializeRoomScreen === 'function'
                ? rooms.serializeRoomScreen.bind(rooms)
                : null;
            if (!roomId || !fn) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
                return;
            }
            await new Promise((resolve) => {
                let done = false;
                const finish = (code, body) => {
                    if (done) return;
                    done = true;
                    res.writeHead(code, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(body));
                    resolve();
                };
                const guard = setTimeout(() => finish(504, { error: 'Serialize timed out' }), 5000);
                fn(roomId, (result) => {
                    clearTimeout(guard);
                    if (!result) finish(404, { error: 'No screen available' });
                    else finish(200, result);
                });
            });
            return;
        }
        const previewMatch = reqUrl.pathname.match(/^\/rooms\/([^/]+)\/preview$/);
        if (previewMatch && req.method === 'GET') {
            const roomId = hay.sanitizeRoom(decodeURIComponent(previewMatch[1]));
            const getPreview = typeof rooms.getRoomPreviewSource === 'function'
                ? rooms.getRoomPreviewSource.bind(rooms)
                : null;
            // ?bytes= lets the daemon fetch a DEEPER tail when the default
            // 64KB renders sparse (a churning TUI's content can sit far
            // behind its spinner redraws).
            const bytesRaw = Number(reqUrl.searchParams.get('bytes'));
            const bytes = Number.isFinite(bytesRaw) && bytesRaw > 0
                ? Math.min(1048576, Math.floor(bytesRaw))
                : undefined;
            const source = roomId && getPreview ? getPreview(roomId, bytes) : null;
            if (!source) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Room not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(source));
            return;
        }
        // Incremental output for the daemon's persistent preview terminals:
        // ?since= is the absolute cursor returned by the previous call; the
        // response is exactly the chars appended after it (reset:true + a
        // bounded tail when the cursor is stale/unknown). This is what lets
        // previews be parsed incrementally instead of re-cut from a raw tail.
        const outputMatch = reqUrl.pathname.match(/^\/rooms\/([^/]+)\/output$/);
        if (outputMatch && req.method === 'GET') {
            const roomId = hay.sanitizeRoom(decodeURIComponent(outputMatch[1]));
            const getSince = typeof rooms.getRoomOutputSince === 'function'
                ? rooms.getRoomOutputSince.bind(rooms)
                : null;
            // Number(null) is 0 — an ABSENT since must stay undefined (reset
            // semantics), not become a valid cursor at offset 0.
            const sinceParam = reqUrl.searchParams.get('since');
            const sinceRaw = sinceParam === null ? NaN : Number(sinceParam);
            const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : undefined;
            const bytesRaw = Number(reqUrl.searchParams.get('bytes'));
            const bytes = Number.isFinite(bytesRaw) && bytesRaw > 0
                ? Math.min(2097152, Math.floor(bytesRaw))
                : undefined;
            const result = roomId && getSince ? getSince(roomId, since, bytes) : null;
            if (!result) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Room not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
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
                // ?preserve=1: close but keep the restore records — the daemon
                // is relaunching this session, not ending it. Armed before
                // closeRoom so it is set when session_end fires synchronously.
                if (/[?&]preserve=1(&|$)/.test(String(req.url || ''))) preserveRecordsOnClose.add(roomId);
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
        const __t0 = Date.now();
        const room = watchRoomEnd(rooms.getRoom(roomId, { cols, rows }, existingCwdOr(cwd, FALLBACK_CWD)));
        if (Date.now() - __t0 > 100) console.log(`[hay-host] slow room create (ws) room=${roomId} ${Date.now() - __t0}ms`);

        // ABSENT is not ZERO: Number(null) === 0, and 0 is the explicit
        // "no snapshot" contract for claim sockets — so every attach that
        // simply omitted replay= (salvage, CLI reattach) silently got no
        // screen: the 2026-08-17 host cycle salvaged 23 rooms and captured
        // nothing, each waiting out a 20s timeout (the 8-minute freeze).
        const replayParam = wsUrl.searchParams.get('replay');
        const replayRaw = replayParam === null || replayParam === '' ? NaN : Number(replayParam);
        // The viewer's actual terminal colors (hex, no '#'). TUI apps pick a
        // light or dark theme from the background they're told — so a room
        // must report the background the USER is looking at, not a guess.
        // Remembered on the room for the headless answers that come later.
        const hex = (v) => (/^[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v).toLowerCase() : null);
        const clientBg = hex(wsUrl.searchParams.get('bg'));
        const clientFg = hex(wsUrl.searchParams.get('fg'));
        if (clientBg && typeof room.setClientColors === 'function') {
            room.setClientColors(clientBg, clientFg);
        }
        // Tab identity forwarded by the daemon: the room evicts a same-key
        // predecessor on attach, so a phone's reconnect replaces its own
        // ghost in presence instead of standing next to it.
        const deviceKeyRaw = wsUrl.searchParams.get('device') || '';
        const deviceKey = /^[A-Za-z0-9._-]{1,80}$/.test(deviceKeyRaw) ? deviceKeyRaw : '';

        // Liveness: browsers answer protocol pings in the network stack, so
        // silence means the peer is gone (locked phone, network hop) even
        // though no close frame ever arrived — through the tunnel that can
        // outlive the client by hours. Ghosts die within a minute instead.
        let wsAlive = true;
        ws.on('pong', () => { wsAlive = true; });
        const wsHeartbeat = setInterval(() => {
            if (ws.readyState !== ws.OPEN) { clearInterval(wsHeartbeat); return; }
            if (!wsAlive) {
                clearInterval(wsHeartbeat);
                try { ws.terminate(); } catch (e) { /* already gone */ }
                return;
            }
            wsAlive = false;
            try { ws.ping(); } catch (e) { /* closing */ }
        }, 30000);
        ws.on('close', () => clearInterval(wsHeartbeat));

        room.attachClient(
            {
                id: randomUUID(),
                name,
                source,
                deviceKey,
                colorIndex: Math.floor(Math.random() * 1000),
                cols,
                rows,
                // Per-connection snapshot cap (monitor tiles ask small).
                // 0 passes through as an explicit "no snapshot" — dropping it
                // to undefined made claim sockets pull the full default tail.
                replayBytes: Number.isFinite(replayRaw) && replayRaw >= 0 ? replayRaw : undefined,
                // nudge=0: viewer already shows the current grid (wall tile)
                nudge: wsUrl.searchParams.get('nudge') === '0' ? false : undefined
            },
            hay.createSocketAdapter(ws)
        );
    });

    // Periodic notekeeping: the shutdown handler only runs on a GRACEFUL
    // exit, so a crash (thermal sleep, power cut, SIGKILL) used to leave no
    // buffers at all — `hop restore` had screens to replay only when the
    // stop was polite. Flush the same bounded tails every few minutes; a
    // crash now costs at most the last interval of scrollback.
    const bufferFlushTimer = setInterval(() => {
        if (shuttingDown) return;
        try { persistRoomBuffers(rooms); } catch (e) { /* next tick */ }
    }, 4 * 60 * 1000);
    bufferFlushTimer.unref?.();

    const shutdown = () => {
        shuttingDown = true; // keep restore records for rooms killed by this shutdown
        // Persist tail buffers BEFORE closeAll() kills the PTYs, so a graceful
        // `hop stop --all` leaves something for `hop restore` to replay.
        try {
            persistRoomBuffers(rooms);
        } catch (e) { }
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
