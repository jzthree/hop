'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rc = require('../lib/recently-closed');

const snap = (name, extra = {}) => ({ displayName: name, cwd: '/w', records: { json: '{"sessionId":"x"}' }, ...extra });

test('a session gone since the last sweep is closed, with its last snapshot and why', () => {
    const store = rc.emptyStore();
    const last = new Map([['s_a', snap('a')], ['s_b', snap('b')]]);
    const added = rc.noteClosures(store, last, new Set(['s_b']), { now: 1000, how: { s_a: 'killed' } });
    assert.deepStrictEqual(added.map((e) => [e.internalName, e.how, e.closedAt]), [['s_a', 'killed', 1000]]);
    const list = rc.listing(store, 2000);
    assert.deepStrictEqual(list[0], { internalName: 's_a', displayName: 'a', cwd: '/w', agent: null, how: 'killed', closedAt: 1000, resumable: true });
});

test('one entry per session, newest first; old and excess entries pruned; reopened ones dropped', () => {
    const store = rc.emptyStore();
    rc.noteClosures(store, new Map([['s_a', snap('a')]]), new Set(), { now: 1000 });
    rc.noteClosures(store, new Map([['s_a', snap('a2')]]), new Set(), { now: 3000 });
    rc.noteClosures(store, new Map([['s_b', snap('b')]]), new Set(), { now: 2000 });
    assert.deepStrictEqual(store.closed.map((e) => e.displayName), ['a2', 'b']);
    rc.prune(store, 3000 + rc.KEEP_MS + 1);
    assert.strictEqual(store.closed.length, 0);
    rc.noteClosures(store, new Map([['s_c', snap('c')]]), new Set(), { now: 10 });
    assert.strictEqual(rc.dropReopened(store, new Set(['s_c'])), true);
    assert.strictEqual(store.closed.length, 0);
    const many = new Map(Array.from({ length: rc.KEEP_MAX + 5 }, (_, i) => [`s_${i}`, snap(String(i))]));
    rc.noteClosures(store, many, new Set(), { now: 5 });
    assert.strictEqual(store.closed.length, rc.KEEP_MAX);
});

test('the agent comes from the .turn record; a plain shell has none', () => {
    assert.strictEqual(rc.agentOf({ turn: '{"agent":"codex","lastMessage":"x"}' }), 'codex');
    assert.strictEqual(rc.agentOf({ json: '{}', turn: '{"sessionId":"x","lastMessage":"codex mentioned"}' }), 'claude');
    assert.strictEqual(rc.agentOf({}), null);
    assert.strictEqual(rc.normalizeStore({ closed: [{ internalName: 's', closedAt: 1 }, { bad: 1 }] }).closed.length, 1);
});
