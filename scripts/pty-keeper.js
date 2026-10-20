#!/usr/bin/env node
'use strict';
// pty-keeper — the process that OWNS hop's terminals, so the hay-host (rooms,
// sizes, sockets, snapshots: everything that changes often) can restart
// without killing a single agent. Since July, 41 commits touched host code and
// 3 touched how terminals are spawned; this file is the part that should
// almost never change. Keep it small, dependency-light, and boring.
//
// Protocol: newline-delimited JSON over a Unix socket ($HOP_HOME/pty-keeper.sock,
// mode 0600). One host connection at a time; a new connection replaces the old.
//   host → keeper
//     {op:"hello"}                                  → {op:"hello", version, pid}
//     {op:"spawn", id, file, args, cwd, env, cols, rows, req}
//                                                   → {op:"spawned", id, pid, req} | {op:"error", req, error}
//     {op:"write", id, data}
//     {op:"resize", id, cols, rows}
//     {op:"kill", id, signal?}
//     {op:"list", req}                              → {op:"list", req, items:[{id,pid,cols,rows,cwd,exited,startedAt,bytes}]}
//     {op:"replay", id, req}                        → {op:"replay", req, id, data}
//     {op:"forget", id}                             (drop an exited entry)
//     {op:"shutdown"}                               (kill every terminal, exit — `hop stop --all`)
//   keeper → host
//     {op:"data", id, data}  {op:"exit", id, exitCode, signal}
// Output keeps flowing into a per-terminal ring while no host is connected, so
// whatever happened during a host restart is replayed when it comes back.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const VERSION = 1;
const HOME = process.env.HOP_HOME || path.join(os.homedir(), '.hop2');
const SOCK = process.env.HOP_PTY_KEEPER_SOCK || path.join(HOME, 'pty-keeper.sock');
const STATE = path.join(path.dirname(SOCK), '.pty-keeper-state');
const RING_BYTES = Number(process.env.HOP_PTY_KEEPER_RING) > 0 ? Number(process.env.HOP_PTY_KEEPER_RING) : 6_000_000;

const ptyLib = (() => {
    const candidates = [
        path.join(__dirname, '..', 'hay', 'node_modules', 'node-pty-prebuilt-multiarch'),
        path.join(__dirname, '..', 'node_modules', 'node-pty-prebuilt-multiarch'),
        'node-pty-prebuilt-multiarch'
    ];
    for (const c of candidates) {
        try { return require(c); } catch (e) { /* next */ }
    }
    throw new Error('node-pty-prebuilt-multiarch not found');
})();

const log = (m) => process.stdout.write(`[${new Date().toISOString()}] [pty-keeper] ${m}\n`);

/** id → { pty, pid, cols, rows, cwd, chunks:[], bytes, exited, startedAt } */
const terms = new Map();
let host = null;            // the ONE socket that said hello as {role:"host"}

// Replies go to whoever asked; terminal output and exits go to the host only.
// A control connection (`hop stop --all`, a probe, a test) never displaces
// the host — that once silently cut a live host off from every terminal.
const reply = (sock, msg) => {
    if (!sock || sock.destroyed) return;
    try { sock.write(JSON.stringify(msg) + '\n'); } catch (e) { /* gone */ }
};
const send = (msg) => reply(host, msg);

const appendRing = (t, data) => {
    t.chunks.push(data);
    t.bytes += data.length;
    while (t.chunks.length > 1 && t.bytes - t.chunks[0].length >= RING_BYTES) {
        t.bytes -= t.chunks[0].length;
        t.chunks.shift();
    }
    if (t.chunks.length === 1 && t.bytes > RING_BYTES) {
        t.chunks[0] = t.chunks[0].slice(-RING_BYTES);
        t.bytes = t.chunks[0].length;
    }
};

