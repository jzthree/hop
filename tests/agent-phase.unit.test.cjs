// The wall's three agent colours — working / done / done-and-read — decided
// from the records hop keeps, the same way for the web and the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { agentPhase } = require('../lib/agent-phase');

const NOW = 1_800_000_000_000;
const s = (o) => agentPhase({ agent: 'claude', now: NOW, ...o });

test('a plain shell has no phase', () => {
  assert.deepEqual(agentPhase({ agent: null, turnAt: NOW - 1000, lastActivityAt: NOW, now: NOW }), { phase: null, turnSeen: true });
});

test('claude with the prompt hook: a prompt newer than the last turn end is WORKING while the screen moves', () => {
  assert.equal(s({ turnAt: NOW - 60_000, promptAt: NOW - 5_000, lastActivityAt: NOW - 2_000 }).phase, 'working');
  // Thinking for a while with a slow spinner still counts.
  assert.equal(s({ turnAt: NOW - 60_000, promptAt: NOW - 30_000, lastActivityAt: NOW - 20_000 }).phase, 'working');
});

test('an interrupted prompt (dead quiet for long) is not working forever', () => {
  const r = s({ turnAt: NOW - 600_000, promptAt: NOW - 300_000, lastActivityAt: NOW - 120_000, lastUserSeenAt: NOW - 100_000 });
  assert.equal(r.phase, 'done');
  assert.equal(r.turnSeen, true);
});

test('codex (no prompt hook): output flowing after the last turn ended is WORKING', () => {
  assert.equal(agentPhase({ agent: 'codex', turnAt: NOW - 60_000, lastActivityAt: NOW - 3_000, now: NOW }).phase, 'working');
});

test('the final render right after the Stop hook is the turn\'s own output, not a new turn', () => {
  assert.equal(s({ turnAt: NOW - 3_000, lastActivityAt: NOW - 2_200 }).phase, 'done');
});

test('quiet after a turn is DONE; unread until a user client has been on it since', () => {
  assert.deepEqual(s({ turnAt: NOW - 60_000, lastActivityAt: NOW - 61_000, lastUserSeenAt: NOW - 120_000 }), { phase: 'done', turnSeen: false });
  assert.deepEqual(s({ turnAt: NOW - 60_000, lastActivityAt: NOW - 61_000, lastUserSeenAt: NOW - 30_000 }), { phase: 'done', turnSeen: true });
  assert.deepEqual(s({ turnAt: NOW - 60_000, lastActivityAt: NOW - 61_000, lastUserSeenAt: 0 }), { phase: 'done', turnSeen: false });
});

test('a user attached right now has read whatever just finished', () => {
  assert.deepEqual(s({ turnAt: NOW - 1_000, lastActivityAt: NOW - 2_000, lastUserSeenAt: 0, userAttached: true }), { phase: 'done', turnSeen: true });
});

test('an agent session that has never completed a turn and is quiet has no phase', () => {
  assert.equal(s({ turnAt: 0, lastActivityAt: NOW - 60_000 }).phase, null);
  assert.equal(s({ turnAt: 0, lastActivityAt: NOW - 1_000 }).phase, 'working');
});
