#!/usr/bin/env node
'use strict';
// Restart the hay-host WITHOUT touching running sessions — when the host is
// keeper-backed (scripts/pty-keeper.js owns the terminals): stop the host,
// let the daemon start a new one, and the new host re-adopts every terminal.
// Agents keep running, mid-turn work included.
//
// When the RUNNING host still owns its terminals itself (a host from before
// the keeper existed), there is no gentle path: this hands over to the old
// salvage-and-restart (salvage → restart → restore), which the new host then
// starts keeper-backed — so that is the LAST restart that cycles sessions.
//
// Progress: ~/.hop2/logs/host-restart.log. Safe to run detached.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const HOME = process.env.HOP_HOME || path.join(os.homedir(), '.hop2');
const LOG = path.join(HOME, 'logs', 'host-restart.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const log = (m) => {
    const line = `[${new Date().toISOString()}] ${m}\n`;
    fs.appendFileSync(LOG, line);
    process.stdout.write(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostState = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, '.hay-host-state'), 'utf8')); } catch (e) { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const hostGet = (port, p) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 8000 }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
});
const hopBin = path.join(__dirname, '..', 'hop');

(async () => {
    log('=== host restart requested ===');
    const old = hostState();
    if (!old || !alive(old.pid)) {
        log('no running host — starting one');
        try { execSync(`"${process.execPath}" "${hopBin}" status`, { stdio: 'ignore', timeout: 60000 }); } catch (e) { /* status exits non-zero sometimes */ }
        return;
    }
    const health = await hostGet(old.port, '/health');
    const keeperBacked = !!(health && health.capabilities && health.capabilities.keeper);
    if (!keeperBacked && !process.argv.includes('--force-gentle')) {
        log(`host ${old.pid} owns its terminals itself (pre-keeper) — handing over to salvage-and-restart; `
            + 'this is the last restart that cycles sessions');
        const child = spawn(process.execPath, [path.join(__dirname, 'salvage-and-restart-host.js')], { detached: true, stdio: 'ignore' });
        child.unref();
        log(`salvage-and-restart launched (pid ${child.pid}) — progress in ~/.hop2/transcript-salvage/restart.log`);
        return;
    }
    const before = ((await hostGet(old.port, '/rooms')) || {}).rooms || [];
    log(`host ${old.pid} is keeper-backed (keeper pid ${health.capabilities.keeperPid}); ${before.length} room(s) running`);

    log(`stopping host ${old.pid} (terminals stay in the keeper)`);
    try { process.kill(old.pid, 'SIGTERM'); } catch (e) { log(`kill: ${e.message}`); }
    for (let i = 0; i < 40 && alive(old.pid); i++) await sleep(250);
    if (alive(old.pid)) { log('host did not exit — aborting (nothing else touched)'); process.exit(1); }

    log('starting a new host (hop status)');
    try { execSync(`"${process.execPath}" "${hopBin}" status`, { stdio: 'ignore', timeout: 200000 }); } catch (e) { /* see below */ }
    let fresh = null;
    // A keeper-backed host re-adopts every terminal BEFORE it opens its port;
    // with 30 rooms that has taken over a minute. Poll for as long as the
    // daemon itself is willing to wait for a host (its 180 s ceiling), or a
    // host still mid-adoption gets reported as "no new host came up".
    for (let i = 0; i < 360; i++) {
        const st = hostState();
        if (st && st.pid !== old.pid && alive(st.pid) && await hostGet(st.port, '/health')) { fresh = st; break; }
        await sleep(500);
    }
    if (!fresh) { log('FAIL: no new host came up — run `hop status`'); process.exit(1); }
    const after = ((await hostGet(fresh.port, '/rooms')) || {}).rooms || [];
    const afterIds = new Set(after.map((r) => r.id));
    const lost = before.map((r) => r.id).filter((id) => !afterIds.has(id));
    log(`new host ${fresh.pid}: ${after.length} room(s) — ${lost.length ? `NOT re-adopted: ${lost.join(', ')}` : 'every running session re-adopted ✓'}`);
    process.exit(lost.length ? 2 : 0);
})().catch((e) => { log(`error: ${e && e.stack || e}`); process.exit(1); });
