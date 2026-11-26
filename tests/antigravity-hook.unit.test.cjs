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

// agy's step log, as it writes it: the model's words are the content of a
// PLANNER_RESPONSE step; GENERIC steps (tool output) come after them.
test('a finished turn carries agy\'s last words, read from its step log', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhook-'));
    const id = 'c1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const transcript = path.join(home, 'transcript.jsonl');
    fs.writeFileSync(transcript, [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nwhy?\n</USER_REQUEST>' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: '/w/a' } }] },
        { step_index: 2, source: 'MODEL', type: 'GENERIC', content: 'tool output, not words' },
        { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Because the cache   is cold.' }
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    run(home, 'Stop', { conversationId: id, fullyIdle: true, transcriptPath: transcript });
    assert.strictEqual(read(home, 'turn').lastMessage, 'Because the cache is cold.');
});

test('the record names the model, and follows a /model switch', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhook-'));
    const id = 'd1b2c3d4-e5f6-7890-abcd-ef1234567890';
    run(home, 'SessionStart', { conversationId: id, workspacePaths: ['/w'], modelName: 'gemini-4-carbon' });
    assert.strictEqual(read(home, 'agy').model, 'gemini-4-carbon');
    run(home, 'PreInvocation', { conversationId: id, invocationNum: 0, modelName: 'gemini-4-pro' });
    const rec = read(home, 'agy');
    assert.strictEqual(rec.model, 'gemini-4-pro');
    assert.strictEqual(rec.cwd, '/w', 'the rest of the record is kept');
});

test('an `agy -p` run inside the room never takes over its record or its turns', () => {
    const { main, isPrintMode } = require(SCRIPT);
    assert.ok(isPrintMode('/Users/j/.local/bin/agy -p You are an expert reader of Science'));
    assert.ok(isPrintMode('agy --print=hello'));
    assert.ok(isPrintMode('agy --model m --prompt hi'));
    assert.ok(!isPrintMode('agy --dangerously-skip-permissions --conversation=abc'));
    assert.ok(!isPrintMode('agy -i Read the ENTIRE file'));
    assert.ok(!isPrintMode('agy --prompt-interactive hi --print-timeout 5s'));
    assert.ok(!isPrintMode(null));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhook-'));
    const env = { HOP_HOME: home, HOP_SESSION: 's_bbbbbbbbbb' };
    const prev = process.env.HOP_HOME;
    process.env.HOP_HOME = home;
    try {
        main('SessionStart', JSON.stringify({ conversationId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890' }), env, () => 'agy -p judge this');
        main('Stop', JSON.stringify({ conversationId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890' }), env, () => 'agy -p judge this');
        assert.strictEqual(read(home, 'agy', 's_bbbbbbbbbb'), null);
        assert.strictEqual(read(home, 'turn', 's_bbbbbbbbbb'), null);
        main('SessionStart', JSON.stringify({ conversationId: 'd1b2c3d4-e5f6-7890-abcd-ef1234567890' }), env, () => 'agy --conversation=x');
        assert.strictEqual(read(home, 'agy', 's_bbbbbbbbbb').sessionId, 'd1b2c3d4-e5f6-7890-abcd-ef1234567890');
    } finally {
        if (prev === undefined) delete process.env.HOP_HOME; else process.env.HOP_HOME = prev;
    }
});

test("a launch hop could not read is not filed, and agy's command is read once", () => {
    const { main } = require(SCRIPT);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhook-'));
    const env = { HOP_HOME: home, HOP_SESSION: 's_cccccccccc' };
    const prev = process.env.HOP_HOME;
    process.env.HOP_HOME = home;
    try {
        // `ps` failed the first time under load and answered the second: the
        // check passed and the record named a judge's `agy -p` (2026-11-22).
        let asked = 0;
        const flaky = () => (asked++ ? '/Users/j/.local/bin/agy -p You are an expert reader of Nature' : null);
        main('SessionStart', JSON.stringify({ conversationId: 'e1b2c3d4-e5f6-7890-abcd-ef1234567890' }), env, flaky);
        assert.strictEqual(asked, 1);
        assert.strictEqual(read(home, 'agy', 's_cccccccccc'), null);
        main('PreInvocation', JSON.stringify({ conversationId: 'e1b2c3d4-e5f6-7890-abcd-ef1234567890', invocationNum: 0 }), env, () => null);
        assert.strictEqual(read(home, 'agy', 's_cccccccccc'), null);
        // The room's own agy, read fine on its next call, is filed then.
        main('PreInvocation', JSON.stringify({ conversationId: 'f1b2c3d4-e5f6-7890-abcd-ef1234567890', invocationNum: 0 }), env, () => 'agy --conversation f1b2c3d4');
        const rec = read(home, 'agy', 's_cccccccccc');
        assert.strictEqual(rec.sessionId, 'f1b2c3d4-e5f6-7890-abcd-ef1234567890');
        assert.strictEqual(rec.launchCmd, 'agy --conversation f1b2c3d4');
    } finally {
        if (prev === undefined) delete process.env.HOP_HOME; else process.env.HOP_HOME = prev;
    }
});

test('agy subcommands (an app\'s `agy acp` server) never take over a room\'s record', () => {
    const { main, notInteractive } = require(SCRIPT);
    assert.ok(notInteractive('/Users/j/.local/bin/agy acp'));
    assert.ok(notInteractive('agy models'));
    assert.ok(notInteractive('agy -p hi'));
    assert.ok(!notInteractive('agy --dangerously-skip-permissions --conversation=abc'));
    assert.ok(!notInteractive('agy -i update the docs'), 'a prompt that starts with a subcommand word');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyhook-'));
    const env = { HOP_HOME: home, HOP_SESSION: 's_cccccccccc' };
    const prev = process.env.HOP_HOME;
    process.env.HOP_HOME = home;
    try {
        main('SessionStart', JSON.stringify({ conversationId: 'd1b2c3d4-e5f6-7890-abcd-ef1234567890' }), env, () => '/Users/j/.local/bin/agy acp');
        assert.ok(!fs.existsSync(path.join(home, 'claude-sessions', 's_cccccccccc.agy')));
    } finally { if (prev === undefined) delete process.env.HOP_HOME; else process.env.HOP_HOME = prev; }
});
