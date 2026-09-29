// The second copy of the user's filing, and how restore uses it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotFromMetas, planRefiles, pruneList, snapshotFileName } = require('../lib/identity-snapshot');

const folders = { f_a: { id: 'f_a', name: 'Research' }, f_b: { id: 'f_b', name: 'Softwares' } };

test('a snapshot keeps name, folder and origin per session, and the folders themselves', () => {
  const snap = snapshotFromMetas([
    { internalName: 's_1', displayName: 'Aurora', folderId: 'f_a', createdBy: 'user', cwd: '/w' },
    { internalName: 's_2', displayName: 'Lyra' },
    { internalName: '' }
  ], folders, { at: '2026-09-29T00:00:00.000Z', reason: 'start' });
  assert.equal(snap.reason, 'start');
  assert.deepEqual(Object.keys(snap.sessions), ['s_1', 's_2']);
  assert.equal(snap.sessions.s_1.folderId, 'f_a');
  assert.equal(snap.sessions.s_2.folderId, null);
  assert.equal(snap.folders.f_b.name, 'Softwares');
});

test('a session whose meta forgot its folder is re-filed from the snapshot', () => {
  const snap = snapshotFromMetas([{ internalName: 's_1', displayName: 'Aurora', folderId: 'f_a' }], folders);
  const plan = planRefiles([{ internalName: 's_1', displayName: 'Aurora', cwd: '/w' }], snap, folders);
  assert.deepEqual(plan, [{ internalName: 's_1', folderId: 'f_a', displayName: 'Aurora' }]);
});

test('unfiled on purpose (explicit null) and already-filed metas are left alone', () => {
  const snap = snapshotFromMetas([
    { internalName: 's_1', folderId: 'f_a' },
    { internalName: 's_2', folderId: 'f_a' }
  ], folders);
  const plan = planRefiles([
    { internalName: 's_1', folderId: null },
    { internalName: 's_2', folderId: 'f_b' }
  ], snap, folders);
  assert.deepEqual(plan, []);
});

test('a folder that no longer exists, or a session the snapshot never filed, is not re-filed', () => {
  const snap = snapshotFromMetas([
    { internalName: 's_1', folderId: 'f_gone' },
    { internalName: 's_2' }
  ], folders);
  assert.deepEqual(planRefiles([{ internalName: 's_1' }, { internalName: 's_2' }, { internalName: 's_3' }], snap, folders), []);
  assert.deepEqual(planRefiles([{ internalName: 's_1' }], null, folders), []);
});

test('snapshot files sort by time and the oldest are pruned', () => {
  const names = ['identity-2026-09-01T00-00-00-000Z.json', 'identity-2026-09-03T00-00-00-000Z.json', 'other.json', 'identity-2026-09-02T00-00-00-000Z.json'];
  assert.deepEqual(pruneList(names, 2), ['identity-2026-09-01T00-00-00-000Z.json']);
  assert.equal(snapshotFileName('2026-09-29T01:02:03.004Z'), 'identity-2026-09-29T01-02-03-004Z.json');
});
