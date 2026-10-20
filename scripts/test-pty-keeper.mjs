// End-to-end: a host restart must not touch running terminals.
//   node scripts/test-pty-keeper.mjs
// Runs a keeper + host in a throwaway HOP_HOME (never the real one), starts a
// session with a background ticker, restarts the host, and checks: same shell
// pid, ticker still going (output produced WHILE the host was down is
// replayed), history survives into the new host's snapshot, input works, an
// exit during downtime is noticed, and stop-all ends everything.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'node_modules', 'ws'));

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
// Short path: Unix socket paths are limited to ~104 bytes on macOS.
const home = fs.mkdtempSync('/tmp/hk-');
const port = 40000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, HOP_HOME: home, HAY_HOST_PORT: String(port), HOP_PTY_KEEPER: '1', HAY_HOST_CWD: home };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

const startHost = async () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'hay-host.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    for (let i = 0; i < 100; i++) {
        await sleep(100);
        if (out.includes('"port"')) break;
    }
    return { child, log: () => out };
};
const http = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.json().catch(() => ({}));
};
const keeperOp = (msg) => new Promise((resolve, reject) => {
    const s = net.connect(path.join(home, 'pty-keeper.sock'));
    let buf = '';
    s.on('connect', () => s.write(JSON.stringify({ ...msg, req: 7 }) + '\n'));
    s.on('data', (d) => {
        buf += d;
        for (const line of buf.split('\n')) {
            try { const m = JSON.parse(line); if (m.req === 7) { s.destroy(); resolve(m); } } catch (e) { /* partial */ }
        }
    });
    s.on('error', reject);
    setTimeout(() => { s.destroy(); resolve(null); }, 3000);
});
const attach = (room) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}&name=probe&cols=100&rows=30`);
    let text = '';
    ws.on('message', (raw) => {
        try {
            const m = JSON.parse(raw.toString());
            if (typeof m.data === 'string') text += m.data;
        } catch (e) { /* ignore */ }
    });
    ws.on('open', () => resolve({ ws, text: () => text }));
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

let host;
try {
    host = await startHost();
    check(/started pty-keeper|adopted 0/.test(host.log()), 'host started its keeper');
    await http('POST', '/rooms', { id: 'k1', cols: 100, rows: 30, cwd: home });
    await http('POST', '/rooms', { id: 'k2', cols: 100, rows: 30, cwd: home });
    await sleep(800);
    const a = await attach('k1');
    a.ws.send(JSON.stringify({ type: 'input', data: 'echo before-$((6*7)); (i=0; while true; do i=$((i+1)); echo tick-$i; sleep 0.5; done) &\r' }));
    const b = await attach('k2');
    b.ws.send(JSON.stringify({ type: 'input', data: '(sleep 2; exit) ; exit\r' }));
    await sleep(1500);
    check(a.text().includes('before-42'), 'session ran a command before the restart');
    const list1 = await keeperOp({ op: 'list' });
    const k1 = list1?.items?.find((x) => x.id === 'k1');
    check(!!k1 && alive(k1.pid), `keeper owns k1 (pid ${k1?.pid})`);
    a.ws.close(); b.ws.close();

    // ── restart the host ────────────────────────────────────────────────
    host.child.kill('SIGTERM');
    await sleep(800);
    check(host.child.exitCode !== null || host.child.signalCode !== null, 'old host exited');
    check(k1 && alive(k1.pid), 'k1 shell still running with the host DOWN');
    await sleep(2500);   // ticks accrue + k2 exits while no host exists
    host = await startHost();
    await sleep(500);
    check(/adopted 1 running terminal\(s\), 1 had exited/.test(host.log()), `new host adopted k1 and noticed k2 exited — log: ${(host.log().match(/adopted[^\n]*/) || [''])[0]}`);
    const rooms = await http('GET', '/rooms');
    const ids = (rooms.rooms || rooms || []).map?.((r) => r.id) || [];
    check(ids.includes('k1') && !ids.includes('k2'), `rooms after restart: ${JSON.stringify(ids)}`);
    const list2 = await keeperOp({ op: 'list' });
    const k1b = list2?.items?.find((x) => x.id === 'k1');
    check(k1b && k1b.pid === k1.pid, `same shell pid across the restart (${k1.pid} → ${k1b?.pid})`);

    const c = await attach('k1');
    await sleep(1500);
    const t = c.text();
    check(t.includes('before-42'), 'history from before the restart is in the new snapshot');
    const ticks = [...t.matchAll(/tick-(\d+)/g)].map((m) => Number(m[1]));
    check(ticks.length && Math.max(...ticks) >= 8, `ticker kept counting through the restart (max tick ${Math.max(0, ...ticks)})`);
    c.ws.send(JSON.stringify({ type: 'input', data: 'echo after-$((7*6))\r' }));
    await sleep(800);
    const ticksLive = [...c.text().matchAll(/tick-(\d+)/g)].map((m) => Number(m[1]));
    check(Math.max(0, ...ticksLive) > Math.max(0, ...ticks), `live output flows after the restart (ticks ${Math.max(0, ...ticks)} → ${Math.max(0, ...ticksLive)})`);
    check(c.text().includes('after-42'), 'input works after the restart');
    if (!c.text().includes('after-42')) console.log('TAIL:', JSON.stringify(c.text().slice(-400)));
    c.ws.close();

    // ── ending a terminal ends what ignores hangup too ───────────────────
    // (hopa term close --killSession left a Codex alive: node-pty's kill is
    // one SIGHUP to the shell.)
    const marker = 40000 + Math.floor(Math.random() * 9999);
    await http('POST', '/rooms', { id: 'k3', cols: 100, rows: 30, cwd: home });
    await sleep(800);
    const d = await attach('k3');
    d.ws.send(JSON.stringify({ type: 'input', data: `sh -c 'trap "" HUP; exec sleep ${marker}' &\r` }));
    const pgrep = () => { try { return require('node:child_process').execFileSync('/usr/bin/pgrep', ['-f', `sleep ${marker}`], { encoding: 'utf8' }).trim(); } catch (e) { return ''; } };
    for (let i = 0; i < 20 && !pgrep(); i++) await sleep(150);
    check(!!pgrep(), 'a hangup-ignoring job is running on k3');
    d.ws.close();
    await keeperOp({ op: 'kill', id: 'k3' });
    await sleep(3500);
    const leftover = pgrep();
    check(!leftover, `killing k3 ended the job that ignored hangup${leftover ? ` (still alive: ${leftover})` : ''}`);
    if (leftover) { try { process.kill(Number(leftover.split('\n')[0]), 'SIGKILL'); } catch (e) { /* gone */ } }

    // ── stop --all semantics: the keeper ends everything ────────────────
    await keeperOp({ op: 'shutdown' });
    await sleep(800);
    check(!alive(k1.pid), 'keeper shutdown ended the terminal');
} catch (e) {
    console.error(e);
    console.error('--- host log ---\n' + (host ? host.log() : ''));
    failures++;
} finally {
    if (failures) { try { console.log('--- keeper log ---\n' + fs.readFileSync(path.join(home, 'logs', 'pty-keeper.log'), 'utf8').split('\n').slice(-15).join('\n')); } catch (e) { /* none */ } console.log('--- host log ---\n' + (host ? host.log().split('\n').slice(-15).join('\n') : '')); }
    try { host?.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    try { const st = JSON.parse(fs.readFileSync(path.join(home, '.pty-keeper-state'), 'utf8')); process.kill(st.pid, 'SIGKILL'); } catch (e) { /* gone */ }
    fs.rmSync(home, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
