// A lost Antigravity conversation: the handoff a new one starts from.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHandoff, transcriptEntries, startPrompt, newest } = require('../lib/agy-recovery');

const T = Date.parse('2026-11-21T06:30:00Z');

test('agy\'s transcript lines read as prompts and steps, without its wrappers', () => {
    const jsonl = [
        JSON.stringify({ type: 'USER_INPUT', created_at: '2026-11-21T03:56:22Z', content: '<USER_REQUEST>\nRead handoff.json and continue.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: x\n</ADDITIONAL_METADATA>' }),
        'not json',
        JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: '2026-11-21T03:57:00Z', content: 'Reading it now.' }),
        JSON.stringify({ type: 'USER_INPUT', content: '' })
    ].join('\n');
    assert.deepEqual(transcriptEntries(jsonl), [
        { at: '2026-11-21T03:56:22Z', who: 'Prompt', text: 'Read handoff.json and continue.' },
        { at: '2026-11-21T03:57:00Z', who: 'planner response', text: 'Reading it now.' }
    ]);
});

test('the handoff says what happened, who to ask, and holds the messages and scheduled prompts', () => {
    const md = buildHandoff({
        display: 'fit-agy', internalName: 's_me', cwd: '/w', conversationId: 'abc-123', why: 'agy no longer has it',
        forkedFromName: 'fit', handoffFiles: ['~/.hop2/uploads/s_me/handoff.md'], brainFiles: [],
        transcript: [{ at: '', who: 'Prompt', text: 'continue' }],
        messages: [
            { at: T - 60_000, from: 's_me', to: 's_fit', toName: 'fit', text: 'Round 2 is done.', status: 'delivered' },
            { at: T, from: 's_fit', fromName: 'fit', to: 's_me', text: 'Check round 3.', status: 'queued' },
            { at: T, from: 'None', fromName: 'None', to: 's_me', text: 'From the morning pulse: unblock.', status: 'delivered' }
        ],
        checkbacks: [{ at: T, text: 'Randi event: read the handoff.', pending: true, by: 'an agent' }],
        now: T
    });
    assert.match(md, /^# Recovering fit-agy/);
    assert.match(md, /\(abc-123\) could not be reopened: agy no longer has it/);
    assert.match(md, /handed off from the session fit/);
    assert.match(md, /Ask the first for a recap of where your work stood: `hop send fit "…"`/);
    assert.match(md, /\*\*You → fit\*\* · 2026-11-21 06:29 UTC\n\nRound 2 is done\./);
    assert.match(md, /\*\*fit → you\*\* · 2026-11-21 06:30 UTC · queued\n\nCheck round 3\./);
    assert.match(md, /\*\*An agent outside hop → you\*\*/);
    assert.match(md, /\*\*Still to come\*\* · 2026-11-21 06:30 UTC · set by an agent\n\nRandi event/);
    assert.match(md, /What survives of agy's own transcript \(1 entry\)/);
});

test('nothing kept still makes a handoff that says so; long sections keep their newest part', () => {
    const md = buildHandoff({ display: 'x', internalName: 's_x', conversationId: 'c', now: T });
    assert.match(md, /Nothing: agy kept no transcript of it\./);
    assert.match(md, /## Messages between this session and others \(0\)\n\nNone\./);
    const kept = newest(['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)], 120);
    assert.deepEqual(kept, ['[1 earlier entry left out for length]', 'b'.repeat(50), 'c'.repeat(50)]);
    assert.match(startPrompt('/f.md', 'x'), /^Read the ENTIRE file \/f\.md first\./);
});
