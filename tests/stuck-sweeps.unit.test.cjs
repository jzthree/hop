'use strict';
// One screen read that never settled held the check-back sweep, the tagline
// loop and the resume-prompt sweep for two days (Nov 15): xterm's parser
// threw on its own timer, so the write's callback never came, and the read
// waiting on it was shared with every later caller for that room. These
// pieces of the daemon, run on their own, must each give up in time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'hop'), 'utf8');

// The source of one top-level function in hop, up to its matching brace.
function fnSource(name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(SRC);
  assert.ok(m, `hop defines ${name}`);
  let depth = 0;
  for (let i = SRC.indexOf('{', m.index); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(m.index, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
const run = (code, sandbox) => vm.runInNewContext(code, { setTimeout, clearTimeout, Promise, Date, ...sandbox });
const within = (ms, p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`still waiting after ${ms}ms`)), ms))]);

// A terminal whose parser throws partway, the way xterm's did: on its own
// timer, so the callback is never called and nothing reaches the caller.
const brokenTerm = () => ({ write() { setTimeout(() => { /* threw here: callback lost */ }, 1); }, dispose() {} });

test('a grid write whose parser broke gives up instead of waiting forever', async () => {
  const writeGridTerm = run(`const GRID_WRITE_TIMEOUT_MS = 50; ${fnSource('writeGridTerm')}; writeGridTerm`, {});
  assert.equal(await within(1000, writeGridTerm(brokenTerm(), 'x')), false);
  const ok = { write(d, cb) { setTimeout(cb, 1); } };
  assert.equal(await within(1000, writeGridTerm(ok, 'x')), true);
  const throws = { write() { throw new Error('sync'); } };
  assert.equal(await within(1000, writeGridTerm(throws, 'x')), false);
});

test('a shared screen read that never settles is not handed to later callers', async () => {
  const calls = [], disposed = [], logs = [];
  let hang = true;
  const env = run(`const roomGridInflight = new Map(); const ROOM_GRID_READ_TIMEOUT_MS = 50; const YELLOW = '';
    ${fnSource('getRoomGridPreviewShared')}; ({ getRoomGridPreviewShared, roomGridInflight })`, {
    getRoomGridPreview: (n) => { calls.push(n); return hang ? new Promise(() => {}) : Promise.resolve({ text: 'screen' }); },
    disposeRoomGrid: (n) => disposed.push(n),
    log: (m) => logs.push(m)
  });
  const a = env.getRoomGridPreviewShared('s_x');
  const b = env.getRoomGridPreviewShared('s_x');
  assert.equal(calls.length, 1, 'concurrent callers still share one read');
  assert.equal(await within(1000, a), null);
  assert.equal(await within(1000, b), null);
  assert.deepEqual(disposed, ['s_x'], 'the grid behind the stuck read is thrown away');
  assert.equal(env.roomGridInflight.size, 0);
  assert.match(logs[0], /didn't finish/);
  hang = false;
  assert.deepEqual(await within(1000, env.getRoomGridPreviewShared('s_x')), { text: 'screen' });
  assert.equal(calls.length, 2, 'the next caller reads afresh');
});

test('a check-back probe past its time limit leaves nothing running', { skip: process.platform === 'win32' }, async () => {
  const runShellProbe = run(`const SHELL_PROBE_TIMEOUT_MS = 400; const HOME_DIR = ${JSON.stringify(process.cwd())};
    ${fnSource('runShellProbe')}; runShellProbe`, { spawn, process });
  assert.equal(await within(5000, runShellProbe('exit 0')), 0);
  assert.equal(await within(5000, runShellProbe('exit 3')), 3);
  // An ssh hung on a dropped network, at the head of a pipe: killing the
  // shell alone (execFile's timeout) left it running, one more every probe.
  const marker = `hop-probe-${process.pid}-${Date.now()}`;
  const t0 = Date.now();
  const code = await within(5000, runShellProbe(`sh -c 'sleep 30' ${marker} | cat`));
  assert.notEqual(code, 0);
  assert.ok(Date.now() - t0 < 3000, 'gave up at its limit');
  await new Promise((r) => setTimeout(r, 200));
  let left = '';
  try { left = execFileSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' }); } catch (e) { /* none: exit 1 */ }
  assert.equal(left.trim(), '', 'nothing of the probe is left running');
});

test('a sweep that never finishes is left behind and the next one delivers', async () => {
  const delivered = [], logs = [];
  let firstSnapshot = true;
  const store = { items: [{ id: 'cb_1', session: 's_a', status: 'pending', queued: true, trigger: { kind: 'idle' } }] };
  const env = run(`let shuttingDown = false; const YELLOW = '';
    const CHECKBACK_SWEEP_STUCK_MS = 100; let checkbackSweepBusy = false; let checkbackSweepStartedAt = 0; let checkbackSweepGen = 0;
    ${fnSource('runCheckbackSweep')}; runCheckbackSweep`, {
    fs,
    log: (m) => logs.push(m),
    loadCheckbacks: () => store,
    // The first sweep hangs here for good; later ones get the session idle.
    listAllSessionEntriesRuntimeFirst: () => (firstSnapshot ? (firstSnapshot = false, new Promise(() => {})) : Promise.resolve({ entries: [{ internalName: 's_a', live: true }] })),
    agentPhaseFieldsForAll: async () => new Map([['s_a', { agentPhase: 'idle' }]]),
    checkbacks: { cmdDue: () => false, triggerFired: () => true, mayDeliver: () => true },
    runShellProbe: async () => 1,
    agentScreenReady: async () => ({ ok: true }),
    deliverIntoAgent: async (cb) => { delivered.push(cb.id); return { ok: true }; },
    applyDelivery: (cb, r) => { if (r.ok) cb.status = 'delivered'; return true; },
    saveCheckbacks: () => {},
    pruneCheckbacks: () => {}
  });
  env(); // hangs
  await env(); // busy: returns at once
  assert.deepEqual(delivered, []);
  await new Promise((r) => setTimeout(r, 150));
  await within(1000, env());
  assert.deepEqual(delivered, ['cb_1']);
  assert.match(logs.join('\n'), /never finished/);
  await within(1000, env());
  assert.deepEqual(delivered, ['cb_1'], 'sent once');
});
