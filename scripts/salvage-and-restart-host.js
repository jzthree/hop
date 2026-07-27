#!/usr/bin/env node
// One-shot: salvage every session's recent terminal content, then gracefully
// restart the hay-host and restore the fleet. Designed to run DETACHED — the
// operator may be a claude living inside one of the sessions this kills.
// Progress + results append to ~/.hop2/transcript-salvage/restart.log.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execSync } = require('node:child_process');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const HOME = path.join(os.homedir(), '.hop2');
const OUT = path.join(HOME, 'transcript-salvage');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'restart.log');
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  fs.appendFileSync(LOG, line);
  process.stdout.write(line);
};

const hostState = () => JSON.parse(fs.readFileSync(path.join(HOME, '.hay-host-state'), 'utf8'));
const daemonState = () => JSON.parse(fs.readFileSync(path.join(HOME, '.tunnel-state'), 'utf8'));

const hostGet = (p) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: hostState().port, path: p }, (res) => {
    let d = '';
    res.on('data', (c) => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(15000, () => req.destroy(new Error('timeout')));
});

const stripAnsi = (raw) => String(raw)
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  // Movement/erase paints gaps without spaces — substitute one so words in
  // salvaged transcripts don't glue together (mirrors the daemon's search
  // stripper fix).
  .replace(/\x1b\[[0-9;:?<=>]*[ -/]*[A-HJKf`d]/g, ' ')
  .replace(/\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
  .replace(/\x1b[()][A-Za-z0-9]/g, '')
  .replace(/\x1b[@-~]/g, '')
  .replace(/\r/g, '\n')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/\n{3,}/g, '\n\n');

// Capture one room's snapshot (the ~1.5MB replay tail) over WS.
const salvageRoom = (port, id) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${encodeURIComponent(id)}&name=salvage&cols=200&rows=50`);
  const timer = setTimeout(() => { try { ws.close(); } catch (e) {} resolve('timeout'); }, 20000);
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg.type === 'snapshot') {
        fs.writeFileSync(path.join(OUT, `${id}.txt`), stripAnsi(msg.data), { mode: 0o600 });
        clearTimeout(timer);
        try { ws.close(); } catch (e) {}
        resolve('ok:' + msg.data.length);
      }
    } catch (e) { /* keep waiting */ }
  });
  ws.on('error', () => { clearTimeout(timer); resolve('ws-error'); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same lifecycle lock the hop CLI takes (~/.hop2/.lifecycle.lock): this run
// cycles the host, and a `hop stop`/`start`/`restore` landing in the middle
// of it kills sessions mid-relaunch. Stale holders (dead pid, absurdly old)
// are taken over so a crash can't wedge restarts forever.
const LOCK = path.join(HOME, '.lifecycle.lock');
const lockHeldByOther = () => {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (!cur || !Number.isInteger(cur.pid) || cur.pid === process.pid) return null;
    try { process.kill(cur.pid, 0); } catch (e) { return null; }
    if (Date.now() - Number(cur.at || 0) > 10 * 60_000) return null;
    return cur;
  } catch (e) { return null; }
};
const takeLock = async () => {
  for (let i = 0; i < 240; i++) {
    const held = lockHeldByOther();
    if (!held) {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, op: 'salvage-restart', at: Date.now() }), { mode: 0o600 });
      return true;
    }
    if (i === 0) log(`waiting for ${held.op} (pid ${held.pid}) to finish…`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
const releaseLock = () => {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK);
  } catch (e) { /* already gone */ }
};

