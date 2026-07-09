'use strict';

// Regression: keystroke-echo mangling in readable_raw captures. zsh's line
// editor echoes typed input as backspace-and-rewrite chunks, and the readable
// pipeline used to (1) re-emit the whole line on any "destructive" edit even
// when it merely extended already-emitted text — doubling the prefix
// ("e" + "…% ec" → "eec…"), (2) drop space-only fragments (empty canonical
// key), (3) trim real trailing spaces off partial-line deltas, and (4) let
// the repeated-status-line dedupe swallow identical consecutive fragments.
// Captures showed "eecho warmrun; printf'…" for "echo warm run; printf '…".

const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const {
  ReadableOutputParser,
  applyBalancedReadableNoiseFilter,
  createReadableNoiseState
} = require(path.join(__dirname, '..', 'mcp', 'hop-mcp.js'));

function parseAll(parser, chunks) {
  return chunks.map((chunk) => parser.parseChunk(chunk).text).join('');
}

test('parser: backspace-and-rewrite append emits only the suffix (zsh echo idiom)', () => {
  const parser = new ReadableOutputParser();
  // prompt, then user types "ec": zsh echoes "e", then "\b" + "ec"
  parser.parseChunk('prompt % ');
  const out = parseAll(parser, ['e', '\bec', 'ho probe ', 'r', 'u', 'n']);
  assert.strictEqual(out, 'echo probe run');
});

test('parser: identical redraw emits nothing instead of duplicating the line', () => {
  const parser = new ReadableOutputParser();
  parser.parseChunk('prompt % hello');
  // cursor jumps home and redraws the same content
  const out = parser.parseChunk('\rprompt % hello').text;
  assert.strictEqual(out, '');
});

test('parser: a real rewrite (content changed) still re-emits the line', () => {
  const parser = new ReadableOutputParser();
  parser.parseChunk('Progress: 50%');
  const out = parser.parseChunk('\rProgress: 60%').text;
  assert.strictEqual(out, 'Progress: 60%');
});

function commitTexts(noiseState, events) {
  const out = [];
  for (const event of events) {
    out.push(...applyBalancedReadableNoiseFilter(noiseState, event));
  }
  return out.map((e) => e.text);
}

test('filter: space-only and trailing-space fragments survive verbatim', () => {
  const noiseState = createReadableNoiseState();
  const texts = commitTexts(noiseState, [
    { type: 'output', text: 'printf ', timestamp: 1000 },
    { type: 'output', text: ' ', timestamp: 1001 },
    { type: 'output', text: "'x'", timestamp: 1002 }
  ]);
  assert.deepStrictEqual(texts, ['printf ', ' ', "'x'"]);
});

test('filter: consecutive identical fragments are not deduped (repeated letters)', () => {
  const noiseState = createReadableNoiseState();
  const texts = commitTexts(noiseState, [
    { type: 'output', text: 'l', timestamp: 1000 },
    { type: 'output', text: 'l', timestamp: 1001 },
    { type: 'output', text: 'o', timestamp: 1002 }
  ]);
  assert.deepStrictEqual(texts, ['l', 'l', 'o']);
});

test('filter: \\r-rewrite lines still coalesce into pending (spinner suppression intact)', () => {
  const noiseState = createReadableNoiseState();
  const rewrite = (text, ts) => ({
    type: 'output',
    text,
    timestamp: ts,
    controls: [{ kind: 'carriage_return' }]
  });
  const emitted = commitTexts(noiseState, [
    rewrite('spinner frame 1', 1000),
    rewrite('spinner frame 1', 1100),
    rewrite('spinner frame 1', 1200)
  ]);
  // all three held as one pending rewrite, nothing emitted mid-flight
  assert.deepStrictEqual(emitted, []);
  assert.ok(noiseState.pendingRewrite);
  assert.strictEqual(noiseState.pendingRewrite.rewriteCount, 3);
});
