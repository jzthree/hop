// The briefing's read witness: strengths, merging across devices, what the generator learns.
const test = require('node:test');
const assert = require('node:assert/strict');
const { levelForDwell, mergeReads, readOf, editionsSeen, readStateBySession, pruneReads } = require('../lib/digest-reads');

test('a dwell earns glimpsed at 1.5s and read at the reading time of the text', () => {
  assert.equal(levelForDwell(1000, 50), null);
  assert.equal(levelForDwell(1500, 50), 'glimpsed');
  assert.equal(levelForDwell(14_999, 50), 'glimpsed');   // 50 words ≈ 15s at 200 wpm
  assert.equal(levelForDwell(15_000, 50), 'read');
  assert.equal(levelForDwell(1500, 3), 'read', 'a three-word headline is read as soon as it is glimpsed');
});

test('merging keeps the strongest level and the span of sightings, across devices', () => {
  const store = {};
  assert.equal(mergeReads(store, [{ edition: 'E1', item: 'surf', level: 'glimpsed', at: 100 }]), 1);
  assert.equal(mergeReads(store, [{ edition: 'E1', item: 'surf', level: 'read', at: 200 }]), 1);
  assert.equal(mergeReads(store, [{ edition: 'E1', item: 'surf', level: 'glimpsed', at: 300 }]), 1, 'a later weaker sighting still moves lastAt');
  const r = readOf(store, 'E1', 'surf');
  assert.equal(r.level, 'read'); assert.equal(r.firstAt, 100); assert.equal(r.lastAt, 300);
  assert.equal(mergeReads(store, [{ edition: 'E1', item: 'surf', level: 'nonsense' }, { item: 'x', level: 'read' }]), 0);
  assert.deepEqual([...editionsSeen(store)], ['E1']);
});

test('the generator learns, per session, how its newest telling was received', () => {
  const store = {};
  mergeReads(store, [{ edition: 'E2', item: 'surf', level: 'acted', at: 5 }, { edition: 'E1', item: 'music', level: 'glimpsed', at: 3 }]);
  const editions = [
    { generated_at: 'E3', items: [{ session: 'angler' }] },
    { generated_at: 'E2', items: [{ session: 'surf' }, { session: 'music' }] },
    { generated_at: 'E1', items: [{ session: 'music' }, { session: 'surf' }] }
  ];
  const st = readStateBySession(store, editions);
  assert.deepEqual(st.surf, { edition: 'E2', level: 'acted', at: 5 });
  assert.deepEqual(st.music, { edition: 'E2', level: 'unread', at: null }, 'the newest telling of music was never seen, even though an older one was');
  assert.deepEqual(st.angler, { edition: 'E3', level: 'unread', at: null });
});

test('old records are pruned', () => {
  const store = {};
  const NOW = 40 * 86_400_000;
  mergeReads(store, [{ edition: 'E0', item: 'a', level: 'read', at: 0 }, { edition: 'E9', item: 'b', level: 'read', at: NOW - 86_400_000 }]);
  assert.equal(pruneReads(store, NOW), 1);
  assert.ok(!readOf(store, 'E0', 'a') && readOf(store, 'E9', 'b'));
});
