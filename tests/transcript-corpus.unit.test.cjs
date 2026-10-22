'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TranscriptCorpus, extractText } = require('../lib/transcript-corpus');

const msg = (text) => JSON.stringify({ type: 'message', content: [{ type: 'text', text }] }) + '\n';
const noise = (n) => JSON.stringify({ type: 'tool_result', output: 'x'.repeat(n) }) + '\n';

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-corpus-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 't.jsonl');
}

test('text fields come out unescaped; long ones are cut, not dropped', () => {
  assert.deepEqual(extractText('{"text":"line one\\nsaid \\"hi\\""}'), ['line one\nsaid "hi"']);
  const long = extractText(`{"text":"${'a'.repeat(30000)}"}`);
  assert.equal(long.length, 1);
  assert.equal(long[0].length, 20000);
});

test('the window is conversation text: an old message behind megabytes of tool output is found', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, msg('the needle from long ago') + noise(3 * 1024 * 1024) + msg('recent talk'));
  const c = new TranscriptCorpus({ budgetChars: 10000, initialBytes: 1024 * 1024, backfillChunk: 1024 * 1024 });
  c.refresh(file);
  assert.match(c.text(file).text, /recent talk/);
  assert.doesNotMatch(c.text(file).text, /needle/, 'not in the first tail');
  while (c.backfill(file)) { /* deepen */ }
  assert.match(c.text(file).lower, /the needle from long ago/);
  assert.equal(c.pending().length, 0);
});

test('appended turns are picked up without re-reading; a half-written line waits', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, msg('first'));
  const c = new TranscriptCorpus();
  c.refresh(file);
  const line = msg('second turn');
  fs.appendFileSync(file, line.slice(0, 10));
  c.refresh(file);
  assert.doesNotMatch(c.text(file).text, /second/);
  fs.appendFileSync(file, line.slice(10));
  c.refresh(file);
  assert.match(c.text(file).text, /first\nsecond turn/);
});

test('the budget keeps the newest text and drops the oldest', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, msg('old ' + 'a'.repeat(100)));
  const c = new TranscriptCorpus({ budgetChars: 150 });
  c.refresh(file);
  fs.appendFileSync(file, msg('new ' + 'b'.repeat(100)));
  c.refresh(file);
  const { text } = c.text(file);
  assert.match(text, /^new b/);
  assert.doesNotMatch(text, /old/);
});

test('a rewritten (shorter) file starts over', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, msg('before ' + 'z'.repeat(200)));
  const c = new TranscriptCorpus();
  c.refresh(file);
  fs.writeFileSync(file, msg('after'));
  c.refresh(file);
  assert.equal(c.text(file).text, 'after');
});
