'use strict';
// Moving a conversation to another account folder (lib/account-move.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const m = require('../lib/account-move');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hop-acctmove-'));
const meta = (id, extra = {}) => JSON.stringify({ type: 'session_meta', payload: { id, ...extra } }) + '\n';

test('the most complete copy is the one moved; a live .jsonl beats a put-away .zst', () => {
  const d = tmp();
  const a = path.join(d, 'a.jsonl'), b = path.join(d, 'b.jsonl'), z = path.join(d, 'c.jsonl.zst');
  fs.writeFileSync(a, 'x'.repeat(10));
  fs.writeFileSync(b, 'x'.repeat(30));
  fs.writeFileSync(z, 'x'.repeat(99));
  assert.equal(m.newestCopy([a, b, z, path.join(d, 'gone.jsonl')]), b);
  assert.equal(m.newestCopy([z]), z);
  assert.equal(m.newestCopy([]), null);
});

test('an older copy left in the target is replaced; a copy as complete is kept', () => {
  const d = tmp();
  const src = path.join(d, 'src.jsonl'), dest = path.join(d, 'deep', 'dest.jsonl');
  fs.writeFileSync(src, 'one\ntwo\n');
  assert.equal(m.copyIfNewer(src, dest), 'copied');
  fs.appendFileSync(src, 'three\n');
  assert.equal(m.copyIfNewer(src, dest), 'replaced', 'the session went on writing since the last stay there');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'one\ntwo\nthree\n');
  assert.equal(m.copyIfNewer(src, dest), 'kept');
  assert.equal(m.copyIfNewer(dest, dest), 'kept');
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['dest.jsonl'], 'no half-written file left beside it');
});

test('the fork lineage is followed through compressed rollouts, nearest first', async () => {
  const d = tmp();
  const files = {
    c: path.join(d, 'rollout-c.jsonl'),
    b: path.join(d, 'rollout-b.jsonl.zst'),
    a: path.join(d, 'rollout-a.jsonl')
  };
  fs.writeFileSync(files.c, meta('c', { forked_from_id: 'b' }) + '{"type":"event_msg"}\n');
  fs.writeFileSync(files.b, zlib.zstdCompressSync(Buffer.from(meta('b', { forked_from_id: 'a' }) + 'more\n'.repeat(1000))));
  fs.writeFileSync(files.a, meta('a'));
  assert.deepEqual(await m.readRolloutMeta(files.b), { id: 'b', forked_from_id: 'a' });
  const lineage = await m.codexForkLineage(files.c, (id) => (files[id] ? [files[id]] : []));
  assert.deepEqual(lineage, [{ id: 'b', file: files.b }, { id: 'a', file: files.a }]);
});

test('a lineage that reaches a conversation no longer on the host says which', async () => {
  const d = tmp();
  const c = path.join(d, 'rollout-c.jsonl');
  fs.writeFileSync(c, meta('c', { forked_from_id: 'gone' }));
  assert.deepEqual(await m.codexForkLineage(c, () => []), [{ id: 'gone', file: null }]);
  const loop = path.join(d, 'rollout-l.jsonl');
  fs.writeFileSync(loop, meta('l', { forked_from_id: 'l' }));
  assert.deepEqual(await m.codexForkLineage(loop, () => [loop]), [], 'a thread naming itself is no lineage');
});

test("the default folder's trust of hop's hook is carried to an account folder with the same hooks", () => {
  const home = tmp();
  const def = path.join(home, '.codex'), acct = path.join(home, '.codex_b');
  for (const dir of [def, acct]) fs.mkdirSync(dir);
  const hooks = '{"hooks":{"PermissionRequest":[]}}';
  fs.writeFileSync(path.join(def, 'hooks.json'), hooks);
  fs.writeFileSync(path.join(acct, 'hooks.json'), hooks);
  const key = `${def}/hooks.json:permission_request:0:0`;
  fs.writeFileSync(path.join(def, 'config.toml'), `model = "x"\n\n[hooks.state]\n\n[hooks.state."${key}"]\ntrusted_hash = "sha256:abc"\n\n[tui]\nx = 1\n`);
  fs.writeFileSync(path.join(acct, 'config.toml'), `model = "x"\n\n[hooks.state]\n\n[hooks.state."${key}"]\ntrusted_hash = "sha256:abc"\n`);
  assert.equal(m.ensureCodexHookTrust(def, acct), 1);
  const trusted = m.trustedHooks(fs.readFileSync(path.join(acct, 'config.toml'), 'utf8'));
  assert.equal(trusted.get(`${acct}/hooks.json:permission_request:0:0`), 'sha256:abc');
  assert.equal(m.ensureCodexHookTrust(def, acct), 0, 'once is enough');
  assert.equal(m.ensureCodexHookTrust(def, def), 0);
});

test('different hooks, or a decision made in the folder itself, are left alone', () => {
  const def = '/h/.codex', dir = '/h/.codex_b';
  const key = (root) => `[hooks.state."${root}/hooks.json:permission_request:0:0"]\ntrusted_hash = `;
  const defaultConfig = `${key(def)}"sha256:abc"\n`;
  assert.equal(m.missingHookTrust({ defaultDir: def, dir, defaultConfig, config: '', defaultHooks: 'A', hooks: 'B' }), '', 'not the same hooks');
  assert.equal(m.missingHookTrust({ defaultDir: def, dir, defaultConfig, config: `${key(dir)}"sha256:other"\n`, defaultHooks: 'A', hooks: 'A' }), '');
  assert.match(m.missingHookTrust({ defaultDir: def, dir, defaultConfig, config: '', defaultHooks: 'A', hooks: 'A' }), /\.codex_b\/hooks\.json:permission_request:0:0/);
});

