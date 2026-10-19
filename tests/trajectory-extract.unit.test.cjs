'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractConversation, codexRolloutId, handoffPrompt } = require('../scripts/trajectory-extract.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hop-extract-'));
const jsonl = (file, entries) => fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

test('claude transcript: turns, tool summaries, noise dropped, most-recent-first budget', async () => {
    const dir = tmp();
    const file = path.join(dir, 'claude.jsonl');
    jsonl(file, [
        { type: 'user', timestamp: '2026-09-01T10:00:00.000Z', cwd: '/Users/me/proj', message: { role: 'user', content: 'fix the build' } },
        { type: 'assistant', timestamp: '2026-09-01T10:00:05.000Z', message: { role: 'assistant', content: [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/Users/me/proj/a.ts' } }
        ] } },
        { type: 'user', timestamp: '2026-09-01T10:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
        { type: 'assistant', timestamp: '2026-09-01T10:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed a.ts.' }] } },
        { type: 'user', timestamp: '2026-09-01T10:01:00.000Z', message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' } },
        { type: 'user', timestamp: '2026-09-01T10:02:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'now ship it' }] } },
        { type: 'assistant', timestamp: '2026-09-01T10:02:30.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Shipped.' }] } }
    ]);
    const r = await extractConversation(file);
    assert.equal(r.tool, 'claude');
    assert.equal(r.cwd, '/Users/me/proj');
    assert.equal(r.totalTurns, 2); // the tool result and the system-reminder are not turns
    assert.equal(r.turns, 2);
    assert.match(r.text, /^# Conversation Extract\n# Source tool: claude/);
    assert.match(r.text, /## User \[2026-09-01T10:00:00\]\nfix the build\n/);
    assert.match(r.text, /### Actions taken:\n {2}\[Bash\] npm test\n {2}\[Edit\] \/Users\/me\/proj\/a\.ts/);
    // Both text blocks of the reply, in order, on the turn they answer.
    assert.match(r.text, /## Assistant\nLooking\.\nFixed a\.ts\.\n/);
    assert.ok(!r.text.includes('ignore me'));
    assert.ok(r.text.indexOf('fix the build') < r.text.indexOf('now ship it'));
    assert.match(r.text, /## Assistant\nShipped\.\n$/);

    // A tight budget keeps the NEWEST turn.
    const small = await extractConversation(file, { maxChars: 20 });
    assert.equal(small.turns, 1);
    assert.ok(small.text.includes('now ship it'));
    assert.ok(!small.text.includes('fix the build'));
});

test('codex rollout: user turns deduped, assistant paired, id readable', async () => {
    const dir = tmp();
    const file = path.join(dir, '.codex', 'sessions', 'rollout.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    jsonl(file, [
        { type: 'session_meta', timestamp: '2026-09-01T11:00:00.000Z', payload: { id: 'abc-123', cwd: '/Users/me/other' } },
        { type: 'event_msg', timestamp: '2026-09-01T11:00:01.000Z', payload: { type: 'user_message', message: 'summarize the repo' } },
        { type: 'response_item', timestamp: '2026-09-01T11:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summarize the repo' }] } },
        { type: 'response_item', timestamp: '2026-09-01T11:00:20.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It is a CLI.' }] } },
        { type: 'event_msg', timestamp: '2026-09-01T11:05:00.000Z', payload: { type: 'user_message', message: 'ok' } }
    ]);
    const r = await extractConversation(file);
    assert.equal(r.tool, 'codex');
    assert.equal(r.cwd, '/Users/me/other');
    assert.equal(r.totalTurns, 1); // "ok" is too short to count; the duplicate is folded
    assert.match(r.text, /## User \[2026-09-01T11:00:01\]\nsummarize the repo\n\n## Assistant\nIt is a CLI\./);
    assert.equal(await codexRolloutId(file), 'abc-123');
});

// A long Codex thread continues in a segment file in a later day folder;
// the handoff reads the thread from its first file, not just the newest.
test('codex thread split across segment files is read whole, oldest first', async () => {
    const dir = tmp();
    const id = '01a14846-f12b-79b0-a607-19de9fdc0dbf';
    const day1 = path.join(dir, '.codex', 'sessions', '2026', '10', '17');
    const day2 = path.join(dir, '.codex', 'sessions', '2026', '10', '18');
    fs.mkdirSync(day1, { recursive: true });
    fs.mkdirSync(day2, { recursive: true });
    const first = path.join(day1, `rollout-2026-10-17T00-12-51-${id}.jsonl`);
    const later = path.join(day2, `rollout-2026-10-18T21-44-03-${id}_01a1520b-6e45-7560-af50-845d3f9983d4.jsonl`);
    jsonl(first, [
        { type: 'session_meta', timestamp: '2026-10-17T00:12:51.000Z', payload: { id, cwd: '/Users/me/grants' } },
        { type: 'event_msg', timestamp: '2026-10-17T00:13:00.000Z', payload: { type: 'user_message', message: 'find grant opportunities' } }
    ]);
    jsonl(later, [
        { type: 'session_meta', timestamp: '2026-10-18T21:44:03.000Z', payload: { id, cwd: '/Users/me/grants' } },
        { type: 'event_msg', timestamp: '2026-10-18T21:45:00.000Z', payload: { type: 'user_message', message: 'draft the PO email' } }
    ]);
    // An unrelated thread in the same folder stays out.
    jsonl(path.join(day2, 'rollout-2026-10-18T09-00-00-11111111-2222-3333-4444-555555555555.jsonl'), [
        { type: 'event_msg', timestamp: '2026-10-18T09:00:01.000Z', payload: { type: 'user_message', message: 'unrelated work' } }
    ]);
    const r = await extractConversation(later, { tool: 'codex' });
    assert.equal(r.totalTurns, 2);
    assert.ok(r.text.indexOf('find grant opportunities') < r.text.indexOf('draft the PO email'));
    assert.ok(!r.text.includes('unrelated work'));
});

test('handoff prompt names the file, its size, and the source tool', () => {
    const p = handoffPrompt('/x/handoff.md', 5 * 1024, 'claude');
    assert.match(p, /Read the ENTIRE file \/x\/handoff\.md \(5KB\)/);
    assert.match(p, /previous claude conversation/);
});
