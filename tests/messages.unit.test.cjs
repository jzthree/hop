// Messages between sessions: who the recipient is told sent it, how it may
// answer, who is free to talk, and the brakes on two agents talking forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCheckback } = require('../lib/checkbacks');
const { envelope, typedText, stripEnvelope, presence, pairTraffic, mayAnswer, shellName, PAIR_MAX } = require('../lib/messages');

const NOW = Date.parse('2026-11-10T18:00:00.000Z');
const M = 60_000;

test('a message from another session names it, says it is not the user, and how to answer', () => {
  const cb = normalizeCheckback({ session: 's_b', message: 'Rerun the eval on results/af.csv', idle: true, queued: true, from: 'surf', fromSession: 's_a', fromName: 'surf', fromAgent: 'codex' }, NOW);
  assert.equal(cb.message, 'Rerun the eval on results/af.csv', 'stored as written: the queue card shows and edits it');
  assert.equal(typedText(cb), '[hop message from session "surf" (a Codex agent, not your user). To answer, if an answer is needed: hop send surf "<your reply>"] Rerun the eval on results/af.csv');
  // An agent's article, and a name that needs quoting in the reply command.
  const agy = normalizeCheckback({ session: 's_b', message: 'hi', idle: true, queued: true, fromSession: 's_a', fromName: 'nebula notebook 2', fromAgent: 'antigravity' }, NOW);
  assert.match(typedText(agy), /^\[hop message from session "nebula notebook 2" \(an Antigravity agent, not your user\)\. To answer, if an answer is needed: hop send "nebula notebook 2" "<your reply>"\] hi$/);
});

test('a sender reading the reply off this turn says so instead (no second reply)', () => {
  const cb = normalizeCheckback({ session: 's_b', message: 'status?', idle: true, queued: true, fromSession: 's_mgr', fromName: 'manager', fromAgent: 'claude', replyHere: true }, NOW);
  assert.equal(typedText(cb), '[hop message from session "manager" (a Claude agent, not your user). It reads your reply here.] status?');
});

test('nobody else wrote it: typed as is', () => {
  // The person (web, phone), and a reminder a session set itself.
  assert.equal(typedText(normalizeCheckback({ session: 's_b', message: 'go on', idle: true, queued: true, from: 'you' }, NOW)), 'go on');
  const self = normalizeCheckback({ session: 's_b', message: 'check the job', in: '30m', fromSession: 's_b', fromName: 'me', fromAgent: 'claude' }, NOW);
  assert.equal(self.fromSession, undefined);
  assert.equal(typedText(self), 'check the job');
  // A shell session sends: named, but not claimed to be an agent.
  const shell = normalizeCheckback({ session: 's_b', message: 'x', idle: true, queued: true, fromSession: 's_sh', fromName: 'scratch', fromAgent: null }, NOW);
  assert.match(typedText(shell), /^\[hop message from session "scratch"\. To answer/);
});

test('an agent outside hop is marked as one; a bad sender id is ignored', () => {
  const out = normalizeCheckback({ session: 's_b', message: 'x', idle: true, queued: true, fromOutside: true }, NOW);
  assert.equal(typedText(out), '[hop message from an agent outside hop, not your user] x');
  const bad = normalizeCheckback({ session: 's_b', message: 'x', idle: true, queued: true, fromSession: '../etc', fromName: 'evil' }, NOW);
  assert.equal(bad.fromSession, undefined);
  assert.equal(typedText(bad), 'x');
});

test('a scheduled check-back from another session carries its sender too', () => {
  const cb = normalizeCheckback({ session: 's_b', message: 'job done?', in: '1h', fromSession: 's_a', fromName: 'planner', fromAgent: 'claude' }, NOW);
  assert.match(typedText(cb), /^\[hop message from session "planner" \(a Claude agent, not your user\)/);
});

test('the sender line comes off for taglines, and only it', () => {
  assert.equal(stripEnvelope(envelope({ name: 'surf', agent: 'codex' }) + ' Rerun the eval'), 'Rerun the eval');
  assert.equal(stripEnvelope('[hop message from an agent outside hop, not your user] hello'), 'hello');
  assert.equal(stripEnvelope('[1] keep this'), '[1] keep this');
});

test('shell names: bare when safe, quoted when not', () => {
  assert.equal(shellName('surf-2.b'), 'surf-2.b');
  assert.equal(shellName('a b'), '"a b"');
  assert.equal(shellName('say "hi" $HOME'), '"say \\"hi\\" \\$HOME"');
});

test('presence: free, busy, needs its user, a shell, offline', () => {
  assert.equal(presence({ live: true, agent: 'claude', agentPhase: 'done' }), 'free');
  assert.equal(presence({ live: true, agent: 'codex', agentPhase: 'working' }), 'busy');
  assert.equal(presence({ live: true, agent: 'claude', agentPhase: 'working', attentionReason: 'ask' }), 'needs-user');
  assert.equal(presence({ live: true, agent: null }), 'shell');
  assert.equal(presence({ live: false, agent: 'claude' }), 'offline');
  assert.equal(presence(null), 'offline');
});

test('pair traffic counts both directions within the window', () => {
  const msg = (from, to, ago) => ({ fromSession: from, session: to, createdAt: NOW - ago });
  const items = [msg('a', 'b', 1 * M), msg('b', 'a', 2 * M), msg('a', 'c', 1 * M), msg('a', 'b', 30 * M), { session: 'b', createdAt: NOW }];
  assert.equal(pairTraffic(items, 'a', 'b', NOW), 2);
  assert.equal(pairTraffic(items, 'b', 'a', NOW), 2);
  assert.ok(PAIR_MAX >= 6, 'room for a real exchange');
});

test('whoever wrote to you may be answered, for a day', () => {
  const items = [{ fromSession: 'a', session: 'b', createdAt: NOW - 5 * M, deliveredAt: NOW - 4 * M }];
  assert.equal(mayAnswer(items, 'b', 'a', NOW), true, 'b answers a');
  assert.equal(mayAnswer(items, 'a', 'b', NOW), false, 'a did not hear from b');
  assert.equal(mayAnswer(items, 'c', 'a', NOW), false);
  assert.equal(mayAnswer(items, 'b', 'a', NOW + 25 * 60 * M), false, 'not forever');
});
