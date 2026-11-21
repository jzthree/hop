'use strict';
// hop's own copies of agy conversations: agy deletes all but its newest few
// hundred, open ones included; a resume puts a lost one back first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const arch = require('../lib/agy-archive');

const ID = '2a4a63ce-a529-4074-b4a8-862ee25891a0';
const haveSqlite = fs.existsSync('/usr/bin/sqlite3');

function makeConversation(dataDir, id, text) {
  fs.mkdirSync(path.join(dataDir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'brain', id, '.system_generated', 'logs'), { recursive: true });
  execFileSync('/usr/bin/sqlite3', [path.join(dataDir, 'conversations', `${id}.db`), `CREATE TABLE IF NOT EXISTS steps(t TEXT); INSERT INTO steps VALUES('${text}');`]);
  fs.writeFileSync(path.join(dataDir, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'), `{"step":"${text}"}\n`);
}
const steps = (db) => execFileSync('/usr/bin/sqlite3', [db, 'SELECT t FROM steps'], { encoding: 'utf8' }).trim().split('\n');

test('a conversation is copied when it changes, and put back when agy has deleted it', { skip: !haveSqlite && 'needs sqlite3' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-arch-'));
  const data = path.join(root, 'antigravity-cli');
  const archive = path.join(root, 'archive');
  assert.equal(await arch.archiveConversation({ dataDir: data, archiveRoot: archive, id: ID }), 'missing');
  makeConversation(data, ID, 'one');
  assert.equal(await arch.archiveConversation({ dataDir: data, archiveRoot: archive, id: ID }), 'copied');
  assert.equal(await arch.archiveConversation({ dataDir: data, archiveRoot: archive, id: ID }), 'unchanged');
  await new Promise((r) => setTimeout(r, 20));
  makeConversation(data, ID, 'two');
  assert.equal(await arch.archiveConversation({ dataDir: data, archiveRoot: archive, id: ID }), 'copied');
  assert.deepEqual(steps(path.join(archive, ID, `${ID}.db`)), ['one', 'two']);

  // agy deletes it; a few steps of a blank restart re-create the folder.
  fs.rmSync(path.join(data, 'conversations', `${ID}.db`));
  fs.rmSync(path.join(data, 'brain', ID), { recursive: true });
  fs.mkdirSync(path.join(data, 'brain', ID));
  fs.writeFileSync(path.join(data, 'brain', ID, 'blank.txt'), 'x');
  assert.equal(arch.isLive(data, ID), false);
  assert.equal(arch.restoreConversation({ dataDir: data, archiveRoot: archive, id: ID }), true);
  assert.deepEqual(steps(path.join(data, 'conversations', `${ID}.db`)), ['one', 'two']);
  assert.ok(fs.existsSync(path.join(data, 'brain', ID, '.system_generated', 'logs', 'transcript_full.jsonl')));
  const aside = fs.readdirSync(path.join(data, 'brain')).filter((n) => n.startsWith(`${ID}.before-restore-`));
  assert.equal(aside.length, 1, 'the re-created folder is kept aside, not thrown away');

  // A live conversation is never overwritten by an older copy.
  makeConversation(data, ID, 'three');
  assert.equal(arch.restoreConversation({ dataDir: data, archiveRoot: archive, id: ID }), true);
  assert.deepEqual(steps(path.join(data, 'conversations', `${ID}.db`)), ['one', 'two', 'three']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('nothing to put back, odd ids, and copies nobody names any more', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-arch2-'));
  assert.equal(arch.restoreConversation({ dataDir: path.join(root, 'd'), archiveRoot: path.join(root, 'a'), id: ID }), false);
  assert.equal(arch.hasCopy(path.join(root, 'a'), '../etc'), false);
  const archive = path.join(root, 'a');
  const old = '11111111-1111-1111-1111-111111111111';
  for (const [id, at] of [[ID, Date.now()], [old, Date.now() - 40 * 86400_000]]) {
    fs.mkdirSync(path.join(archive, id), { recursive: true });
    fs.writeFileSync(path.join(archive, id, 'archived.json'), JSON.stringify({ id, at, changedAt: at }));
  }
  assert.deepEqual(arch.staleCopies(archive, new Set([ID])), [old]);
  assert.deepEqual(arch.staleCopies(archive, new Set([ID, old])), []);
  fs.rmSync(root, { recursive: true, force: true });
});
