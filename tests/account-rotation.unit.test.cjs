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

function sweepEnv({ autoSwitch = true, entries, stops, accounts, byAgent = null, working = [], pending = [], moveResult = { status: 200, body: { ok: true, restarted: true } },
  resetOutcome = { outcome: 'reset' }, boxes = {}, cached = {} }) {
  const calls = { moves: [], continues: [], actions: [], logs: [], listed: 0, listedAgents: [], resets: [], boxReads: [] };
  const state = { autoSwitch, excluded: [], actions: [] };
  const env = run(`let shuttingDown = false; const CYAN = '', YELLOW = '', DIM = '';
    const ACCOUNT_SWEEP_STUCK_MS = 600000;
    let accountSweepBusy = false, accountSweepStartedAt = 0, accountSweepGen = 0, accountWaiting = [];
    ${fnSource('carryOutReset')}
    ${fnSource('runAccountSweep')}; ({ sweep: runAccountSweep, waiting: () => accountWaiting })`, {
    os, path, agentUsage, agentHomesLib,
    listAgentHomes: (agent) => ((byAgent || { claude: accounts })[agent] || []).map((a) => ({ dir: a.dir, label: a.label })),
    consumeCodexReset: async (home) => { calls.resets.push(home.dir); return resetOutcome; },
    agentUsageCache: new Map(),
    // A reading hop already has: none unless a test gives one, so the sweep reads.
    cachedAgentUsage: (agent, dir) => cached[dir] || null,
    readRoomComposer: async (name) => { calls.boxReads.push(name); return boxes[name] === undefined ? { state: { found: true, isEmpty: true }, working: false } : boxes[name]; },
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

test('a working session, a shell, and a stopped session that is not running are left alone', async () => {
  const env = sweepEnv({
    entries: [live('s_busy'), live('s_shell', { agent: null }), live('s_down', { live: false })],
    stops: { s_busy: stopAt(1), s_shell: stopAt(1), s_down: stopAt(1) },
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
    codex: [account('/h/.codex', FULL), account('/h/.codex_spare', ROOMY)],
    antigravity: [account('/h/.gemini', FULL), account('/h/.gemini_lab', ROOMY)]
  };
  const claude = sweepEnv({ entries: [live('s_c', { agentHome: { dir: '/h/.claude' } })], stops: { s_c: stopAt(1) }, byAgent });
  await claude.sweep();
  assert.deepEqual(claude.calls.listedAgents, ['claude']);
  assert.deepEqual(claude.calls.moves, [], 'never to a Codex or Antigravity account');
  assert.deepEqual(claude.waiting().map((w) => [w.session, w.reason]), [['s_c', 'no account in the rotation has room']]);

  for (const [agent, from, to] of [['codex', '/h/.codex', '/h/.codex_spare'], ['antigravity', '/h/.gemini', '/h/.gemini_lab']]) {
    const env = sweepEnv({ entries: [live('s_x', { agent, agentModel: null, agentHome: { dir: from } })], stops: { s_x: stopAt(1) }, byAgent });
    await env.sweep();
    assert.deepEqual(env.calls.listedAgents, [agent]);
    assert.deepEqual(env.calls.moves, [['s_x', to]]);
  }
});

test("switching a session's account refuses a folder that belongs to another agent", async () => {
  const homes = { claude: [{ dir: '/h/.claude', isDefault: true }, { dir: '/h/.claude2' }], codex: [{ dir: '/h/.codex_spare' }], antigravity: [{ dir: '/h/.gemini_lab' }] };
  const touched = [];
  const sw = run(`${fnSource('switchSessionAgentHome')}; switchSessionAgentHome`, {
    resolveSessionInternalName: (n) => n,
    sessionAgentKind: () => 'claude',
    listAgentHomes: (agent) => homes[agent],
    // Anything past the check would come here.
    getSessionConfig: () => { touched.push('config'); return {}; },
    getEffectiveSessionConfig: () => { touched.push('config'); return {}; }
  });
  for (const dir of ['/h/.codex_spare', '/h/.gemini_lab']) {
    const r = await sw('s_c', dir);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, `No claude account at ${dir}`);
  }
  assert.deepEqual(touched, []);
  // A Claude folder is never offered to Codex or Antigravity either.
  const exists = () => true;
  const entries = ['.claude', '.claude2', '.codex', '.codex_spare1', '.gemini', '.gemini_lab'];
  assert.ok(agentHomesLib.discoverAgentHomes('codex', { homeDir: '/h', entries, exists, envDir: null }).every((h) => /\/\.codex/.test(h.dir)));
  assert.ok(agentHomesLib.discoverAgentHomes('claude', { homeDir: '/h', entries, exists, envDir: null }).every((h) => /\/\.claude/.test(h.dir)));
});

test('a session stopped a day ago is still moved: sessions are kept running as long as any account can', async () => {
  const env = sweepEnv({ entries: [live('s_old')], stops: { s_old: stopAt(25 * 60) }, accounts: [account('a', FULL), account('b', ROOMY)] });
  await env.sweep();
  assert.deepEqual(env.calls.moves, [['s_old', 'b']]);
  assert.equal(env.calls.continues.length, 1);
});

// The Fable week is its own limit: a Fable session can stop on it while its
// account has room for everything else.
const fableRow = (percent) => ({ kind: 'weekly_scoped', group: 'weekly', percent, resets_at: LATER, scope: { model: { display_name: 'Fable' } } });
const fableStop = (minutesAgo) => ({ at: Date.now() - minutesAgo * 60_000, text: "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model." });

test('only the Fable limit hit: a Fable session moves to an account with Fable left, even past one with more room overall', async () => {
  const accounts = [
    account('a', claudeUsage([row('weekly_all', 50), fableRow(100)])),   // its own: Fable spent
    account('opus-roomy', claudeUsage([row('weekly_all', 5), fableRow(100)])),
    account('fable-left', claudeUsage([row('weekly_all', 60), fableRow(20)]))
  ];
  const env = sweepEnv({ entries: [live('s_f', { agentModel: 'claude-fable-5-2' })], stops: { s_f: fableStop(1) }, accounts });
  await env.sweep();
  assert.deepEqual(env.calls.moves, [['s_f', 'fable-left']]);
  assert.match(env.calls.continues[0][1], /^Continue where you left off/);
});

test('only the Fable limit hit and no account has Fable left: it waits for the first Fable reset, then moves', async () => {
  const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
  const spentFor5h = claudeUsage([{ kind: 'session', group: 'session', percent: 100, resets_at: soon, scope: null }, row('weekly_all', 45), fableRow(70)]);
  const accounts = [account('a', claudeUsage([row('weekly_all', 74), fableRow(100)])), account('b', spentFor5h)];
  const env = sweepEnv({ entries: [live('s_f', { agentModel: 'claude-fable-5-2' })], stops: { s_f: fableStop(25 * 60) }, accounts });
  await env.sweep();
  assert.deepEqual(env.calls.moves, []);
  assert.deepEqual(env.waiting().map((w) => [w.session, w.reason, w.until]), [['s_f', 'no account in the rotation has room', Date.parse(soon)]]);
  // b's five hours are up: now it goes.
  accounts[1] = account('b', claudeUsage([row('weekly_all', 45), fableRow(70)]));
  await env.sweep();
  assert.deepEqual(env.calls.moves, [['s_f', 'b']]);
});

// ---- banked resets (Codex), and accounts used up first -----------------------

const codexUsage = (percent, { resets = 0, credits = false, expires = null } = {}) => agentUsage.parseCodexUsage(
  { account: { planType: 'prolite', email: null } },
  {
    ordinaryUsageAllowed: percent < 100,
    rateLimits: { limitId: 'codex', primary: { usedPercent: percent, windowDurationMins: 10080, resetsAt: Math.round((NOW + 3 * 86400_000) / 1000) },
      credits: credits ? { hasCredits: true, unlimited: false, balance: '500.4' } : null, rateLimitReachedType: percent >= 100 ? 'rate_limit_reached' : null },
    rateLimitResetCredits: { availableCount: resets, credits: Array.from({ length: resets }, (_, i) => ({ id: `r${i}`, status: 'available', expiresAt: expires ? Math.round(expires / 1000) + i : null })) }
  });
const cx = (name, more = {}) => live(name, { agent: 'codex', agentModel: 'gpt-6.2', agentHome: { dir: 'default' }, ...more });
const codexAccounts = (list) => ({ claude: [], codex: list, antigravity: [] });

test('the Codex reading keeps the banked resets, when they expire, and the paid credits', () => {
  const u = codexUsage(100, { resets: 2, credits: true, expires: NOW + 86400_000 });
  assert.equal(u.resets, 2);
  assert.equal(u.resetsExpire.length, 2);
  assert.ok(u.resetsExpire[0] <= u.resetsExpire[1]);
  assert.deepEqual(u.credits, { has: true, unlimited: false, balance: 500.4 });
  assert.equal(agentUsage.onPaidUsage(u, 'gpt-6.2'), true, 'past its limit, still running on credits');
  assert.equal(agentUsage.onPaidUsage(codexUsage(40, { credits: true }), 'gpt-6.2'), false, 'within its limit: the plan pays');
  assert.equal(agentUsage.onPaidUsage(codexUsage(100), 'gpt-6.2'), false, 'no credits: it simply stops');
});

test('stopped on an account to be used up first: one of its own resets is spent, and it continues there', async () => {
  const env = sweepEnv({
    entries: [cx('s_1', { agentHome: { dir: 'spare1' } })], stops: { s_1: stopAt(1) },
    byAgent: codexAccounts([account('spare1', codexUsage(100, { resets: 3 }), { spendFirst: true }), account('other', codexUsage(0))])
  });
  await env.sweep();
  assert.deepEqual(env.calls.resets, ['spare1']);
  assert.deepEqual(env.calls.moves, [], 'no move: the account itself has room again');
  assert.equal(env.calls.continues.length, 1);
  assert.match(env.calls.continues[0][1], /has been reset/);
  assert.deepEqual(env.calls.actions.map((a) => [a.kind, a.to]), [['reset', 'spare1']]);
});

test('stopped elsewhere: an account to be used up first is preferred over one with more room', async () => {
  const env = sweepEnv({
    entries: [cx('s_1')], stops: { s_1: stopAt(1) },
    byAgent: codexAccounts([account('default', codexUsage(100, { resets: 3 })), account('other', codexUsage(0)), account('spare1', codexUsage(60), { spendFirst: true })])
  });
  await env.sweep();
  assert.deepEqual(env.calls.moves, [['s_1', 'spare1']]);
  assert.deepEqual(env.calls.resets, [], "free room comes before the default's own banked resets");
});

test('an account to be used up first, at its limit with resets: reset there and move there, before free room elsewhere', async () => {
  const env = sweepEnv({
    entries: [cx('s_1')], stops: { s_1: stopAt(1) },
    byAgent: codexAccounts([account('default', codexUsage(100, { resets: 3 })), account('other', codexUsage(0)), account('spare2', codexUsage(100, { resets: 2 }), { spendFirst: true })])
  });
  await env.sweep();
  assert.deepEqual(env.calls.resets, ['spare2']);
  assert.deepEqual(env.calls.moves, [['s_1', 'spare2']]);
  assert.deepEqual(env.calls.actions.map((a) => a.kind), ['reset', 'move']);
  assert.match(env.calls.continues[0][1], /moved this session to another account/);
});

test('no room anywhere: its own banked reset is spent rather than waiting', async () => {
  const env = sweepEnv({
    entries: [cx('s_1')], stops: { s_1: stopAt(1) },
    byAgent: codexAccounts([account('default', codexUsage(100, { resets: 1 })), account('other', codexUsage(100))])
  });
  await env.sweep();
  assert.deepEqual(env.calls.resets, ['default']);
  assert.deepEqual(env.waiting(), []);
});

test('a reset hop just spent is not spent again on a reading from before it', () => {
  const own = account('spare1', codexUsage(100, { resets: 2 }), { spendFirst: true, lastResetAt: Date.now() - 5 * 60_000 });
  const plan = agentUsage.planForStop({ stop: stopAt(1), session: { model: 'gpt-6.2', homeDir: 'spare1' }, accounts: [own], history: [] });
  assert.equal(plan.action, 'wait');
});

test('a reset the backend refuses is recorded as a failure, and nothing is typed', async () => {
  const env = sweepEnv({
    entries: [cx('s_1', { agentHome: { dir: 'spare1' } })], stops: { s_1: stopAt(1) },
    byAgent: codexAccounts([account('spare1', codexUsage(100, { resets: 1 }), { spendFirst: true })]),
    resetOutcome: { outcome: 'noCredit' }
  });
  await env.sweep();
  assert.deepEqual(env.calls.continues, []);
  assert.deepEqual(env.calls.actions.map((a) => a.kind), ['failed']);
});

test('idle on an account spending paid credits: moved to one to be used up first, with nothing typed', async () => {
  const quiet = { lastActivityAt: Date.now() - 10 * 60_000 };
  const env = sweepEnv({
    entries: [cx('s_1', quiet)], stops: {},
    byAgent: codexAccounts([account('default', codexUsage(100, { resets: 3, credits: true })), account('other', codexUsage(0)), account('spare1', codexUsage(0), { spendFirst: true })])
  });
  await env.sweep();
  assert.deepEqual(env.calls.moves, [['s_1', 'spare1']]);
  assert.deepEqual(env.calls.continues, [], 'it was not stopped: nothing to continue');
  assert.equal(env.calls.actions[0].paid, true);
});

test('idle on paid credits, but someone is at it: text in its box, or output just now — left alone', async () => {
  const accounts = codexAccounts([account('default', codexUsage(100, { credits: true })), account('spare1', codexUsage(0), { spendFirst: true })]);
  const typing = sweepEnv({ entries: [cx('s_1', { lastActivityAt: Date.now() - 600_000 })], stops: {}, byAgent: accounts, boxes: { s_1: { state: { found: true, isEmpty: false }, working: false } } });
  await typing.sweep();
  assert.deepEqual(typing.calls.moves, []);
  const fresh = sweepEnv({ entries: [cx('s_1', { lastActivityAt: Date.now() - 5_000 })], stops: {}, byAgent: accounts });
  await fresh.sweep();
  assert.deepEqual(fresh.calls.moves, []);
  const working = sweepEnv({ entries: [cx('s_1', { lastActivityAt: Date.now() - 600_000 })], stops: {}, byAgent: accounts, working: ['s_1'] });
  await working.sweep();
  assert.deepEqual(working.calls.moves, []);
});

test('idle within its plan: not read again while a recent reading says so, and never moved', async () => {
  const env = sweepEnv({
    entries: [cx('s_1', { lastActivityAt: 0 })], stops: {},
    byAgent: codexAccounts([account('default', codexUsage(30)), account('spare1', codexUsage(0), { spendFirst: true })]),
    cached: { default: { at: Date.now() - 60_000, usage: codexUsage(30) } }
  });
  await env.sweep();
  assert.equal(env.calls.listed, 0);
  assert.deepEqual(env.calls.moves, []);
});

test('the sweep finishes without a failure in every one of these', async () => {
  const env = sweepEnv({
    entries: [cx('s_1', { lastActivityAt: 0 }), cx('s_2')], stops: { s_2: stopAt(1) },
    byAgent: codexAccounts([account('default', codexUsage(100, { resets: 1, credits: true })), account('spare1', codexUsage(100, { resets: 1 }), { spendFirst: true })])
  });
  await env.sweep();
  await env.sweep();
  assert.deepEqual(env.calls.logs.filter((l) => /sweep failed/.test(l)), []);
});
