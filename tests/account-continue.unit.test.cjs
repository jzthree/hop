'use strict';
// After the rotation moves a session to another account, hop types
// "continue" — soon (as soon as the relaunched claude shows its input box),
// and only while the conversation still ends on the usage-limit notice: once
// the person's own "continue" got it going, hop's would start a stray turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const checkbacks = require('../lib/checkbacks');

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
const constSource = (name) => {
  const m = new RegExp(`^const ${name} = .*;$`, 'm').exec(SRC);
  assert.ok(m, `hop defines ${name}`);
  return m[0];
};
const run = (code, sandbox) => vm.runInNewContext(code, { Date, Math, JSON, Number, String, Map, Set, Promise, ...sandbox });

// ---- the relaunched claude is ready for it --------------------------------------

const ready = run(`${['TRUST_PROMPT_RE', 'RESUME_PROMPT_RE', 'CLAUDE_FOOTER_RE'].map(constSource).join('\n')}
  ${fnSource('claudeInputReady')}; claudeInputReady`, {});

test('the input box at the foot of the screen, nothing asked: ready', () => {
  const screen = [
    '⏺ Reading why the evolve run failed',
    '  ⎿  $ tail -25 run.log',
    '─────────────────────────────── Fix the tunnel ─',
    '❯ ',
    '────────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  ].join('\n');
  assert.equal(ready(screen), true);
  assert.equal(ready(screen.replace('bypass permissions on (shift+tab to cycle)', 'auto mode on (shift+tab to cycle) · esc to interrupt')), true);
});

test('a startup question open at the foot of the screen: not ready', () => {
  const trust = [
    'Quick safety check: Is this a project you created or one you trust?',
    '❯ 1. Yes, I trust this folder',
    '  2. No, exit',
    'Enter to confirm · Esc to cancel'
  ].join('\n');
  assert.equal(ready(trust), false);
  const resume = ['This session is 412k tokens.', '❯ 1. Resume from summary (recommended)', '  2. Resume full session as-is', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
  assert.equal(ready(resume), false);
  assert.equal(ready(''), false);
  assert.equal(ready('jian@mac ~ % '), false, 'a shell is not claude');
});

test('a dialog answered long ago, scrolled up by the conversation, does not count', () => {
  const lines = ['Quick safety check: Is this a project you created or one you trust?', '❯ 1. Yes, I trust this folder'];
  for (let i = 0; i < 14; i++) lines.push(`⏺ step ${i}`);
  lines.push('❯ ', '  ⏵⏵ bypass permissions on (shift+tab to cycle)');
  assert.equal(ready(lines.join('\n')), true);
});

// ---- queued once per stop, marked "only if still stopped" --------------------

function continueEnv(items) {
  const store = { items };
  let saved = 0;
  const env = run(`${fnSource('continuePending')}; ${fnSource('queueContinue')}; ({ continuePending, queueContinue })`, {
    checkbacks, loadCheckbacks: () => store, saveCheckbacks: () => { saved++; }
  });
  return { ...env, store, saved: () => saved };
}

test('the continue is marked to go only to a conversation still stopped at the limit', () => {
  const env = continueEnv([]);
  const cb = env.queueContinue('burrow', 'Continue where you left off.');
  assert.equal(cb.ifStopped, true);
  assert.equal(cb.queued, true);
  assert.equal(cb.from, 'hop');
  assert.equal(env.continuePending('burrow', cb.createdAt - 1000), true, 'queued after this stop: it is the one');
});

test('a continue queued before the newest stop was for an earlier one: it goes, and the new stop is acted on', () => {
  const old = { id: 'cb_old', session: 'burrow', status: 'pending', queued: true, from: 'hop', createdBy: 'system', createdAt: 1000 };
  const theirs = { id: 'cb_theirs', session: 'burrow', status: 'pending', queued: true, from: 'you', createdBy: 'user', createdAt: 500 };
  const env = continueEnv([old, theirs]);
  assert.equal(env.continuePending('burrow', 2000), false);
  assert.equal(old.status, 'cancelled');
  assert.equal(theirs.status, 'pending', "the person's own queued message is not hop's to drop");
  assert.equal(env.saved(), 1);
});

test('the sweep asks about the continue for this very stop', () => {
  assert.match(fnSource('runAccountSweep'), /continuePending\(entry\.internalName, stop\.at\)/);
});

// ---- dropped at delivery when the conversation carried on -------------------

function deliveryEnv({ items, stillStopped }) {
  const store = { items };
  const calls = { delivered: [], logs: [] };
  const env = run(`let shuttingDown = false; let checkbackSweepBusy = false, checkbackSweepStartedAt = 0, checkbackSweepGen = 0;
    const CHECKBACK_SWEEP_STUCK_MS = 600000, YELLOW = '', DIM = '';
    ${fnSource('runCheckbackSweep')}; runCheckbackSweep`, {
    checkbacks, fs,
    log: (m) => calls.logs.push(m),
    loadCheckbacks: () => store, saveCheckbacks: () => {}, pruneCheckbacks: () => {},
    listAllSessionEntriesRuntimeFirst: async () => ({ entries: [{ internalName: 'burrow', displayName: 'burrow', live: true, lastActivityAt: 0 }] }),
    agentPhaseFieldsForAll: async () => new Map([['burrow', { agentPhase: 'done' }]]),
    runShellProbe: async () => 0,
    agentScreenReady: async () => ({ ok: true }),
    sessionStillAtLimit: () => stillStopped,
    deliverIntoAgent: async (cb) => { calls.delivered.push(cb.id); return { ok: true }; },
    applyDelivery: (cb, r) => { if (r.ok) cb.status = 'delivered'; return true; }
  });
  return { sweep: env, calls, store };
}
const hopContinue = () => ({ ...checkbacks.normalizeCheckback({ session: 'burrow', message: 'Continue where you left off.', idle: true, queued: true, from: 'hop', createdBy: 'system' }, Date.now() - 60_000), ifStopped: true });

test('still stopped at the limit: the continue is typed', async () => {
  const cb = hopContinue();
  const env = deliveryEnv({ items: [cb], stillStopped: true });
  await env.sweep();
  assert.deepEqual(env.calls.delivered, [cb.id]);
  assert.equal(cb.status, 'delivered');
});

test('carried on since (the person typed "continue"): it is dropped, not typed', async () => {
  const cb = hopContinue();
  const mine = checkbacks.normalizeCheckback({ session: 'burrow', message: 'and then tidy the README', idle: true, queued: true, from: 'you', createdBy: 'user' }, Date.now() - 60_000);
  const env = deliveryEnv({ items: [cb, mine], stillStopped: false });
  await env.sweep();
  assert.deepEqual(env.calls.delivered, [mine.id], 'only the message without the condition');
  assert.equal(cb.status, 'cancelled');
  assert.match(cb.lastError, /already carried on/);
});

test('whether it is still stopped: read from Claude and Codex conversations; Antigravity by a turn begun since', () => {
  const stops = { c_stopped: { at: 1, text: 'limit' }, x_stopped: { at: 1, text: 'limit' } };
  const kinds = { c_stopped: 'claude', c_going: 'claude', x_stopped: 'codex', x_going: 'codex', g: 'antigravity', g_typed: 'antigravity' };
  // The move at 1000; the person typed into g_typed at 1060 (2026-11-22).
  const prompts = { g: 900, g_typed: 1060 };
  const still = run(`${fnSource('sessionStillAtLimit')}; sessionStillAtLimit`, {
    sessionAgentKind: (n) => kinds[n],
    sessionLimitStop: (n, agent) => { assert.equal(agent, kinds[n]); return stops[n] || null; },
    readPromptAt: (n) => prompts[n] || 0
  });
  assert.deepEqual(['c_stopped', 'c_going', 'x_stopped', 'x_going', 'g', 'g_typed'].map((n) => still(n, 1000)), [true, false, true, false, true, false]);
  assert.equal(still('g_typed'), true, 'with no time to go by, it is assumed to wait');
});
