const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFailureTracker,
  createSingleFlight,
  sameHostIncarnation
} = require('../lib/hay-host-watchdog');

test('a successful probe resets the complete failure streak', () => {
  let now = 0;
  const tracker = createFailureTracker({
    requiredFailures: 3,
    windowMs: 60_000,
    now: () => now
  });

  assert.equal(tracker.recordFailure(42).shouldRestart, false);
  now = 17_000;
  assert.equal(tracker.recordFailure(42).shouldRestart, false);

  now = 53_000;
  const recovered = tracker.recordSuccess(42);
  assert.equal(recovered.count, 2);
  assert.deepEqual(tracker.snapshot(), { pid: 0, count: 0, firstAt: 0 });

  now = 62_000;
  const nextFailure = tracker.recordFailure(42);
  assert.equal(nextFailure.count, 1);
  assert.equal(nextFailure.failingForMs, 0);
  assert.equal(nextFailure.shouldRestart, false);
});

test('restart requires enough consecutive failures spanning the full window', () => {
  let now = 0;
  const tracker = createFailureTracker({
    requiredFailures: 3,
    windowMs: 60_000,
    now: () => now
  });

  tracker.recordFailure(7);
  now = 20_000;
  tracker.recordFailure(7);
  now = 59_999;
  assert.equal(tracker.recordFailure(7).shouldRestart, false);
  now = 60_000;
  assert.equal(tracker.recordFailure(7).shouldRestart, true);
});

test('failure history never crosses host incarnations', () => {
  let now = 0;
  const tracker = createFailureTracker({
    requiredFailures: 3,
    windowMs: 60_000,
    now: () => now
  });

  tracker.recordFailure(7);
  now = 61_000;
  const firstFailureForReplacement = tracker.recordFailure(8);
  assert.equal(firstFailureForReplacement.count, 1);
  assert.equal(firstFailureForReplacement.failingForMs, 0);
  assert.equal(firstFailureForReplacement.shouldRestart, false);
});

test('single flight shares one operation across concurrent callers and clears afterward', async () => {
  const flight = createSingleFlight();
  let starts = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const work = async () => {
    starts += 1;
    await blocked;
    return 'ready';
  };

  const callers = Array.from({ length: 15 }, () => flight.run(work));
  assert.equal(starts, 0, 'work starts on the next microtask');
  await Promise.resolve();
  assert.equal(starts, 1);
  assert.equal(new Set(callers).size, 1, 'all callers receive the same promise');

  release();
  assert.deepEqual(await Promise.all(callers), Array(15).fill('ready'));
  assert.equal(flight.isRunning(), false);

  assert.equal(await flight.run(async () => {
    starts += 1;
    return 'again';
  }), 'again');
  assert.equal(starts, 2);
});

test('single flight clears after a rejected operation so recovery can retry', async () => {
  const flight = createSingleFlight();
  await assert.rejects(flight.run(async () => {
    throw new Error('probe failed');
  }), /probe failed/);
  assert.equal(flight.isRunning(), false);
  assert.equal(await flight.run(async () => 'recovered'), 'recovered');
});

test('host incarnation comparison includes pid, port, and start time', () => {
  const host = { pid: 7, port: 5000, startedAt: 100 };
  assert.equal(sameHostIncarnation(host, { ...host }), true);
  assert.equal(sameHostIncarnation(host, { ...host, pid: 8 }), false);
  assert.equal(sameHostIncarnation(host, { ...host, port: 5001 }), false);
  assert.equal(sameHostIncarnation(host, { ...host, startedAt: 101 }), false);
});
