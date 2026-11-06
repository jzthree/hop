'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseKeeperProtocol, keeperPlan } = require('../lib/keeper-update');

test('the published keeper protocol is the one the keeper speaks (bump both together)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pty-keeper.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.strictEqual(typeof pkg.hopKeeperProtocol, 'number');
    assert.strictEqual(parseKeeperProtocol(src), pkg.hopKeeperProtocol);
    assert.strictEqual(parseKeeperProtocol('const VERSION = 7;'), 7);
    assert.strictEqual(parseKeeperProtocol('nothing'), null);
});

test('an update needing a newer keeper requires ending the terminals; one that does not, does not', () => {
    const running = { version: 1, pid: 9, startedAt: 1000, terminals: 40 };
    assert.strictEqual(keeperPlan({ running, installed: { protocol: 1, changedAt: 500 }, latest: { protocol: 1 } }).requiresRestart, false);
    const next = keeperPlan({ running, installed: { protocol: 1, changedAt: 500 }, latest: { protocol: 2 } });
    assert.strictEqual(next.requiresRestart, true);
    assert.match(next.reason, /protocol 2; the running keeper speaks 1/);
    // Already installed but not running (a pulled checkout, never restarted).
    assert.strictEqual(keeperPlan({ running, installed: { protocol: 2 }, latest: null }).requiresRestart, true);
});

test('a keeper older than its installed code is stale (optional), and no keeper means nothing to end', () => {
    const running = { version: 1, pid: 9, startedAt: 1000 };
    const stale = keeperPlan({ running, installed: { protocol: 1, changedAt: 2000 }, latest: { protocol: 1 } });
    assert.deepStrictEqual([stale.requiresRestart, stale.stale], [false, true]);
    assert.strictEqual(keeperPlan({ running, installed: { protocol: 1, changedAt: 900 }, latest: null }).stale, false);
    assert.deepStrictEqual(keeperPlan({ running: null, installed: { protocol: 1 }, latest: { protocol: 2 } }),
        { keeper: false, requiresRestart: false, stale: false, reason: null });
});
