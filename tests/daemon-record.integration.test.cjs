'use strict';

// The daemon's record (.tunnel-state) is how every CLI and agent finds it.
// A CLI that cannot signal the daemon (an agent's sandboxed shell: signal 0
// fails with EPERM) must not take that for a dead daemon and delete the
// record — that left a running hop unreachable ("Hop is not running") for
// every session until it restarted. A record whose pid is really gone is
// still cleaned up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const HOP_BIN = path.join(__dirname, '..', 'hop');
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const NO_SIGNALS = '(version 1)(allow default)(deny signal (target others))';

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

async function scratchHome(pid) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-record-'));
  const hopHome = path.join(dir, 'hop_home');
  fs.mkdirSync(hopHome, { recursive: true });
  const record = path.join(hopHome, '.tunnel-state');
  fs.writeFileSync(record, JSON.stringify({
    pid, port: await freePort(), url: null, sessionSecret: 'a'.repeat(64), startTime: Date.now()
  }), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HOP_')));
  Object.assign(env, { HOME: dir, HOP_HOME: hopHome, HOP_NO_TUNNEL: '1' });
  return { dir, record, env };
}

const runHop = (env, args, sandboxed) => spawnSync(
  sandboxed ? SANDBOX_EXEC : process.execPath,
  sandboxed ? ['-p', NO_SIGNALS, process.execPath, HOP_BIN, ...args] : [HOP_BIN, ...args],
  { env, encoding: 'utf8', timeout: 30000 }
);

test('a sandboxed CLI that cannot signal the daemon leaves its record alone', {
  skip: process.platform !== 'darwin' || !fs.existsSync(SANDBOX_EXEC) ? 'needs macOS sandbox-exec' : false
}, async () => {
  // A stand-in daemon: alive and, like the real one, detached in its own
  // process group, so the sandboxed CLI's signal 0 to it fails with EPERM.
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  await delay(200);
  const probe = spawnSync(SANDBOX_EXEC, ['-p', NO_SIGNALS, process.execPath, '-e',
    `try { process.kill(${daemon.pid}, 0); console.log('ok') } catch (e) { console.log(e.code) }`], { encoding: 'utf8' });
  const { dir, record, env } = await scratchHome(daemon.pid);
  try {
    assert.equal(probe.stdout.trim(), 'EPERM', 'the sandbox profile must refuse signal 0');
    const r = runHop(env, ['who'], true);
    assert.ok(fs.existsSync(record), `the live daemon's record was deleted; hop said: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /Hop is not running/);
  } finally {
    try { daemon.kill(); } catch (e) { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a record whose daemon is gone is still cleaned up", async () => {
  const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  const pid = Number(gone.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  const { dir, record, env } = await scratchHome(pid);
  try {
    const r = runHop(env, ['who'], false);
    assert.match(r.stdout + r.stderr, /Hop is not running/);
    assert.ok(!fs.existsSync(record), 'a dead daemon\'s record should be removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
