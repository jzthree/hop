// Check-backs: when they fire, when they may be typed, what happens after.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration, parseWhen, normalizeCheckback, triggerFired, mayDeliver, afterDelivery, cmdDue, describe } = require('../lib/checkbacks');

const NOW = Date.parse('2026-10-01T10:00:00.000Z');
const M = 60_000, H = 3_600_000;

test('durations', () => {
  assert.equal(parseDuration('45m'), 45 * M);
  assert.equal(parseDuration('2h'), 2 * H);
  assert.equal(parseDuration('1h30m'), 90 * M);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('2d'), 2 * 86_400_000);
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration('45m later'), null);
});

test('moments: a duration from now, a clock time (today, else tomorrow), an ISO date', () => {
  assert.equal(parseWhen('45m', NOW), NOW + 45 * M);
  const at = parseWhen('23:59', NOW);
  assert.ok(at > NOW && at - NOW < 86_400_000);
  const d = new Date(at); assert.equal(d.getHours(), 23); assert.equal(d.getMinutes(), 59);
  const past = parseWhen('00:01', NOW); // already passed today in any zone where NOW is after 00:01 → tomorrow
  assert.ok(past > NOW);
  assert.equal(parseWhen('2026-10-02T09:00:00Z', NOW), Date.parse('2026-10-02T09:00:00Z'));
  assert.equal(parseWhen('whenever', NOW), null);
});

test('normalize: exactly one trigger, a session, a message', () => {
  const cb = normalizeCheckback({ session: 'surf', message: 'Check the job', in: '30m' }, NOW);
  assert.equal(cb.status, 'pending'); assert.equal(cb.trigger.kind, 'at'); assert.equal(cb.trigger.at, NOW + 30 * M);
  assert.throws(() => normalizeCheckback({ session: 'surf', message: 'x' }, NOW), /exactly one trigger/);
  assert.throws(() => normalizeCheckback({ session: 'surf', message: 'x', in: '30m', idle: true }, NOW), /exactly one trigger/);
  assert.throws(() => normalizeCheckback({ session: '', message: 'x', in: '30m' }, NOW), /session/);
  assert.throws(() => normalizeCheckback({ session: 'surf', message: '  ', in: '30m' }, NOW), /message/);
  assert.throws(() => normalizeCheckback({ session: 'surf', message: 'x', every: '10s' }, NOW), /at least 1m/);
  const ev = normalizeCheckback({ session: 'surf', message: 'status?', every: '2h' }, NOW);
  assert.equal(ev.trigger.kind, 'every'); assert.equal(ev.trigger.next, NOW + 2 * H);
  const cmd = normalizeCheckback({ session: 'surf', message: 'results are in', cmd: 'test -f out.csv' }, NOW);
  assert.equal(cmd.trigger.everyMs, M); assert.equal(cmd.trigger.nextCheck, NOW);
  // `every` beside a command is its poll period; `at` beside `every` is the first slot.
  assert.equal(normalizeCheckback({ session: 'surf', message: 'm', cmd: 'true', every: '5m' }, NOW).trigger.everyMs, 5 * M);
  const slot = normalizeCheckback({ session: 'surf', message: 'm', every: '1h', at: '30m' }, NOW);
  assert.equal(slot.trigger.kind, 'every'); assert.equal(slot.trigger.next, NOW + 30 * M);
});

test('firing: at / every / idle / file / cmd', () => {
  const at = normalizeCheckback({ session: 's', message: 'm', in: '10m' }, NOW);
  assert.equal(triggerFired(at, {}, NOW + 9 * M), false);
  assert.equal(triggerFired(at, {}, NOW + 10 * M), true);
  const idle = normalizeCheckback({ session: 's', message: 'm', idle: true }, NOW);
  assert.equal(triggerFired(idle, { phase: 'working' }, NOW + M), false);
  assert.equal(triggerFired(idle, { phase: 'done' }, NOW + M), true);
  const idleFor = normalizeCheckback({ session: 's', message: 'm', idle: true, idleFor: '5m' }, NOW);
  assert.equal(triggerFired(idleFor, { phase: 'done', idleSince: NOW + M }, NOW + 3 * M), false);
  assert.equal(triggerFired(idleFor, { phase: 'done', idleSince: NOW + M }, NOW + 7 * M), true);
  const fileExists = normalizeCheckback({ session: 's', message: 'm', file: '/tmp/x' }, NOW);
  assert.equal(triggerFired(fileExists, { fileMtime: null }, NOW), false);
  assert.equal(triggerFired(fileExists, { fileMtime: NOW - 5 * M }, NOW), true, 'exists is enough when there was no baseline');
  const fileChanges = normalizeCheckback({ session: 's', message: 'm', file: '/tmp/x', baselineMtime: NOW - 5 * M }, NOW);
  assert.equal(triggerFired(fileChanges, { fileMtime: NOW - 5 * M }, NOW), false);
  assert.equal(triggerFired(fileChanges, { fileMtime: NOW + 1 }, NOW + 2), true);
  const cmd = normalizeCheckback({ session: 's', message: 'm', cmd: 'true' }, NOW);
  assert.equal(triggerFired(cmd, { cmdExit: 1 }, NOW), false);
  assert.equal(triggerFired(cmd, { cmdExit: 0 }, NOW), true);
  assert.equal(cmdDue(cmd, NOW), true);
});

test('delivery waits for idle unless forced; a periodic one reschedules, the rest finish', () => {
  const at = normalizeCheckback({ session: 's', message: 'm', in: '1m' }, NOW);
  assert.equal(mayDeliver(at, { phase: 'working' }), false);
  assert.equal(mayDeliver(at, { phase: 'done' }), true);
  assert.equal(mayDeliver({ ...at, force: true }, { phase: 'working' }), true);
  assert.equal(afterDelivery(at, NOW + M).status, 'delivered');
  const ev = normalizeCheckback({ session: 's', message: 'm', every: '30m' }, NOW);
  const after = afterDelivery(ev, NOW + 31 * M);
  assert.equal(after.status, 'pending'); assert.equal(after.trigger.next, NOW + 60 * M); assert.equal(after.deliveries, 1);
  const bounded = normalizeCheckback({ session: 's', message: 'm', every: '30m', until: '45m' }, NOW);
  assert.equal(afterDelivery(bounded, NOW + 31 * M).status, 'delivered', 'the next slot would be past until');
});

test('describe is one readable line', () => {
  const cb = normalizeCheckback({ session: 'surf', message: 'Report the AF numbers', in: '2h' }, NOW);
  const line = describe(cb, NOW);
  assert.match(line, /surf/); assert.match(line, /in 2\.0h/); assert.match(line, /pending/); assert.match(line, /Report the AF/);
});
