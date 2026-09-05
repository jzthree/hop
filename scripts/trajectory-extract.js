'use strict';
// Turn a Claude Code or Codex transcript into a readable handoff document.
//
// This is how a conversation crosses tools. A Claude transcript is a JSONL
// of API messages; a Codex rollout is a JSONL of events; neither tool can
// resume the other's. What CAN cross is the conversation itself — every user
// turn, the assistant's reply, and a one-line summary of each action taken —
// written as markdown the receiving agent reads before its first turn. That
// is context sharing, not replay: tool results are not carried, and the
// receiver starts by summarising what it read.
//
// Same document format as ~/Code/agent_tools/agent_migration.py --extract,
// ported so hop needs no Python (and no TUI dependencies) to hand a session
// off — with replies paired to the turn they answer (see readClaudeTurns).
//
// Streams line by line: real transcripts run to hundreds of MB.

const fs = require('fs');
const readline = require('readline');

const NOISE_PREFIXES = [
    '<task-notification>', '<turn_aborted>', '<local-command-caveat>',
    '[Request interrupted', '<command-name>', '<system-reminder>',
    '# AGENTS.md', '<INSTRUCTIONS>', '<local-command-stdout>',
    'Automation:', '<subagent_notification>'
];

function summarizeToolCall(block) {
    const name = block?.name || '?';
    const inp = (block && typeof block.input === 'object' && block.input) || {};
    switch (name) {
        case 'Bash': return `[Bash] ${String(inp.command || '').slice(0, 120)}`;
        case 'Read': return `[Read] ${inp.file_path || '?'}`;
        case 'Edit': return `[Edit] ${inp.file_path || '?'}`;
        case 'Write': return `[Write] ${inp.file_path || '?'}`;
        case 'Glob': return `[Glob] ${inp.pattern || '?'}`;
        case 'Grep': return `[Grep] ${inp.pattern || '?'}`;
        case 'Agent': return `[Agent] ${String(inp.prompt || '?').slice(0, 80)}`;
        default: {
            const short = name.includes('__') ? name.split('__').pop() : name;
            const args = Object.entries(inp).slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(' ');
            return `[${short}] ${args}`.slice(0, 120);
        }
    }
}

async function eachJsonLine(file, onEntry) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch (e) { continue; }
        if (onEntry(entry) === false) { rl.close(); break; }
    }
}

/**
 * Claude Code transcript → [{ text, ts, assistant, assistantTs, tools }].
 *
 * A reply belongs to the user turn it answers. agent_migration.py attached
 * each assistant message to the NEXT user turn and overwrote earlier text
 * blocks, so a reply could land on a harness message (a <system-reminder>)
 * and vanish with it when noise was filtered. Here every assistant text and
 * tool call accrues to the most recent real user turn; harness messages and
 * tool results never become turns at all.
 */
async function readClaudeTurns(file) {
    const turns = [];
    let current = null;
    await eachJsonLine(file, (entry) => {
        const ts = String(entry.timestamp || '');
        if (entry.type === 'assistant') {
            const msg = entry.message;
            if (!msg || typeof msg !== 'object') return;
            for (const block of Array.isArray(msg.content) ? msg.content : []) {
                if (!block || typeof block !== 'object') continue;
                if (block.type === 'text' && block.text) {
                    if (current) {
                        current.assistant = current.assistant ? `${current.assistant}\n${block.text}` : String(block.text);
                        current.assistantTs = ts.slice(0, 19);
                    }
                } else if (block.type === 'tool_use') {
                    if (current) current.tools.push(summarizeToolCall(block));
                }
            }
        } else if (entry.type === 'user') {
            const msg = entry.message;
            const content = msg && typeof msg === 'object' ? msg.content : '';
            let text = '';
            if (typeof content === 'string') text = content.trim();
            else if (Array.isArray(content)) {
                for (const block of content) {
                    if (block && typeof block === 'object' && block.type === 'text') { text = String(block.text || '').trim(); break; }
                    if (typeof block === 'string') { text = block.trim(); break; }
                }
            }
            if (!text || NOISE_PREFIXES.some((p) => text.startsWith(p))) return;
            current = { text, ts: ts.slice(0, 19), assistant: '', assistantTs: '', tools: [] };
            turns.push(current);
        }
    });
    return turns;
}

