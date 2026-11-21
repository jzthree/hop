'use strict';
// When an Antigravity conversation cannot be reopened — agy deletes all but
// its newest ~500 conversations, open ones too, and agy 1.5.9 kept none on
// disk at all — `hop recover` starts a new one that reads what hop kept of
// the old: the lines of agy's own transcript that survive, the messages
// between this session and the others, the prompts hop typed into it (check-
// backs), the handoff it was started from, and who to ask for a recap.
// Pure: the caller reads the files and writes the result.

const ENTRY_MAX = 6000;       // one message or transcript line
const SECTION_MAX = 120000;   // each section keeps its newest part

const iso = (ms) => {
    const n = Number(ms);
    return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
};
const clip = (t, max = ENTRY_MAX) => {
    const s = String(t == null ? '' : t).trim();
    return s.length > max ? `${s.slice(0, max)}\n[… ${s.length - max} more characters]` : s;
};
/** Newest entries that fit in `max` characters, oldest first, with a note of what was left out. */
function newest(blocks, max = SECTION_MAX) {
    const out = [];
    let used = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
        if (used + blocks[i].length > max && out.length) {
            out.unshift(`[${i + 1} earlier entr${i === 0 ? 'y' : 'ies'} left out for length]`);
            break;
        }
        out.unshift(blocks[i]);
        used += blocks[i].length;
    }
    return out;
}

/** agy's transcript lines ({ type, source, created_at, content }) as readable entries. */
function transcriptEntries(jsonl) {
    const out = [];
    for (const line of String(jsonl || '').split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch (e) { continue; }
        if (!r || typeof r !== 'object') continue;
        const text = typeof r.content === 'string' ? r.content : (r.content ? JSON.stringify(r.content) : '');
        if (!text.trim()) continue;
        const who = r.type === 'USER_INPUT' ? 'Prompt' : String(r.type || 'Step').toLowerCase().replace(/_/g, ' ');
        out.push({ at: r.created_at || '', who, text: text.replace(/<\/?USER_REQUEST>/g, '').replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '').trim() });
    }
    return out;
}

/**
 * The handoff: markdown for the new agy to read first.
 * { display, internalName, cwd, conversationId, why, forkedFromName, handoffFiles: [path],
 *   transcript: [{at, who, text}], messages: [{at, fromName, toName, from, text, status}],
 *   checkbacks: [{at, text, pending, by}], brainFiles: [path], now }
 */
function buildHandoff(o) {
    const lines = [];
    const partnerCounts = new Map();
    for (const m of o.messages || []) {
        const other = m.from === o.internalName ? m.toName : m.fromName;
        if (other && other !== 'None') partnerCounts.set(other, (partnerCounts.get(other) || 0) + 1);
    }
    const partners = [...partnerCounts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    lines.push(`# Recovering ${o.display}`);
    lines.push('');
    lines.push(`Written by hop on ${iso(o.now || Date.now())}. Your earlier Antigravity conversation in this hop session (${o.conversationId || 'unknown id'}) could not be reopened: ${o.why || 'agy no longer has it'}. This is a new conversation. Below is everything hop kept of the old one. Read all of it before doing anything.`);
    lines.push('');
    lines.push(`- Session: ${o.display} (${o.internalName}), working directory ${o.cwd || 'unknown'}.`);
    if (o.forkedFromName) lines.push(`- It was handed off from the session ${o.forkedFromName}; that session is the best source for the original task.`);
    if (partners.length) lines.push(`- The sessions it talked with, most first: ${partners.join(', ')}. Ask the first for a recap of where your work stood: \`hop send ${partners[0]} "…"\`.`);
    for (const f of o.handoffFiles || []) lines.push(`- A handoff file from when it started: ${f}`);
    for (const f of o.brainFiles || []) lines.push(`- A file agy kept from the old conversation: ${f}`);
    lines.push('- Files the work produced are where it left them: check the working directory and any handoff or status files it names before redoing anything.');
    lines.push('');
    const t = o.transcript || [];
    lines.push(`## What survives of agy's own transcript (${t.length} entr${t.length === 1 ? 'y' : 'ies'})`);
    lines.push('');
    lines.push(t.length ? newest(t.map((e) => `**${e.who}**${e.at ? ` · ${e.at}` : ''}\n\n${clip(e.text)}\n`)).join('\n') : 'Nothing: agy kept no transcript of it.');
    lines.push('');
    const m = o.messages || [];
    lines.push(`## Messages between this session and others (${m.length})`);
    lines.push('');
    lines.push(m.length ? newest(m.map((x) => {
        const dir = x.from === o.internalName ? `You → ${x.toName || x.to}` : `${x.fromName && x.fromName !== 'None' ? x.fromName : 'An agent outside hop'} → you`;
        return `**${dir}** · ${iso(x.at)}${x.status && x.status !== 'delivered' ? ` · ${x.status}` : ''}\n\n${clip(x.text)}\n`;
    })).join('\n') : 'None.');
    lines.push('');
    const c = o.checkbacks || [];
    lines.push(`## Prompts hop typed into this session, and those still to come (${c.length})`);
    lines.push('');
    lines.push(c.length ? newest(c.map((x) => `**${x.pending ? 'Still to come' : 'Typed'}** · ${iso(x.at)}${x.by ? ` · set by ${x.by}` : ''}\n\n${clip(x.text)}\n`)).join('\n') : 'None.');
    lines.push('');
    return lines.join('\n');
}

/** The prompt the new agy starts with. */
function startPrompt(file, display) {
    return `Read the ENTIRE file ${file} first. Your earlier Antigravity conversation in this hop session (${display}) could not be reopened, so this is a new one; that file holds everything hop kept of it. Then continue the work from where it stopped.`;
}

module.exports = { buildHandoff, transcriptEntries, startPrompt, newest };
