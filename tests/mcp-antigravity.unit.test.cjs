'use strict';
// The MCP reads an Antigravity (agy) session's conversation as it reads a
// Claude one: hop_read_trajectory, the last reply a turn's contract is checked
// against, the hook record that makes the turn counter authoritative, and the
// trust prompt a spawned agy can stop at.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agy-'));
process.env.HOP_HOME = path.join(tmp, 'hop_home');
process.env.HOP_GEMINI_HOME = path.join(tmp, 'gemini_home');
const { HopMCPServer, agyStepAsMessage, detectAgentStartupBlocker } = require('../mcp/hop-mcp.js');

const conv = '0a0b0c0d-1111-2222-3333-444455556666';
const logs = path.join(process.env.HOP_GEMINI_HOME, 'antigravity-cli', 'brain', conv, '.system_generated', 'logs');
const steps = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-11T01:00:00Z', content: '<USER_REQUEST>\nprofile the loader\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-11T01:00:02Z', output_tokens: 12, thinking: 'look first', tool_calls: [{ name: 'run_command', args: { CommandLine: 'py-spy top' } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-11T01:00:05Z', content: 'decode 70%' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-11T01:00:09Z', output_tokens: 30, content: 'Decoding dominates: 70% of the time. DONE-TOKEN' }
];
fs.mkdirSync(logs, { recursive: true });
fs.writeFileSync(path.join(logs, 'transcript.jsonl'), steps.map((e) => JSON.stringify(e)).join('\n') + '\n');
fs.mkdirSync(path.join(process.env.HOP_HOME, 'claude-sessions'), { recursive: true });
fs.writeFileSync(path.join(process.env.HOP_HOME, 'claude-sessions', 's_agy0000001.agy'), JSON.stringify({
    sessionId: conv, agent: 'antigravity', cwd: '/w/loader', model: 'gemini-4-carbon', updatedAt: new Date().toISOString()
}));

const server = () => {
    const s = new HopMCPServer();
    // No daemon here: the session is read post-mortem, by its hook record.
    s.callApi = async () => { throw new Error('no daemon'); };
    return s;
};

test('agy steps read as messages: the request unwrapped, words and tools, tool output as a result', () => {
    assert.deepEqual(agyStepAsMessage(steps[0]).message, { role: 'user', content: 'profile the loader' });
    const a = agyStepAsMessage(steps[1], 'm').message;
    assert.equal(a.role, 'assistant');
    assert.deepEqual(a.content.map((b) => b.type), ['thinking', 'tool_use']);
    assert.equal(a.model, 'm');
    assert.equal(agyStepAsMessage(steps[2]).message.content[0].type, 'tool_result');
    assert.equal(agyStepAsMessage({ type: 'SOMETHING_ELSE' }), null);
});

test("an agy session's trajectory is its own step log, and its last reply is what agy said", async () => {
    const s = server();
    assert.equal(s.hasClaudeHookRecord('s_agy0000001'), true, 'the .agy record counts as a hook record');
    const src = await s.resolveTrajectorySource('s_agy0000001');
    assert.equal(src.error, undefined, JSON.stringify(src));
    assert.equal(src.tool, 'antigravity');
    assert.equal(src.path, path.join(logs, 'transcript.jsonl'));
    assert.equal(src.cwd, '/w/loader');
    const data = await s.loadTrajectory(src, { mode: 'tail', limit: 8, textOnly: true });
    const kinds = data.tail.map((t) => t.kind);
    assert.deepEqual(kinds, ['user', 'assistant', 'tool_result', 'assistant']);
    assert.match(data.tail[3].text, /Decoding dominates/);
    assert.match(await s.readLastAssistantReplyText('s_agy0000001'), /DONE-TOKEN$/);
});

test("a spawned agy waiting at its folder-trust prompt is reported, as Claude's is", () => {
    const screen = 'Accessing workspace:\n/w/new\n\nDo you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit';
    assert.equal(detectAgentStartupBlocker(screen)?.kind, 'workspace_trust_required');
});