// ---- the account survives the daemon (hop's withDurableAccountEnv) ------------
const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'hop'), 'utf8');
function fnSource(name) {
  const mm = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(SRC);
  assert.ok(mm, `hop defines ${name}`);
  let depth = 0;
  for (let i = SRC.indexOf('{', SRC.indexOf(')', mm.index)); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(mm.index, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test("a session's account comes back from its durable meta after a daemon restart", () => {
  const metas = { moved: { accountEnv: { CODEX_HOME: '/h/.codex_spare' } }, back: { accountEnv: { CODEX_HOME: null } }, plain: {} };
  const inner = vm.runInNewContext(`${fnSource('withDurableAccountEnv')}; withDurableAccountEnv`, { Object, String, readDurableIdentity: (n) => metas[n] || null });
  // (Made in the sandbox's own realm: brought back as plain data to compare.)
  const apply = (n, c) => { const r = inner(n, c); return r && r !== c ? JSON.parse(JSON.stringify(r)) : r; };
  const envOf = (n, c) => { const r = inner(n, c); return r && r.env ? JSON.parse(JSON.stringify(r.env)) : undefined; };
  assert.deepEqual(envOf('moved', { type: 'terminal' }), { CODEX_HOME: '/h/.codex_spare' }, 'the restarted daemon has no env for it: the meta says spare1');
  assert.deepEqual(envOf('moved', { env: { FOO: '1', CODEX_HOME: '/h/.codex' } }), { FOO: '1', CODEX_HOME: '/h/.codex_spare' });
  assert.equal(envOf('back', { env: { CODEX_HOME: '/h/.codex_spare' } }), undefined, 'moved back to the default');
  const cfg = { env: { FOO: '1' } };
  assert.equal(apply('plain', cfg), cfg);
  assert.equal(apply('plain', null), null);
  const early = vm.runInNewContext(`${fnSource('withDurableAccountEnv')}; withDurableAccountEnv`, { Object, String, readDurableIdentity: () => { throw new ReferenceError('not yet'); } });
  assert.deepEqual(JSON.parse(JSON.stringify(early('moved', { env: { A: 'b' } }))), { env: { A: 'b' } });
});

test("a thread's goal goes along to the new account folder, unless that holds as recent a one", () => {
  const { DatabaseSync } = require('node:sqlite');
  const d = tmp();
  const make = (f) => {
    const db = new DatabaseSync(f);
    db.exec(`CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY NOT NULL, goal_id TEXT NOT NULL, objective TEXT NOT NULL,
      status TEXT NOT NULL, token_budget INTEGER, tokens_used INTEGER NOT NULL DEFAULT 0, time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE thread_goal_continuation_deferrals (thread_id TEXT PRIMARY KEY NOT NULL REFERENCES thread_goals(thread_id) ON DELETE CASCADE);`);
    return db;
  };
  const from = path.join(d, 'from.sqlite'), to = path.join(d, 'to.sqlite');
  const a = make(from); make(to).close();
  a.prepare('INSERT INTO thread_goals VALUES (?,?,?,?,?,?,?,?,?)').run('t1', 'g1', 'finish the analysis', 'active', null, 900, 3600, 1, 200);
  a.prepare('INSERT INTO thread_goal_continuation_deferrals VALUES (?)').run('t1');
  a.close();
  assert.equal(m.copyCodexGoal(from, to, 't1'), 'copied');
  const b = new DatabaseSync(to, { readOnly: true });
  const row = b.prepare('SELECT * FROM thread_goals WHERE thread_id = ?').get('t1');
  assert.equal(row.status, 'active');
  assert.equal(row.objective, 'finish the analysis');
  assert.equal(row.time_used_seconds, 3600);
  assert.ok(b.prepare('SELECT 1 FROM thread_goal_continuation_deferrals WHERE thread_id = ?').get('t1'));
  b.close();
  assert.equal(m.copyCodexGoal(from, to, 't1'), 'kept');
  assert.equal(m.copyCodexGoal(from, to, 'other'), 'none');
  assert.equal(m.copyCodexGoal(from, path.join(d, 'missing.sqlite'), 't1'), 'no-target');
});

test("each thread's history segments come along with it", async () => {
  const d = tmp();
  const root = path.join(d, 'rollout-2026-10-20T10-46-22-aaaaaaaa-0000-0000-0000-000000000001.jsonl');
  const parent = path.join(d, 'rollout-2026-09-05T17-43-24-bbbbbbbb-0000-0000-0000-000000000002.jsonl.zst');
  const segment = path.join(d, 'rollout-2026-10-06T11-18-06-bbbbbbbb-0000-0000-0000-000000000002_cccccccc-0000-0000-0000-000000000003.jsonl.zst');
  fs.writeFileSync(root, meta('aaaaaaaa-0000-0000-0000-000000000001', { forked_from_id: 'bbbbbbbb-0000-0000-0000-000000000002' }));
  fs.writeFileSync(parent, zlib.zstdCompressSync(Buffer.from(meta('bbbbbbbb-0000-0000-0000-000000000002'))));
  fs.writeFileSync(segment, zlib.zstdCompressSync(Buffer.from(meta('cccccccc-0000-0000-0000-000000000003'))));
  const copies = { 'bbbbbbbb-0000-0000-0000-000000000002': [parent] };
  const segments = { 'bbbbbbbb-0000-0000-0000-000000000002': [segment] };
  const lineage = await m.codexForkLineage(root, (id) => copies[id] || [], (id) => segments[id] || []);
  assert.deepEqual(lineage.map((x) => x.file), [parent, segment]);
  assert.equal(lineage[1].id, 'bbbbbbbb-0000-0000-0000-000000000002_cccccccc-0000-0000-0000-000000000003');
});
