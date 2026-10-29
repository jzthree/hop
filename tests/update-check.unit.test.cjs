'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdateChecker, isNewerVersion, installKind } = require('../lib/update-check');

const reply = (body, ok = true) => async () => ({ ok, json: async () => body });

test('versions compare numerically, prerelease tags ignored', () => {
  assert.equal(isNewerVersion('0.11.86', '0.11.85'), true);
  assert.equal(isNewerVersion('0.12.0', '0.11.99'), true);
  assert.equal(isNewerVersion('0.11.10', '0.11.9'), true);
  assert.equal(isNewerVersion('0.11.85', '0.11.85'), false);
  assert.equal(isNewerVersion('0.11.84', '0.11.85'), false);
  assert.equal(isNewerVersion('v1.0.0-beta.1', '0.9.0'), true);
});

test('a git checkout updates with hop update; an npm install with npm', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(installKind(dir), 'npm');
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: elsewhere\n');
  assert.equal(installKind(dir), 'git');
  const c = createUpdateChecker({ root: dir, current: '1.0.0' });
  assert.equal(c.info().command, 'hop update');
});

test('a newer release is reported and logged once; failures stay quiet', async () => {
  const logs = [];
  const c = createUpdateChecker({ root: os.tmpdir(), current: '0.11.85', fetchImpl: reply({ version: '0.11.90' }), log: (m) => logs.push(m) });
  assert.equal(c.info().updateAvailable, false);
  await c.checkOnce();
  await c.checkOnce();
  assert.equal(c.info().updateAvailable, true);
  assert.equal(c.info().latest, '0.11.90');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /0\.11\.90 is available/);

  const same = createUpdateChecker({ root: os.tmpdir(), current: '0.11.90', fetchImpl: reply({ version: '0.11.90' }) });
  await same.checkOnce();
  assert.equal(same.info().updateAvailable, false);

  const down = createUpdateChecker({ root: os.tmpdir(), current: '0.11.85', fetchImpl: async () => { throw new Error('offline'); } });
  await down.checkOnce();
  assert.equal(down.info().updateAvailable, false);
  assert.equal(down.info().checkedAt, null);
});