function spawnTerm(msg) {
    const id = String(msg.id || '');
    if (!id) throw new Error('missing id');
    const existing = terms.get(id);
    if (existing && !existing.exited) throw new Error(`terminal ${id} already running (pid ${existing.pid})`);
    const cols = Math.max(2, Math.floor(Number(msg.cols) || 80));
    const rows = Math.max(2, Math.floor(Number(msg.rows) || 24));
    const pty = ptyLib.spawn(String(msg.file), Array.isArray(msg.args) ? msg.args.map(String) : [], {
        name: 'xterm-256color',
        cols, rows,
        cwd: String(msg.cwd || os.homedir()),
        env: msg.env && typeof msg.env === 'object' ? msg.env : process.env
    });
    const t = { pty, pid: pty.pid, cols, rows, cwd: String(msg.cwd || ''), chunks: [], bytes: 0, exited: null, startedAt: Date.now() };
    terms.set(id, t);
    pty.onData((data) => {
        appendRing(t, data);
        send({ op: 'data', id, data });
    });
    pty.onExit(({ exitCode, signal }) => {
        t.exited = { exitCode: exitCode ?? null, signal: signal ?? null, at: Date.now() };
        log(`terminal ${id} exited code=${exitCode} signal=${signal}`);
        send({ op: 'exit', id, exitCode: exitCode ?? null, signal: signal ?? null });
    });
    log(`spawned ${id} pid=${pty.pid} ${cols}x${rows}`);
    return t;
}

function handle(msg, sock) {
    const t = msg.id !== undefined ? terms.get(String(msg.id)) : undefined;
    switch (msg.op) {
        case 'hello':
            if (msg.role === 'host') {
                if (host && host !== sock && !host.destroyed) {
                    log('a new host replaces the previous one');
                    try { host.destroy(); } catch (e) { /* ignore */ }
                }
                host = sock;
            }
            return reply(sock, { op: 'hello', req: msg.req, version: VERSION, pid: process.pid, terminals: terms.size });
        case 'spawn':
            try {
                const s = spawnTerm(msg);
                reply(sock, { op: 'spawned', id: msg.id, pid: s.pid, req: msg.req });
            } catch (e) {
                reply(sock, { op: 'error', req: msg.req, id: msg.id, error: String(e && e.message || e) });
            }
            return;
        case 'write':
            if (t && !t.exited && typeof msg.data === 'string') { try { t.pty.write(msg.data); } catch (e) { /* dying */ } }
            return;
        case 'resize': {
            const cols = Math.floor(Number(msg.cols)), rows = Math.floor(Number(msg.rows));
            if (t && !t.exited && cols > 0 && rows > 0) {
                try { t.pty.resize(cols, rows); t.cols = cols; t.rows = rows; } catch (e) { /* dying */ }
            }
            return;
        }
        case 'kill':
            if (t && !t.exited) {
                // A signal other than hangup is a forwarded keystroke-like
                // ask (SIGINT…): just that. Ending the terminal ends
                // EVERYTHING on it — see endTerminal.
                if (msg.signal && msg.signal !== 'SIGHUP') { try { t.pty.kill(msg.signal); } catch (e) { /* already gone */ } }
                else endTerminal(t);
            }
            return;
        case 'list':
            return reply(sock, {
                op: 'list', req: msg.req,
                items: [...terms.entries()].map(([id, x]) => ({
                    id, pid: x.pid, cols: x.cols, rows: x.rows, cwd: x.cwd,
                    exited: x.exited, startedAt: x.startedAt, bytes: x.bytes
                }))
            });
        case 'replay': {
            // Bounded: a 6MB replay per terminal × a whole fleet is what made
            // the first live re-adoption crawl. The host asks for what its
            // snapshot can use.
            let data = t ? t.chunks.join('') : '';
            const max = Math.floor(Number(msg.maxBytes) || 0);
            if (max > 0 && data.length > max) data = data.slice(-max);
            return reply(sock, { op: 'replay', req: msg.req, id: msg.id, data });
        }
        case 'forget':
            if (t && t.exited) terms.delete(String(msg.id));
            return;
        case 'shutdown':
            log(`shutdown requested — ending ${terms.size} terminal(s)`);
            for (const x of terms.values()) { if (!x.exited) endTerminal(x); }
            try { sock.end(); } catch (e) { /* ignore */ }
            // Long enough for endTerminal's TERM/KILL follow-up to run.
            setTimeout(() => process.exit(0), terms.size ? 3500 : 300);
            return;
        default:
            return;
    }
}

