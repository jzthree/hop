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
  return home;
};
const run = (home, session, payload) => execFileSync(process.execPath, [HOOK, JSON.stringify(payload)], {
  env: { ...process.env, HOP_HOME: home, HOP_SESSION: session }
});
const turn = (home, name) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'claude-sessions', `${name}.turn`), 'utf8')); } catch { return null; } };

test('a turn is counted against HOP_SESSION when no other session claims the thread', () => {
  const home = freshHome();
  run(home, 'alpha', { type: 'agent-turn-complete', 'thread-id': 'thread-A', 'turn-id': 't1' });
  assert.equal(turn(home, 'alpha').count, 1);
  assert.equal(turn(home, 'alpha').sessionId, 'thread-A');
  assert.equal(turn(home, 'alpha').agent, 'codex');
});

test("under a shared daemon the environment lies: the session whose record already names the thread gets the turn", () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, 'claude-sessions', 'surf.turn'), JSON.stringify({ sessionId: 'thread-S', count: 4, at: '2026-09-28T22:46:53.450Z', agent: 'codex' }));
  fs.writeFileSync(path.join(home, 'claude-sessions', 'owner.turn'), JSON.stringify({ sessionId: 'thread-O', count: 9, at: '2026-09-29T20:00:00.000Z', agent: 'codex' }));
  // The daemon runs notify with HOP_SESSION=owner, for surf's thread.
  run(home, 'owner', { type: 'agent-turn-complete', 'thread-id': 'thread-S', 'turn-id': 't2' });
  assert.equal(turn(home, 'surf').count, 5, 'surf got its turn');
  assert.equal(turn(home, 'surf').sessionId, 'thread-S');
  assert.equal(turn(home, 'owner').count, 9, 'the owner was not credited with it');
  assert.equal(turn(home, 'owner').sessionId, 'thread-O', "and the owner's own thread id was not overwritten");
  // The owner's own turn still lands on the owner.
  run(home, 'owner', { type: 'agent-turn-complete', 'thread-id': 'thread-O', 'turn-id': 't3' });
  assert.equal(turn(home, 'owner').count, 10);
});

test('other event types count nothing', () => {
  const home = freshHome();
  run(home, 'alpha', { type: 'something-else', 'thread-id': 'thread-A' });
  assert.equal(turn(home, 'alpha'), null);
});
