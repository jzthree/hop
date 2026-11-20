'use strict';
// Codex (seen with 0.166, November 2026) starts a fresh set of its helper
// servers — the computer-use REPL, the plugin runtimes, the MCP servers — for
// work inside a long session and never stops the old ones. A session from
// Nov 6 had eleven copies of each by Nov 19: 77 processes, 6.5 GB, on a Mac
// that was swapping. Restarting that Codex (it resumes the same
// conversation) is the cure, and hop does it for the person while the
// session is idle.
//
// This module only decides. A healthy Codex runs one copy of each helper
// (two of a couple), so the sign is many copies of one helper under one
// codex process. When Codex stops leaking, nothing matches and nothing is
// restarted.

/** Copies of a single helper under one codex at which it counts as piled up. */
const MIN_COPIES = 6;

/** A helper server rather than a command the agent is running. */
const HELPER = /mcp|node_repl|codex-primary-runtime|code-mode-host/i;

/** `ps -axww -o pid=,ppid=,command=` → rows. */
function parsePs(text) {
    const rows = [];
    for (const line of String(text || '').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
    }
    return rows;
}

/** The hop session a codex launch belongs to, from the identity flag hop puts on it. */
function sessionOf(command) {
    const m = /shell_environment_policy\.set\.HOP_SESSION=["']?([A-Za-z0-9_-]+)/.exec(String(command || ''));
    return m ? m[1] : null;
}

/** The codex program itself (not its code-mode host or another helper). */
function isCodex(command) {
    const program = String(command || '').split(/\s+/)[0] || '';
    return /(^|\/)codex$/.test(program);
}

/** A short name for a helper, for the log. */
function helperLabel(command) {
    const c = String(command || '');
    const m = /(ngs_[a-z_]+mcp)|(node_repl)|(hop-mcp\.js)|(nebula-notebook-mcp)|(code-mode-host)|(dist\/server\.mjs|launch\.mjs|mcp\/server\.cjs)/.exec(c);
    if (!m) return (c.split(/\s+/)[0] || '').split('/').pop() || 'helper';
    const hit = m.find((x, i) => i > 0 && x);
    return /server\.mjs|launch\.mjs|server\.cjs/.test(hit) ? `computer-use ${hit.split('/').pop()}` : hit;
}

/**
 * Every hop codex whose helpers have piled up: [{ pid, session, helpers,
 * worst: { label, command, copies } }], most copies first.
 */
function findPileUps(psText, { minCopies = MIN_COPIES } = {}) {
    const rows = parsePs(psText);
    const children = new Map();
    for (const r of rows) {
        if (!children.has(r.ppid)) children.set(r.ppid, []);
        children.get(r.ppid).push(r);
    }
    const out = [];
    for (const r of rows) {
        if (!isCodex(r.command)) continue;
        const session = sessionOf(r.command);
        if (!session) continue;
        const counts = new Map();
        let helpers = 0;
        for (const child of children.get(r.pid) || []) {
            if (!HELPER.test(child.command)) continue;
            helpers++;
            counts.set(child.command, (counts.get(child.command) || 0) + 1);
        }
        let worst = null;
        for (const [command, copies] of counts) if (!worst || copies > worst.copies) worst = { command, copies };
        if (worst && worst.copies >= minCopies) {
            out.push({ pid: r.pid, session, helpers, worst: { label: helperLabel(worst.command), command: worst.command, copies: worst.copies } });
        }
    }
    return out.sort((a, b) => b.worst.copies - a.worst.copies);
}

/** Rules for when a piled-up session may be restarted for the person. */
const DEFAULT_RULES = {
    quietMs: 20 * 60_000,       // no terminal activity for this long
    unseenMs: 10 * 60_000,      // nobody has looked at it for this long
    cooldownMs: 6 * 3600_000,   // at most this often per session
    maxPerDay: 8                // across all sessions
};

/**
 * Whether this session may be restarted now. `s`: { phase, lastActivityAt,
 * userAttached, lastUserSeenAt, draft }; `history`: past restarts [{ at, session }].
 * → { ok: true } or { ok: false, why }.
 */
function mayRestart(s, history, now, rules = DEFAULT_RULES) {
    if (s.phase === 'working') return { ok: false, why: 'working' };
    if (s.userAttached) return { ok: false, why: 'open on screen' };
    if (now - (Number(s.lastActivityAt) || 0) < rules.quietMs) return { ok: false, why: 'active recently' };
    if (now - (Number(s.lastUserSeenAt) || 0) < rules.unseenMs) return { ok: false, why: 'seen recently' };
    if (s.draft) return { ok: false, why: 'text in its input box' };
    const past = (history || []).filter((h) => now - h.at < 24 * 3600_000);
    if (past.some((h) => h.session === s.session && now - h.at < rules.cooldownMs)) return { ok: false, why: 'restarted recently' };
    if (past.length >= rules.maxPerDay) return { ok: false, why: 'daily limit' };
    return { ok: true };
}

module.exports = { MIN_COPIES, DEFAULT_RULES, parsePs, sessionOf, isCodex, helperLabel, findPileUps, mayRestart };
