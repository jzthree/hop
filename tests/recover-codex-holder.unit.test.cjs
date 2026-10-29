'use strict';
// `hop recover` in a Codex session whose conversation the desktop app holds:
// Codex lets one process write a conversation, so resuming it here only
// forks a stray copy or exits. recover must say who holds it (and which of
// the app's automations keeps it there) instead of launching codex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const HOP = path.join(__dirname, '..', 'hop');
const THREAD = '01a00000-1111-7222-8333-444455556666';

test('recover names the desktop app and its automation when the app holds the conversation', { timeout: 300000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-recover-holder-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const hopHome = path.join(tmp, 'hop_home');
  const codexHome = path.join(tmp, 'codex_home');
  fs.mkdirSync(path.join(hopHome, 'claude-sessions'), { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'thread-writer-locks'), { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'automations', 'nightly-check'), { recursive: true });
  const session = 's_0123456789';
  fs.writeFileSync(path.join(hopHome, 'claude-sessions', `${session}.meta`), JSON.stringify({ internalName: session, displayName: 'probe', cwd: tmp }));
  fs.writeFileSync(path.join(hopHome, 'claude-sessions', `${session}.turn`), JSON.stringify({ sessionId: THREAD, count: 3, at: new Date().toISOString(), agent: 'codex' }));
  fs.writeFileSync(path.join(codexHome, 'automations', 'nightly-check', 'automation.toml'),
    `version = 1\nid = "nightly-check"\nkind = "heartbeat"\nname = "Nightly check"\nprompt = "check"\nstatus = "ACTIVE"\ntarget_thread_id = "${THREAD}"\n`);

  // A stand-in for the app's Codex server: a process under a ChatGPT.app
  // path that keeps the conversation's lock file open.
  const lock = path.join(codexHome, 'thread-writer-locks', `${THREAD}.lock`);
  fs.writeFileSync(lock, '');
  const appBin = path.join(tmp, 'ChatGPT.app', 'Contents', 'MacOS');
  fs.mkdirSync(appBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(appBin, 'codex'));
  const holder = spawn(path.join(appBin, 'codex'), ['-e', `require('fs').openSync(${JSON.stringify(lock)}, 'r'); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  for (let i = 0; i < 40; i++) {
    const r = spawnSync('/usr/sbin/lsof', ['-t', lock], { encoding: 'utf8' });
    if (r.stdout.trim()) break;
    await new Promise((r2) => setTimeout(r2, 100));
  }

  const r = spawnSync(process.execPath, [HOP, 'recover', '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, HOP_HOME: hopHome, CODEX_HOME: codexHome, HOP_SESSION: session, NO_COLOR: '1' },
    timeout: 120000
  });
  const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(r.status, 1, out);
  assert.match(out, /open in the Codex desktop app/);
  assert.match(out, /"Nightly check"/);
  assert.match(out, /hop recover --take/);
  assert.doesNotMatch(out, /Would recover/);
  assert.match(fs.readFileSync(path.join(codexHome, 'automations', 'nightly-check', 'automation.toml'), 'utf8'), /status = "ACTIVE"/,
    'a dry run leaves the automation alone');
});
