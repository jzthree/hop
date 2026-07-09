'use strict';

// Regression: stream-based until_prompt/until_regex used to starve on plain
// shells. The balanced noise filter holds the newest \r-rewrite line (the
// shell prompt always is one) as pendingRewrite, and only a LATER parse pass
// could commit it — but parse passes only run when new records arrive, so a
// prompt printed right before the stream went quiet never surfaced, and
// hopx_exec timed out on every zsh terminal.
// TerminalStreamManager.flushReadablePending() is the wait loop's idle-pass
// escape hatch; these tests pin its contract.

const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const { TerminalStreamManager } = require(path.join(__dirname, '..', 'mcp', 'hop-mcp.js'));

const STABLE_MS = 800; // READABLE_NOISE_STABLE_MS

function managerWithPending(pending) {
  const manager = new TerminalStreamManager();
  manager.streams.set('t_test', {
    readableRaw: {
      parser: null,
      parsedByEventId: new Map(),
      noise: {
        filteredBaseByEventId: new Map(),
        pendingRewrite: pending,
        lastCommittedKey: null,
        lastSuppressedRewrite: null
      }
    }
  });
  return manager;
}

function pendingLine(text, ageMs, rewriteCount) {
  const ts = Date.now() - ageMs;
  return {
    key: text,
    text,
    firstTs: ts,
    lastTs: ts,
    rewriteCount,
    templateEvent: { type: 'output', text }
  };
}

test('commits a stable pending line (the quiet-shell prompt)', () => {
  const manager = managerWithPending(pendingLine('user@host /tmp %', STABLE_MS + 200, 1));
  const flushed = manager.flushReadablePending('t_test');
  assert.strictEqual(flushed.length, 1);
  assert.strictEqual(flushed[0].type, 'output');
  assert.match(flushed[0].text, /%$/);
  // pending consumed: second call is a no-op
  assert.deepStrictEqual(manager.flushReadablePending('t_test'), []);
});

test('commits even a "noisy" pending once stable (fresh-shell prompt redraws)', () => {
  // rewriteCount >= 2 marks the line noisy; the map-time flush suppresses it,
  // but an idle-stable line is the rewrite chain's FINAL state and must land.
  const manager = managerWithPending(pendingLine('user@host /tmp %', STABLE_MS + 200, 5));
  const flushed = manager.flushReadablePending('t_test');
  assert.strictEqual(flushed.length, 1);
  assert.match(flushed[0].text, /%$/);
});

test('holds a pending line that is not stable yet', () => {
  const manager = managerWithPending(pendingLine('still typing', 100, 1));
  assert.deepStrictEqual(manager.flushReadablePending('t_test'), []);
  // not consumed — it can still absorb rewrites or flush later
  const state = manager.streams.get('t_test');
  assert.ok(state.readableRaw.noise.pendingRewrite);
});

test('no-ops without state, noise, or pending', () => {
  const manager = new TerminalStreamManager();
  assert.deepStrictEqual(manager.flushReadablePending('missing'), []);
  const empty = managerWithPending(null);
  assert.deepStrictEqual(empty.flushReadablePending('t_test'), []);
});

test('lastCommittedKey dedupe: an identical just-committed line does not repeat', () => {
  const manager = managerWithPending(pendingLine('user@host /tmp %', STABLE_MS + 200, 1));
  const state = manager.streams.get('t_test');
  state.readableRaw.noise.lastCommittedKey = null;
  const first = manager.flushReadablePending('t_test');
  assert.strictEqual(first.length, 1);
  // same text goes pending again (e.g. prompt redrawn identically)
  state.readableRaw.noise.pendingRewrite = pendingLine('user@host /tmp %', STABLE_MS + 200, 1);
  const second = manager.flushReadablePending('t_test');
  assert.deepStrictEqual(second, []);
});
