'use strict';
// Removing an agent account: never the default, never one in use; the
// folder is moved aside whole (its links untouched, so the conversations an
// Antigravity folder shares with the default stay put) and its login dropped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rm = require('../lib/account-removal');
const acc = require('../lib/agy-accounts');

test('only an account nobody is using, and never the default, can be removed', () => {
  const home = { dir: '/h/.codex_work', label: 'work', isDefault: false };
  assert.equal(rm.whyNotRemovable({ agent: 'codex', home }), null);
  assert.match(rm.whyNotRemovable({ agent: 'codex', home: { dir: '/h/.codex', label: 'default', isDefault: true } }), /default account is Codex's own folder/);
  assert.match(rm.whyNotRemovable({ agent: 'codex', home, liveSessions: 2 }), /2 running sessions use it/);
  assert.match(rm.whyNotRemovable({ agent: 'codex', home, liveSessions: 1 }), /1 running session uses it: move it/);
  assert.match(rm.whyNotRemovable({ agent: 'codex', home, signingIn: true }), /signing in/);
  assert.match(rm.whyNotRemovable({ agent: 'codex', home, envDir: '/h/.codex_work/' }), /started with this folder/);
  assert.match(rm.whyNotRemovable({ agent: 'codex', home: null }), /no such account/);
});

test("Claude Code's keychain entry is named by its folder; a removed folder by its own name and the time", () => {
  assert.match(rm.claudeKeychainService('/Users/x/.claude_work'), /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.notEqual(rm.claudeKeychainService('/Users/x/.claude_work'), rm.claudeKeychainService('/Users/x/.claude_lab'));
  const at = new Date(2026, 10, 21, 23, 5, 9).getTime();
  assert.equal(rm.removedFolderFor('/Users/x/.codex_work', '/hop/removed-accounts', at), '/hop/removed-accounts/codex_work-2026-11-21-230509');
});

test('a Codex folder moves aside whole, conversations kept, login dropped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-rm-'));
  const dir = path.join(root, '.codex_work');
  fs.mkdirSync(path.join(dir, 'sessions', '2026', '11', '21'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', '2026', '11', '21', 'rollout-1.jsonl'), '{"turn":1}\n');
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"tokens":"x"}');
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "x"\n');
  const dest = rm.removedFolderFor(dir, path.join(root, 'removed-accounts'));
  const r = rm.moveAccountFolder('codex', dir, dest);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(r.droppedLogins, ['auth.json']);
  assert.equal(fs.existsSync(path.join(dest, 'auth.json')), false);
  assert.equal(fs.readFileSync(path.join(dest, 'sessions', '2026', '11', '21', 'rollout-1.jsonl'), 'utf8'), '{"turn":1}\n');
  assert.ok(fs.existsSync(path.join(dest, 'config.toml')));
  assert.throws(() => rm.moveAccountFolder('codex', dir, dest), /already there|ENOENT/);
});

test("an Antigravity folder goes without touching the default's shared conversations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-rm-agy-'));
  const def = path.join(root, '.gemini');
  fs.mkdirSync(path.join(def, 'antigravity-cli', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(def, 'antigravity-cli', 'conversations', 'c1.db'), 'conversation');
  const dir = path.join(root, '.gemini_work');
  acc.setUpAccountDir(dir, def);
  fs.writeFileSync(path.join(dir, 'antigravity-cli', 'antigravity-oauth-token'), 'secret');
  const r = rm.moveAccountFolder('antigravity', dir, path.join(root, 'removed-accounts', 'gemini_work-x'));
  assert.deepEqual(r.droppedLogins, ['antigravity-cli/antigravity-oauth-token']);
  assert.equal(fs.readFileSync(path.join(def, 'antigravity-cli', 'conversations', 'c1.db'), 'utf8'), 'conversation');
  assert.ok(fs.lstatSync(path.join(r.dest, 'antigravity-cli', 'conversations')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(r.dest, acc.MARKER)), true);
});
