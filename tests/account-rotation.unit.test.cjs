'use strict';
// The daemon's side of the account rotation, run on its own: the helper that
// asks an agent's CLI one thing and always cleans up after it, and the sweep
// that moves a session stopped at its limit — one per sweep, only when the
// rotation is on, never a session that is working or long since stopped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const agentUsage = require('../lib/agent-usage');
const agentHomesLib = require('../lib/agent-homes');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'hop'), 'utf8');
function fnSource(name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(SRC);
  assert.ok(m, `hop defines ${name}`);
  let depth = 0;
  for (let i = SRC.indexOf('{', SRC.indexOf(')', m.index)); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(m.index, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
const run = (code, sandbox) => vm.runInNewContext(code, { setTimeout, clearTimeout, Promise, Date, Math, JSON, ...sandbox });

// ---- the helper -------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-probe-test-'));
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
const fakeCli = (name, body) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
};
// (Generous: an answer ends the wait at once, and a loaded machine is slow to start node.)
const probe = (timeout = 5000) => run(`const USAGE_PROBE_DIR = ${JSON.stringify(path.join(tmp, 'cwd'))}; const USAGE_PROBE_TIMEOUT_MS = ${timeout};
  ${fnSource('runAgentProbe')}; runAgentProbe`, { fs, spawn, process });

test('the helper asks one thing, hears the answer, and stops the CLI', async () => {
  const marker = `hop-probe-ok-${process.pid}-${Date.now()}`;
  // Answers a request, then would sit there forever.
  const cli = fakeCli('answers.js', `process.stdin.on('data', (d) => { const j = JSON.parse(String(d)); console.log('not json'); console.log(JSON.stringify({ id: j.id, cwd: process.cwd() })); }); setInterval(() => {}, 1000);`);
  const reply = await probe()(cli, [marker], {
    env: process.env,
    onStart: (send) => send({ id: 7 }),
    onLine: (j, send, finish) => { if (j.id === 7) finish(j); }
  });
  assert.equal(reply.id, 7);
  assert.equal(fs.realpathSync(reply.cwd), fs.realpathSync(path.join(tmp, 'cwd')), "it runs in hop's own folder, not a project");
  await new Promise((r) => setTimeout(r, 150));
  let left = '';
  try { left = execFileSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' }); } catch (e) { /* none */ }
  assert.equal(left.trim(), '', 'the CLI is not left running');
});

test('a CLI that never answers is given up on, with whatever it started', { skip: process.platform === 'win32' }, async () => {
  const marker = `hop-probe-hang-${process.pid}-${Date.now()}`;
  const cli = fakeCli('hangs.js', `require('child_process').spawn('/bin/sh', ['-c', 'sleep 30', ${JSON.stringify(marker)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
  const t0 = Date.now();
  assert.equal(await probe(300)(cli, [], { env: process.env, onLine: () => {} }), null);
  assert.ok(Date.now() - t0 < 3000);
  await new Promise((r) => setTimeout(r, 200));
  let left = '';
  try { left = execFileSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' }); } catch (e) { /* none */ }
  assert.equal(left.trim(), '', 'nothing it started is left running');
});

test('a CLI that exits without the answer, or is not there, resolves null', async () => {
  const cli = fakeCli('exits.js', `console.log(JSON.stringify({ other: true }));`);
  assert.equal(await probe(5000)(cli, [], { env: process.env, onLine: (j, send, finish) => { if (j.id === 1) finish(j); } }), null);
  assert.equal(await probe(5000)(path.join(tmp, 'missing'), [], { env: process.env, onLine: () => {} }), null);
});

// ---- the sweep --------------------------------------------------------------

const NOW = Date.now();
const LATER = new Date(NOW + 2 * 86400_000).toISOString();
const claudeUsage = (rows) => agentUsage.parseClaudeUsage({ subscription_type: 'max', rate_limits_available: true, rate_limits: { limits: rows } });
const row = (kind, percent) => ({ kind, group: kind === 'session' ? 'session' : 'weekly', percent, resets_at: LATER, scope: null });
const FULL = claudeUsage([row('session', 100)]);
const ROOMY = claudeUsage([row('weekly_all', 10)]);
const account = (dir, usage, more = {}) => ({ dir, label: dir, login: { loggedIn: true, email: `${dir}@example.org` }, pooled: true, usage, usageAt: Date.now(), ...more });
const live = (name, more = {}) => ({ internalName: name, displayName: name, live: true, agent: 'claude', agentModel: 'claude-opus-5-5', agentHome: { dir: 'a' }, ...more });

function sweepEnv({ autoSwitch = true, entries, stops, accounts, byAgent = null, working = [], pending = [], moveResult = { status: 200, body: { ok: true, restarted: true } } }) {
  const calls = { moves: [], continues: [], actions: [], logs: [], listed: 0, listedAgents: [] };
  const state = { autoSwitch, excluded: [], actions: [] };
  const env = run(`let shuttingDown = false; const CYAN = '', YELLOW = '';
    const ACCOUNT_SWEEP_STUCK_MS = 600000, LIMIT_STOP_MAX_AGE_MS = 12 * 3600000;
    let accountSweepBusy = false, accountSweepStartedAt = 0, accountSweepGen = 0, accountWaiting = [];
    ${fnSource('runAccountSweep')}; ({ sweep: runAccountSweep, waiting: () => accountWaiting })`, {
    os, agentUsage, agentHomesLib,
    log: (m) => calls.logs.push(m),
    loadAccountsState: () => state,
    listAllSessionEntriesRuntimeFirst: async () => ({ entries }),
    agentPhaseFieldsForAll: async (list) => new Map(list.map((e) => [e.internalName, { agentPhase: working.includes(e.internalName) ? 'working' : 'idle' }])),
    sessionLimitStop: (name) => stops[name] || null,
    agySessionLimitStop: async (name) => stops[name] || null,
    // Like the real one: only the agents asked for.
    listAccounts: async ({ agents }) => {
      calls.listed++; calls.listedAgents.push(...agents);
      const all = byAgent || { claude: accounts, codex: [], antigravity: [] };
      return Object.fromEntries(agents.map((a) => [a, all[a] || []]));
    },
    switchSessionAgentHome: async (name, dir) => { calls.moves.push([name, dir]); return moveResult; },
    continuePending: (name) => pending.includes(name),
    queueContinue: (name, message) => calls.continues.push([name, message]),
    recordAccountAction: (a) => { calls.actions.push(a); state.actions.push(a); }
  });
  // (What the sweep leaves is made in its own context: copy it into this one to compare.)
  return { sweep: env.sweep, waiting: () => JSON.parse(JSON.stringify(env.waiting())), calls, state };
}
const stopAt = (minutesAgo) => ({ at: Date.now() - minutesAgo * 60_000, text: "You've hit your 5-hour limit" });

test('a session stopped at its limit is moved to the account with room and told to continue', async () => {
  const env = sweepEnv({ entries: [live('s_1')], stops: { s_1: stopAt(1) }, accounts: [account('a', FULL), account('b', ROOMY)] });
  await env.sweep();
  assert.deepEqual(env.calls.moves, [['s_1', 'b']]);
  assert.equal(env.calls.continues.length, 1);
  assert.match(env.calls.continues[0][1], /^Continue where you left off\. \(hop moved this session to another account/);
  assert.deepEqual(env.calls.actions.map((a) => [a.kind, a.session, a.from, a.to]), [['move', 's_1', 'a', 'b']]);
  assert.deepEqual(env.waiting(), []);
  // The record keeps it from being acted on again at once.
  await env.sweep();
  assert.equal(env.calls.moves.length, 1);
});

test('with the rotation off nothing is read and nothing moves', async () => {
  const env = sweepEnv({ autoSwitch: false, entries: [live('s_1')], stops: { s_1: stopAt(1) }, accounts: [account('a', FULL), account('b', ROOMY)] });
  await env.sweep();
  assert.equal(env.calls.listed, 0);
  assert.deepEqual(env.calls.moves, []);
});

test('a crowd that stopped together moves one per sweep', async () => {
  const env = sweepEnv({ entries: [live('s_1'), live('s_2'), live('s_3')], stops: { s_1: stopAt(1), s_2: stopAt(1), s_3: stopAt(1) }, accounts: [account('a', FULL), account('b', ROOMY)] });
  await env.sweep();
  assert.deepEqual(env.calls.moves, [['s_1', 'b']]);
  assert.deepEqual(env.waiting().map((w) => [w.session, w.reason]), [['s_2', 'next in line'], ['s_3', 'next in line']]);
  await env.sweep();
  assert.deepEqual(env.calls.moves, [['s_1', 'b'], ['s_2', 'b']]);
});

test('a working session, a shell, and a notice from long ago are left alone', async () => {
  const env = sweepEnv({
    entries: [live('s_busy'), live('s_old'), live('s_shell', { agent: null }), live('s_down', { live: false })],
    stops: { s_busy: stopAt(1), s_old: stopAt(13 * 60), s_shell: stopAt(1), s_down: stopAt(1) },
    working: ['s_busy'], accounts: [account('a', FULL), account('b', ROOMY)]
  });
  await env.sweep();
  assert.deepEqual(env.calls.moves, []);
  assert.equal(env.calls.listed, 0, 'no account is even read for them');
});

test('a session whose "continue" is still waiting to be typed is not sent another', async () => {
  const env = sweepEnv({ entries: [live('s_1', { agentHome: { dir: 'b' } })], stops: { s_1: stopAt(30) }, pending: ['s_1'], accounts: [account('a', FULL), account('b', ROOMY)] });
  await env.sweep();
  assert.deepEqual(env.calls.continues, []);
  assert.deepEqual(env.calls.moves, []);
});

test('a move that does not happen is recorded, and no "continue" is sent', async () => {
  const env = sweepEnv({ entries: [live('s_1')], stops: { s_1: stopAt(1) }, accounts: [account('a', FULL), account('b', ROOMY)],
    moveResult: { status: 409, body: { error: 's_1 is mid-turn — switch accounts when it is idle' } } });
  await env.sweep();
  assert.deepEqual(env.calls.continues, []);
  assert.deepEqual(env.calls.actions.map((a) => [a.kind, a.why]), [['failed', 's_1 is mid-turn — switch accounts when it is idle']]);
  // …and it is not retried on the very next sweep.
  await env.sweep();
  assert.equal(env.calls.moves.length, 1);
});

test('with room nowhere it waits; when its own account has room again it continues in place', async () => {
  const none = sweepEnv({ entries: [live('s_1')], stops: { s_1: stopAt(1) }, accounts: [account('a', FULL), account('b', FULL)] });
  await none.sweep();
  assert.deepEqual(none.calls.moves, []);
  assert.deepEqual(none.waiting().map((w) => [w.session, w.reason, w.until]), [['s_1', 'no account in the rotation has room', Date.parse(LATER)]]);

  const back = sweepEnv({ entries: [live('s_1')], stops: { s_1: stopAt(1) }, accounts: [account('a', ROOMY), account('b', ROOMY)] });
  await back.sweep();
  assert.deepEqual(back.calls.moves, []);
  assert.match(back.calls.continues[0][1], /the usage limit this session stopped at has reset/);
  assert.deepEqual(back.calls.actions.map((a) => a.kind), ['resume']);
});

test('a session only ever moves to an account of its own agent: Claude to Claude, Codex to Codex, Antigravity to Antigravity', async () => {
  // Every Claude account is full; the Codex and Antigravity ones have room.
  const byAgent = {
    claude: [account('/h/.claude', FULL), account('/h/.claude2', FULL)],
    codex: [account('/h/.codex', FULL), account('/h/.codex_gpta', ROOMY)],
    antigravity: [account('/h/.gemini', FULL), account('/h/.gemini_lab', ROOMY)]
  };
  const claude = sweepEnv({ entries: [live('s_c', { agentHome: { dir: '/h/.claude' } })], stops: { s_c: stopAt(1) }, byAgent });
  await claude.sweep();
  assert.deepEqual(claude.calls.listedAgents, ['claude']);
  assert.deepEqual(claude.calls.moves, [], 'never to a Codex or Antigravity account');
  assert.deepEqual(claude.waiting().map((w) => [w.session, w.reason]), [['s_c', 'no account in the rotation has room']]);

  for (const [agent, from, to] of [['codex', '/h/.codex', '/h/.codex_gpta'], ['antigravity', '/h/.gemini', '/h/.gemini_lab']]) {
    const env = sweepEnv({ entries: [live('s_x', { agent, agentModel: null, agentHome: { dir: from } })], stops: { s_x: stopAt(1) }, byAgent });
    await env.sweep();
    assert.deepEqual(env.calls.listedAgents, [agent]);
    assert.deepEqual(env.calls.moves, [['s_x', to]]);
  }
});

test("switching a session's account refuses a folder that belongs to another agent", async () => {
  const homes = { claude: [{ dir: '/h/.claude', isDefault: true }, { dir: '/h/.claude2' }], codex: [{ dir: '/h/.codex_gpta' }], antigravity: [{ dir: '/h/.gemini_lab' }] };
  const touched = [];
  const sw = run(`${fnSource('switchSessionAgentHome')}; switchSessionAgentHome`, {
    resolveSessionInternalName: (n) => n,
    sessionAgentKind: () => 'claude',
    listAgentHomes: (agent) => homes[agent],
    // Anything past the check would come here.
    getSessionConfig: () => { touched.push('config'); return {}; },
    getEffectiveSessionConfig: () => { touched.push('config'); return {}; }
  });
  for (const dir of ['/h/.codex_gpta', '/h/.gemini_lab']) {
    const r = await sw('s_c', dir);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, `No claude account at ${dir}`);
  }
  assert.deepEqual(touched, []);
  // A Claude folder is never offered to Codex or Antigravity either.
  const exists = () => true;
  const entries = ['.claude', '.claude2', '.codex', '.codex_gpta', '.gemini', '.gemini_lab'];
  assert.ok(agentHomesLib.discoverAgentHomes('codex', { homeDir: '/h', entries, exists, envDir: null }).every((h) => /\/\.codex/.test(h.dir)));
  assert.ok(agentHomesLib.discoverAgentHomes('claude', { homeDir: '/h', entries, exists, envDir: null }).every((h) => /\/\.claude/.test(h.dir)));
});
