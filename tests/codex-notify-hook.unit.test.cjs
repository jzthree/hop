// The Codex notify wrapper: which session a finished turn is counted against.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'codex-notify-hook.js');
const freshHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-codex-hook-'));
  fs.mkdirSync(path.join(home, 'claude-sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'codex', 'sessions', '2026', '10', '12'), { recursive: true });
  return home;
};
// A thread Codex saved has a rollout file named after it.
const saveRollout = (home, id) => fs.writeFileSync(
  path.join(home, 'codex', 'sessions', '2026', '10', '12', `rollout-2026-10-12T00-00-00-${id}.jsonl`),
  JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
const run = (home, session, payload) => execFileSync(process.execPath, [HOOK, JSON.stringify(payload)], {
  env: { ...process.env, HOP_HOME: home, HOP_SESSION: session, CODEX_HOME: path.join(home, 'codex') }
});
const turn = (home, name) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'claude-sessions', `${name}.turn`), 'utf8')); } catch { return null; } };

test('a turn is counted against HOP_SESSION when no other session claims the thread', () => {
  const home = freshHome();
  run(home, 'alpha', { type: 'agent-turn-complete', 'thread-id': 'thread-A', 'turn-id': 't1' });
  assert.equal(turn(home, 'alpha').count, 1);
  assert.equal(turn(home, 'alpha').sessionId, 'thread-A');
  assert.equal(turn(home, 'alpha').agent, 'codex');
});

test('the turn belongs to the session it ran in, even when another record names the thread', () => {
  // Retired rule: "a record already naming this thread owns it" filed the
  // hand-off session's turns under angler-codex for good. Every hop launch
  // now carries its own session, so the environment is the truth.
  const home = freshHome();
  saveRollout(home, 'thread-H'); saveRollout(home, 'thread-A');
  fs.writeFileSync(path.join(home, 'claude-sessions', 'angler.turn'), JSON.stringify({ sessionId: 'thread-H', count: 9, at: '2026-10-09T00:00:00.000Z', agent: 'codex' }));
  run(home, 'handoff', { type: 'agent-turn-complete', 'thread-id': 'thread-H', 'turn-id': 't1' });
  assert.equal(turn(home, 'handoff').sessionId, 'thread-H');
  assert.equal(turn(home, 'handoff').count, 1);
  assert.equal(turn(home, 'angler').count, 9, 'the other record is left alone');
});

test("a thread Codex never saved (a helper like the approval guardian) does not replace the session's conversation", () => {
  const home = freshHome();
  saveRollout(home, 'thread-main');
  run(home, 'alpha', { type: 'agent-turn-complete', 'thread-id': 'thread-main', 'turn-id': 't1' });
  run(home, 'alpha', { type: 'agent-turn-complete', 'thread-id': 'thread-guardian', 'turn-id': 't2' });
  assert.equal(turn(home, 'alpha').sessionId, 'thread-main', 'still the saved thread');
  assert.equal(turn(home, 'alpha').count, 2, 'the turn still counts');
  // A NEW saved thread (the person started over) does take over.
  saveRollout(home, 'thread-next');
  run(home, 'alpha', { type: 'agent-turn-complete', 'thread-id': 'thread-next', 'turn-id': 't3' });
  assert.equal(turn(home, 'alpha').sessionId, 'thread-next');
});

test('other event types count nothing', () => {
  const home = freshHome();
  run(home, 'alpha', { type: 'something-else', 'thread-id': 'thread-A' });
  assert.equal(turn(home, 'alpha'), null);
});
