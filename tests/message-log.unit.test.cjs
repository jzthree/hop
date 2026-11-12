// The message log: what sessions said to each other, kept for their person
// after the queue has forgotten the deliveries.
const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyLog, normalizeLog, record, mirror, awaitingReply, noteReply, prune, KEEP_MS, KEEP_MAX } = require('../lib/message-log');

const NOW = Date.parse('2026-11-12T06:00:00.000Z');
const M = 60_000;

test('a message is kept as sent, and the queue says what became of it', () => {
  const log = emptyLog();
  record(log, { id: 'cb_1', from: 's_a', fromName: 'surf', fromAgent: 'codex', to: 's_b', toName: 'eval', text: 'Rerun the eval', at: NOW, status: 'waiting' }, NOW);
  assert.equal(log.messages.length, 1);
  assert.equal(log.messages[0].status, 'waiting');

  // Waiting with a reason, then delivered.
  assert.equal(mirror(log, { id: 'cb_1', status: 'pending', lastError: 'sends when the turn ends' }), true);
  assert.equal(log.messages[0].reason, 'sends when the turn ends');
  assert.equal(mirror(log, { id: 'cb_1', status: 'pending', lastError: 'sends when the turn ends' }), false, 'no change, no write');
  assert.equal(mirror(log, { id: 'cb_1', status: 'delivered', deliveredAt: NOW + M }), true);
  assert.equal(log.messages[0].status, 'delivered');
  assert.equal(log.messages[0].deliveredAt, NOW + M);
  assert.equal(log.messages[0].reason, undefined, 'the waiting reason goes once it is delivered');

  // Something the log never saw is not invented.
  assert.equal(mirror(log, { id: 'cb_x', status: 'delivered', deliveredAt: NOW }), false);
  assert.equal(log.messages.length, 1);

  // Failed and cancelled.
  record(log, { id: 'cb_2', from: 's_a', to: 's_b', text: 'x', at: NOW }, NOW);
  mirror(log, { id: 'cb_2', status: 'failed', lastError: "it didn't submit" });
  assert.equal(log.messages[1].status, 'failed');
  assert.equal(log.messages[1].reason, "it didn't submit");
  record(log, { id: 'cb_3', from: null, to: 's_b', text: 'from outside', at: NOW }, NOW);
  mirror(log, { id: 'cb_3', status: 'cancelled' });
  assert.equal(log.messages[2].status, 'cancelled');
  assert.equal(log.messages[2].from, null, 'an agent outside hop');
});

test('send-and-wait: the answer is the recipient\'s next finished turn, not an earlier one', () => {
  const log = emptyLog();
  record(log, { id: 'cb_w', from: 's_boss', to: 's_w', text: 'Status?', at: NOW, replyHere: true }, NOW);
  mirror(log, { id: 'cb_w', status: 'delivered', deliveredAt: NOW + M, replyHere: true }, { turnCount: 7 });
  assert.equal(log.messages[0].turnBase, 7);
  assert.equal(awaitingReply(log, NOW + 2 * M).length, 1);

  // The turn that was already done when it went in: not the answer.
  assert.equal(noteReply(log.messages[0], { count: 7, at: new Date(NOW).toISOString(), lastMessage: 'older' }), false);
  // A turn counted but finished before delivery (clock skew, a stale file): not either.
  assert.equal(noteReply(log.messages[0], { count: 8, at: new Date(NOW).toISOString(), lastMessage: 'stale' }), false);
  // The next one: the answer.
  assert.equal(noteReply(log.messages[0], { count: 8, at: new Date(NOW + 3 * M).toISOString(), lastMessage: 'Two runs left, ETA 40 min.' }), true);
  assert.equal(log.messages[0].reply, 'Two runs left, ETA 40 min.');
  assert.equal(awaitingReply(log, NOW + 4 * M).length, 0, 'answered once');

  // A message nobody waits on is never given an answer.
  record(log, { id: 'cb_n', from: 's_boss', to: 's_w', text: 'FYI', at: NOW }, NOW);
  mirror(log, { id: 'cb_n', status: 'delivered', deliveredAt: NOW + M }, { turnCount: 8 });
  assert.equal(awaitingReply(log, NOW + 2 * M).some((m) => m.id === 'cb_n'), false);
});

test('a month is kept, at most KEEP_MAX, oldest first; a bad file reads as empty', () => {
  const log = emptyLog();
  record(log, { id: 'old', from: 's_a', to: 's_b', text: 'old', at: NOW - KEEP_MS - M }, NOW - KEEP_MS - M);
  record(log, { id: 'new', from: 's_a', to: 's_b', text: 'new', at: NOW }, NOW);
  assert.deepEqual(log.messages.map((m) => m.id), ['new']);
  for (let i = 0; i < KEEP_MAX + 5; i++) log.messages.push({ id: `x${i}`, to: 's_b', at: NOW - KEEP_MAX + i, text: '' });
  prune(log, NOW + 1);
  assert.equal(log.messages.length, KEEP_MAX);
  assert.ok(log.messages[0].at <= log.messages[log.messages.length - 1].at);
  assert.deepEqual(normalizeLog({ messages: [{ id: 1 }, null, { id: 'ok', to: 's', at: NOW }] }).messages.map((m) => m.id), ['ok']);
  assert.deepEqual(normalizeLog('nonsense').messages, []);
});
