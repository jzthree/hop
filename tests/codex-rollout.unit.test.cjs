// The folder a Codex thread last worked in, read off the end of its rollout:
// `codex resume` started anywhere else stops at a menu asking which folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lastTurnCwd } = require('../lib/codex-rollout');

const line = (type, payload) => JSON.stringify({ timestamp: '2026-11-28T08:00:00Z', type, payload }) + '\n';

test('the last turn\'s folder, read from the end, past a long stretch of output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-'));
  try {
    const f = path.join(dir, 'rollout-x.jsonl');
    const big = line('response_item', { type: 'function_call_output', output: 'x'.repeat(300_000) });
    fs.writeFileSync(f, line('session_meta', { cwd: '/home/me' }) + line('turn_context', { cwd: '/home/me' })
      + line('turn_context', { cwd: '/home/me/project' }) + big.repeat(20));
    // 6 MB of output after the last turn: past the first 4 MB piece.
    assert.equal(lastTurnCwd(f, [1, 4, 16]), '/home/me/project');
    // Not that far back: unknown, never the first turn's folder by mistake.
    assert.equal(lastTurnCwd(f, [1]), null);
    // A small file read whole; no turn at all; no file.
    const small = path.join(dir, 'small.jsonl');
    fs.writeFileSync(small, line('turn_context', { cwd: '/a' }) + line('turn_context', { cwd: '/b' }));
    assert.equal(lastTurnCwd(small), '/b');
    fs.writeFileSync(small, line('session_meta', { cwd: '/a' }));
    assert.equal(lastTurnCwd(small), null);
    assert.equal(lastTurnCwd(path.join(dir, 'gone.jsonl')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