/** Codex rollout → same shape (no tool summaries: rollouts do not carry them). */
async function readCodexTurns(file) {
    const turns = [];
    let current = null;
    await eachJsonLine(file, (entry) => {
        const ts = String(entry.timestamp || '');
        const payload = (entry.payload && typeof entry.payload === 'object') ? entry.payload : {};
        if (entry.type === 'response_item' && payload.role === 'assistant' && payload.type === 'message') {
            const parts = [];
            for (const block of Array.isArray(payload.content) ? payload.content : []) {
                if (block && typeof block === 'object' && block.type === 'output_text' && block.text) parts.push(block.text);
            }
            if (parts.length && current) {
                const text = parts.join('\n');
                current.assistant = current.assistant ? `${current.assistant}\n${text}` : text;
                current.assistantTs = ts.slice(0, 19);
            }
            return;
        }
        let text = '';
        if (entry.type === 'event_msg' && payload.type === 'user_message') {
            text = String(payload.message || '').trim();
        } else if (entry.type === 'response_item' && payload.role === 'user' && payload.type === 'message') {
            for (const block of Array.isArray(payload.content) ? payload.content : []) {
                if (block && typeof block === 'object' && block.type === 'input_text') { text = String(block.text || '').trim(); break; }
            }
        }
        if (!text || text.length <= 3) return;
        // Codex logs a user turn twice (event + response item); keep one.
        if (current && current.text.slice(0, 100) === text.slice(0, 100) && current.ts === ts.slice(0, 19)) return;
        current = { text, ts: ts.slice(0, 19), assistant: '', assistantTs: '', tools: [] };
        turns.push(current);
    });
    return turns;
}

function detectTool(file) {
    if (/[\\/]\.codex[\\/]/.test(file)) return 'codex';
    if (/[\\/]\.gemini[\\/]/.test(file)) return 'gemini';
    return 'claude';
}

/** The working directory the transcript was recorded in, from its first entry that says. */
async function readTranscriptCwd(file) {
    let cwd = 'unknown';
    await eachJsonLine(file, (entry) => {
        const c = entry.cwd || (entry.payload && entry.payload.cwd);
        if (typeof c === 'string' && c) { cwd = c; return false; }
        return true;
    });
    return cwd;
}

/** A Codex rollout's own session id, for `codex resume <id>`. */
async function codexRolloutId(file) {
    let id = null;
    await eachJsonLine(file, (entry) => {
        if (entry.type === 'session_meta' && entry.payload && typeof entry.payload.id === 'string') id = entry.payload.id;
        return false;
    });
    return id;
}

/**
 * Build the handoff document. Turns are taken from the END until the
 * character budget fills — the most recent context is what the receiver
 * needs — then harness noise is dropped.
 */
async function extractConversation(file, { maxChars = 800000, tool } = {}) {
    const kind = tool || detectTool(file);
    if (kind === 'gemini') throw new Error('Gemini transcripts are not supported for handoff');
    const turns = kind === 'codex' ? await readCodexTurns(file) : await readClaudeTurns(file);
    const selected = [];
    let total = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        const size = t.text.length + (t.assistant || '').length + (t.tools || []).reduce((n, x) => n + x.length, 0);
        if (total + size > maxChars && selected.length) break;
        selected.push(t);
        total += size;
    }
    selected.reverse();
    const kept = selected.filter((t) => !NOISE_PREFIXES.some((p) => t.text.trim().startsWith(p)));
    const cwd = await readTranscriptCwd(file);
    const lines = [
        '# Conversation Extract',
        `# Source tool: ${kind}`,
        `# Source file: ${file}`,
        `# Working directory: ${cwd}`
    ];
    if (turns.length) {
        lines.push(`# First message: ${turns[0].ts || 'unknown'}`);
        lines.push(`# Last message: ${turns[turns.length - 1].ts || 'unknown'}`);
    }
    lines.push(`# Turns included below: ${kept.length} (most recent, within token budget)`);
    lines.push(`# Extracted: ${new Date().toISOString().slice(0, 19)}`);
    lines.push('');
    for (const t of kept) {
        lines.push(`## User [${t.ts || ''}]`, t.text, '');
        if (t.tools && t.tools.length) {
            lines.push('### Actions taken:');
            for (const x of t.tools) lines.push(`  ${x}`);
            lines.push('');
        }
        if (t.assistant) lines.push('## Assistant', t.assistant, '');
    }
    return { text: lines.join('\n'), tool: kind, cwd, turns: kept.length, totalTurns: turns.length };
}

/** The instruction the receiving agent starts with. */
function handoffPrompt(extractPath, bytes, sourceTool) {
    const kb = Math.max(1, Math.round(bytes / 1024));
    return `Read the ENTIRE file ${extractPath} (${kb}KB) from start to finish — do not stop at the first chunk. `
        + `It contains a previous ${sourceTool} conversation. After reading all of it, summarize what we were working on and ask me what to do next.`;
}

module.exports = { extractConversation, readClaudeTurns, readCodexTurns, summarizeToolCall, detectTool, codexRolloutId, handoffPrompt };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const file = argv.find((a) => !a.startsWith('-'));
    if (!file) {
        console.error('Usage: node scripts/trajectory-extract.js <transcript.jsonl> [--max-chars N] [--tool claude|codex]');
        process.exit(1);
    }
    const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
    extractConversation(file, { maxChars: Number(flag('--max-chars')) || undefined, tool: flag('--tool') })
        .then((r) => process.stdout.write(r.text))
        .catch((e) => { console.error(e.message); process.exit(1); });
}