// Ending a terminal: hang up the shell, then make sure nothing that ran on
// it outlives it. node-pty's kill() is one SIGHUP to the shell's pid, and a
// process that ignores hangup — a TUI agent, a `trap '' HUP` job, anything
// backgrounded — kept running after `hopa term close --killSession`
// (observed: a Codex left alive). The process list is snapshotted BEFORE the
// hangup, because the survivors are reparented to launchd the moment the
// shell dies: every process whose controlling terminal is this pty, plus the
// shell's descendants. Whatever is still alive 1.5s later gets SIGTERM, then
// SIGKILL.
function terminalProcesses(t) {
    const tty = String(t.pty._pty || t.pty.ptsName || '').replace(/^\/dev\//, '');
    let rows = [];
    try {
        rows = require('child_process').execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,tty='], { encoding: 'utf8', timeout: 3000 })
            .split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 3)
            .map(([pid, ppid, tt]) => ({ pid: Number(pid), ppid: Number(ppid), tty: tt }));
    } catch (e) { return []; }
    const keep = new Set([t.pid]);
    if (tty) for (const r of rows) if (r.tty === tty || `tty${r.tty}` === tty || r.tty === tty.replace(/^tty/, '')) keep.add(r.pid);
    for (let grew = true; grew;) {
        grew = false;
        for (const r of rows) if (!keep.has(r.pid) && keep.has(r.ppid)) { keep.add(r.pid); grew = true; }
    }
    keep.delete(process.pid);
    return [...keep].filter((pid) => pid > 1);
}
function endTerminal(t) {
    const pids = terminalProcesses(t);
    try { t.pty.kill(); } catch (e) { /* already gone */ }
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
    const sweep = (sig) => { for (const pid of pids) if (alive(pid)) { try { process.kill(pid, sig); } catch (e) { /* raced */ } } };
    setTimeout(() => {
        const left = pids.filter(alive);
        if (!left.length) return;
        log(`ending terminal pid=${t.pid}: ${left.length} process(es) ignored hangup — SIGTERM`);
        sweep('SIGTERM');
        setTimeout(() => sweep('SIGKILL'), 1500);
    }, 1500);
}

function main() {
    fs.mkdirSync(path.dirname(SOCK), { recursive: true });
    // A stale socket file from a crashed keeper blocks listen(); a LIVE keeper
    // must not be displaced — probe before unlinking.
    const start = () => {
        const server = net.createServer((sock) => {
            sock.setEncoding('utf8');
            let buf = '';
            sock.on('data', (chunk) => {
                buf += chunk;
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch (e) { continue; }
                    try { handle(msg, sock); } catch (e) { log(`handler error: ${e && e.stack || e}`); }
                }
            });
            const gone = () => { if (host === sock) { host = null; log('host disconnected — terminals keep running'); } };
            sock.on('close', gone);
            sock.on('error', gone);
        });
        server.listen(SOCK, () => {
            try { fs.chmodSync(SOCK, 0o600); } catch (e) { /* ignore */ }
            fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, socket: SOCK, version: VERSION, startedAt: Date.now() }), { mode: 0o600 });
            log(`listening on ${SOCK} (pid ${process.pid}, v${VERSION})`);
        });
        server.on('error', (e) => { log(`listen failed: ${e.message}`); process.exit(1); });
    };
    if (fs.existsSync(SOCK)) {
        const probe = net.connect(SOCK);
        probe.on('connect', () => { log('another keeper is already listening — exiting'); probe.destroy(); process.exit(0); });
        probe.on('error', () => { try { fs.unlinkSync(SOCK); } catch (e) { /* ignore */ } start(); });
    } else {
        start();
    }
}

// The keeper's whole job is to outlive everything else: never die on a stray
// error, never on a hangup from the terminal that launched it.
process.on('uncaughtException', (e) => log(`uncaughtException (kept alive): ${e && e.stack || e}`));
process.on('unhandledRejection', (e) => log(`unhandledRejection (kept alive): ${e}`));
process.on('SIGHUP', () => log('SIGHUP ignored'));
process.on('SIGTERM', () => {
    // A bare SIGTERM is not the "end every session" order — that is the
    // explicit {op:"shutdown"}. Ignore it so a process-group sweep of the
    // host can never take the terminals with it.
    log('SIGTERM ignored (send {op:"shutdown"} to stop the keeper)');
});
main();
