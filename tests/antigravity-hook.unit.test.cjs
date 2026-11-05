'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'antigravity-hook.js');
const run = (home, event, payload, session = 's_aaaaaaaaaa') => execFileSync(process.execPath, [SCRIPT, event], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, HOP_HOME: home, HOP_SESSION: session }
});
const read = (home, ext, session = 's_aaaaaaaaaa') => {
    try { return JSON.parse(fs.readFileSync(path.join(home, 'claude-sessions', `${session}.${ext}`), 'utf8')); } catch { return null; }
};

test('SessionStart files the conversation in <session>.agy — never .json, which hop reads as Claude', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhook-'));
    const out = run(home, 'SessionStart', { conversationId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', workspacePaths: ['/w/proj'], transcriptPath: '/t/transcript.jsonl' });
    assert.strictEqual(out, '{}');
    const rec = read(home, 'agy');
    assert.strictEqual(rec.sessionId, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    assert.strictEqual(rec.agent, 'antigravity');
    assert.strictEqual(rec.cwd, '/w/proj');
    assert.strictEqual(read(home, 'json'), null);
});

test('a turn: the first model call marks it begun, Stop when fully idle marks it done (and only then)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhook-'));
    const id = 'b1b2c3d4-e5f6-7890-abcd-ef1234567890';
    run(home, 'PreInvocation', { conversationId: id, invocationNum: 0 });
    assert.strictEqual(read(home, 'prompt').agent, 'antigravity');
    // A resumed conversation with no SessionStart is filed on its first call.
    assert.strictEqual(read(home, 'agy').sessionId, id);
    const before = read(home, 'prompt').at;
    run(home, 'PreInvocation', { conversationId: id, invocationNum: 3 });
    assert.strictEqual(read(home, 'prompt').at, before);
    assert.strictEqual(run(home, 'Stop', { conversationId: id, fullyIdle: false }), '{"decision":"stop"}');
    assert.strictEqual(read(home, 'turn'), null);
    run(home, 'Stop', { conversationId: id, fullyIdle: true });
    run(home, 'Stop', { conversationId: id, fullyIdle: true });
    assert.deepStrictEqual([read(home, 'turn').agent, read(home, 'turn').count, read(home, 'turn').sessionId], ['antigravity', 2, id]);
});

test('outside a hop session it records nothing and still answers agy', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhook-'));
    const out = execFileSync(process.execPath, [SCRIPT, 'Stop'], { input: '{"conversationId":"x"}', encoding: 'utf8', env: { ...process.env, HOP_HOME: home, HOP_SESSION: '' } });
    assert.strictEqual(out, '{"decision":"stop"}');
    assert.strictEqual(fs.existsSync(path.join(home, 'claude-sessions', '.agy')), false);
    assert.strictEqual(execFileSync(process.execPath, [SCRIPT, 'SessionStart'], { input: 'not json', encoding: 'utf8', env: { ...process.env, HOP_HOME: home, HOP_SESSION: 's_x' } }), '{}');
});