(async () => {
  try {
    log('=== salvage-and-restart begins ===');
    if (!await takeLock()) {
      log('FATAL: another hop lifecycle operation held the lock for 2 minutes — aborting');
      return;
    }
    process.on('exit', releaseLock);
    const oldHost = hostState();
    log(`host pid=${oldHost.pid} port=${oldHost.port}`);

    // 0. Wait for active generators to go idle (except Solstice — that's the
    // operator; it goes down with the ship by design). 10 min cap.
    for (let i = 0; i < 60; i++) {
      const rooms = (await hostGet('/rooms')).rooms;
      const busy = rooms.filter((r) => r.id !== 'Solstice' && Date.now() - r.lastActivityAt < 90000);
      if (busy.length === 0) { log('fleet idle'); break; }
      if (i % 6 === 0) log(`waiting for: ${busy.map((r) => r.id).join(', ')}`);
      await sleep(10000);
    }

    // 1. Salvage every room. This is also the PRE-RESTART census — reconciled
    // against the restored set in step 4 so the run reports exactly which
    // sessions survived (the core guarantee a graceful restart must make).
    const preRooms = (await hostGet('/rooms')).rooms;
    const rooms = preRooms.map((r) => r.id);
    fs.writeFileSync(path.join(OUT, 'pre-rooms.json'), JSON.stringify(preRooms, null, 1), { mode: 0o600 });
    log(`salvaging ${rooms.length} rooms -> ${OUT}`);
    const salvageStats = {};
    for (const id of rooms) {
      const res = await salvageRoom(oldHost.port, id);
      salvageStats[id] = res;
      log(`  ${id}: ${res}`);
    }
    const salvageMisses = rooms.filter((id) => !String(salvageStats[id] || '').startsWith('ok'));
    if (salvageMisses.length) log(`salvage MISSES (no snapshot captured): ${salvageMisses.join(', ')}`);

    // 2. Graceful host stop (persists replay buffers), then wait for exit.
    log(`SIGTERM host ${oldHost.pid}`);
    try { process.kill(oldHost.pid, 'SIGTERM'); } catch (e) { log('kill: ' + e.message); }
    for (let i = 0; i < 40; i++) {
      try { process.kill(oldHost.pid, 0); await sleep(500); } catch (e) { break; }
    }
    log('host exited');

    // 3. Respawn via the daemon (hop status triggers ensure) and restore.
    await sleep(1500);
    const env = { ...process.env };
    log('triggering respawn (hop status)…');
    try { log(execSync('hop status 2>&1 | head -8', { encoding: 'utf8', env, timeout: 60000 })); } catch (e) { log('status err: ' + e.message); }
    await sleep(2000);
    log('running hop restore…');
    try { log(execSync('hop restore 2>&1 | tail -20', { encoding: 'utf8', env, timeout: 120000 })); } catch (e) { log('restore err: ' + e.message); }

    // 4. Verify: new host pid + reconcile the restored set + probe env.
    await sleep(3000);
    const newHost = hostState();
    log(`new host pid=${newHost.pid} port=${newHost.port} (old was ${oldHost.pid})`);

    // Reconciliation: which pre-restart rooms came back? A room missing here
    // is exactly the failure a graceful-restart feature must surface.
    try {
      const postRooms = (await hostGet('/rooms')).rooms.map((r) => r.id);
      const restored = rooms.filter((id) => postRooms.includes(id));
      const missing = rooms.filter((id) => !postRooms.includes(id));
      const extra = postRooms.filter((id) => !rooms.includes(id) && id !== 'EnvProbe');
      log(`RECONCILE: ${restored.length}/${rooms.length} restored`);
      if (missing.length) log(`RECONCILE MISSING (${missing.length}): ${missing.join(', ')}`);
      if (extra.length) log(`RECONCILE UNEXPECTED-NEW (${extra.length}): ${extra.join(', ')}`);
      fs.writeFileSync(path.join(OUT, 'reconcile.json'),
        JSON.stringify({ preCount: rooms.length, restored, missing, extra, salvageMisses }, null, 1), { mode: 0o600 });
    } catch (e) { log('reconcile err: ' + e.message); }
    const ds = daemonState();
    const api = (method, p, body) => new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        host: '127.0.0.1', port: ds.port, path: p, method,
        headers: { Authorization: 'Bearer ' + ds.sessionSecret, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }
      }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, data: d })); });
      if (data) req.end(data); else req.end();
    });
    const probeEnvFile = path.join(OUT, 'env-probe.txt');
    try { fs.unlinkSync(probeEnvFile); } catch (e) {}
    const mk = await api('POST', '/api/terminals', { name: 'EnvProbe', cwd: os.homedir(), cols: 80, rows: 24, startup: `env | grep -E "^CLAUDE" > ${probeEnvFile}; echo done >> ${probeEnvFile}` });
    log('probe create: ' + mk.status);
    await sleep(4000);
    let probeResult = '(no file)';
    try { probeResult = fs.readFileSync(probeEnvFile, 'utf8'); } catch (e) {}
    const dirty = /CLAUDECODE=|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_SESSION_ID/.test(probeResult);
    log(`probe env markers present: ${dirty ? 'DIRTY — SCRUB FAILED' : 'clean ✓'}`);
    // The probe dumps every CLAUDE* variable, which includes OAuth tokens.
    // The log is a plain file that gets read, pasted and shared, so print
    // NAMES and value lengths only — enough to tell a leaked marker from a
    // scrubbed one without writing a credential to disk in the clear.
    const redacted = probeResult
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf('=');
        if (eq < 0) return line;
        const key = line.slice(0, eq);
        const len = line.length - eq - 1;
        return `${key}=<redacted ${len} chars>`;
      })
      .join('\n');
    log('probe env content (values redacted):\n' + redacted);
    try { fs.unlinkSync(probeEnvFile); } catch (e) { /* best effort */ }
    await api('POST', '/api/sessions/delete', { name: 'EnvProbe' });

    log('=== done — reattach with: hop attach <name> ===');
  } catch (e) {
    log('FATAL: ' + (e && e.stack || e));
  }
})();
