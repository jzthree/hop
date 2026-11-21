'use strict';
// A second Antigravity login on one Mac: a folder agy runs with
// (--gemini_dir) in a sandbox that keeps it from the keychain, sharing the
// default folder's conversations so a session can move between accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const acc = require('../lib/agy-accounts');

test('an account folder shares conversations, hooks and skills, and keeps its own login', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acc-'));
  const def = path.join(root, '.gemini');
  fs.mkdirSync(path.join(def, 'antigravity-cli', 'brain', 'conv-1'), { recursive: true });
  fs.mkdirSync(path.join(def, 'config'), { recursive: true });
  fs.writeFileSync(path.join(def, 'config', 'hooks.json'), '{"hop":{}}');
  fs.writeFileSync(path.join(def, 'antigravity-cli', 'settings.json'), '{}');
  const dir = path.join(root, '.gemini_work');
  const { links } = acc.setUpAccountDir(dir, def, { now: Date.parse('2026-11-20T12:00:00Z') });
  // Shared: a conversation started on either account lands in one store.
  assert.ok(fs.lstatSync(path.join(dir, 'antigravity-cli', 'brain')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(dir, 'antigravity-cli', 'brain', 'conv-1')));
  assert.ok(fs.existsSync(path.join(def, 'antigravity-cli', 'conversations')), 'a store the default lacked is made there first');
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'hooks.json'), 'utf8'), '{"hop":{}}');
  assert.ok(links.includes('config/hooks.json') && !links.includes('config/mcp_config.json'), 'files the default lacks are not linked');
  // Its own: the folders agy writes its login and logs into are real.
  assert.ok(!fs.lstatSync(path.join(dir, 'antigravity-cli')).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, acc.MARKER), 'utf8')).agent, 'antigravity');
  assert.throws(() => acc.setUpAccountDir(dir, def), /already there/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('how agy is started for an account, for a check, and in a terminal', () => {
  const work = { dir: '/Users/j/.gemini_work', isDefault: false };
  const def = { dir: '/Users/j/.gemini', isDefault: true };
  const l = acc.launchFor(work, { bin: '/x/agy' });
  assert.equal(l.file, '/usr/bin/sandbox-exec');
  assert.deepEqual(l.args.slice(2), ['/x/agy', '--gemini_dir', '/Users/j/.gemini_work']);
  assert.match(l.args[1], /deny process-exec \(literal "\/usr\/bin\/security"\)/);
  assert.doesNotMatch(l.args[1], /\/usr\/bin\/open/);
  // A background check never opens a sign-in page — not even for the default account.
  assert.match(acc.launchFor(work, { bin: '/x/agy', browser: false }).args[1], /\/usr\/bin\/open/);
  const check = acc.launchFor(def, { bin: '/x/agy', browser: false, dataDir: '/h/probe' });
  assert.equal(check.file, '/usr/bin/sandbox-exec');
  assert.doesNotMatch(check.args[1], /security/, 'the default keeps its keychain');
  assert.deepEqual(check.args.slice(2), ['/x/agy', '--gemini_dir', '/h/probe']);
  assert.deepEqual(acc.launchFor(def, { bin: '/x/agy' }), { file: '/x/agy', args: [] });
  assert.equal(acc.shellLaunch(def, '/hop/scripts/agy-account'), 'agy');
  assert.equal(acc.shellLaunch({ dir: "/Users/j/.gemini_o'k", isDefault: false }, '/hop/scripts/agy-account'),
    "HOP_AGY_HOME='/Users/j/.gemini_o'\\''k' '/hop/scripts/agy-account'");
  assert.equal(acc.emailFromLog('x\nOAuth: authenticated successfully as a@example.org\n…authenticated successfully as b@example.org\n'), 'b@example.org');
  assert.equal(acc.emailFromLog('nothing'), null);
  assert.ok(acc.SIGNED_OUT_RE.test('Authentication required. Please visit the URL to log in:'));
});

test('the launcher script runs plain agy for the default and refuses a folder hop did not set up', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-'));
  const fake = path.join(root, 'agy');
  fs.writeFileSync(fake, '#!/bin/sh\necho "args:$*"\n', { mode: 0o755 });
  const launcher = path.join(__dirname, '..', 'scripts', 'agy-account');
  const env = { ...process.env, HOP_AGY_REAL_BIN: fake, HOME: root };
  assert.equal(execFileSync(launcher, ['--conversation', 'x'], { env: { ...env, HOP_AGY_HOME: '' }, encoding: 'utf8' }).trim(), 'args:--conversation x');
  assert.equal(execFileSync(launcher, ['-c'], { env: { ...env, HOP_AGY_HOME: path.join(root, '.gemini') }, encoding: 'utf8' }).trim(), 'args:-c');
  assert.throws(() => execFileSync(launcher, [], { env: { ...env, HOP_AGY_HOME: path.join(root, 'elsewhere') }, stdio: 'pipe' }), /Command failed/);
  if (process.platform === 'darwin') {
    const dir = path.join(root, '.gemini_work');
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, acc.MARKER), '{}');
    assert.equal(execFileSync(launcher, ['-p', 'hi'], { env: { ...env, HOP_AGY_HOME: dir }, encoding: 'utf8' }).trim(), `args:--gemini_dir ${dir} -p hi`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});
