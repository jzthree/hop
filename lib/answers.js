'use strict';
// Answers — each question a person asks a session, with the agent's reply.
//
// An agent left to drive itself keeps working after it answers, and the
// answer scrolls away under the next turns. hop sees both ends of every
// turn (the agents' hooks: the prompt as it is submitted, the last words
// as the turn ends), so it keeps the pair for its person — no agent has to
// decide what deserves a page of its own. Only the person's own prompts
// count: what hop typed for a check-back or another session, what an agent
// typed through hop's terminal API, a session's own loop, and the agent
// app's own notices are the agents' business.
//
// Pure: the daemon reads the hook files, keeps the typed-input log, and
// does the I/O.

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 500;
// How far back typed input can explain a prompt (a long paste into a busy
// agent submits late), and how long a repeated prompt reads as a loop.
const TYPED_WINDOW_MS = 15 * 60 * 1000;
const REPEAT_WINDOW_MS = 6 * 60 * 60 * 1000;
const TEXT_MAX = 64 * 1024;

// Claude Code and Codex put these in the user's turn themselves.
const INTERNAL_RE = /^\s*(<(task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b|Caveat: The messages below|<<autonomous-loop)/;
// hop's sender line, and the CEO's push (it writes in its person's voice).
const AGENT_RE = /^\s*(\[hop message from |\[CEO\])/;

const norm = (t) => String(t || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

function emptyStore() {
    return { version: 1, items: [] };
}

function normalizeStore(raw) {
    const store = emptyStore();
    if (raw && Array.isArray(raw.items)) {
        store.items = raw.items.filter((a) => a && typeof a.id === 'string' && typeof a.session === 'string' && Number.isFinite(a.askedAt));
    }
    return store;
}

function prune(store, now = Date.now()) {
    store.items = store.items
        .filter((a) => now - (a.answeredAt || a.askedAt) <= KEEP_MS)
        .sort((a, b) => (a.answeredAt || a.askedAt) - (b.answeredAt || b.askedAt));
    if (store.items.length > KEEP_MAX) store.items = store.items.slice(-KEEP_MAX);
    return store;
}

/**
 * Whose prompt is this? 'person' — its person typed or sent it; anything
 * else is not a question for Answers: 'internal' (the agent app's own),
 * 'agent' (another session, the CEO), 'typed' (hop or an agent typed it
 * through hop), 'repeat' (the same words again: a loop).
 *
 * typed: [{ at, text, person }] — what went into this session's terminal
 * through hop (deliveries mark the person's own queued messages); asked:
 * [{ at, text }] — this session's earlier prompts.
 */
function classify(text, { at = Date.now(), typed = [], asked = [] } = {}) {
    const raw = String(text || '');
    if (!raw.trim()) return 'internal';
    if (INTERNAL_RE.test(raw)) return 'internal';
    if (AGENT_RE.test(raw)) return 'agent';
    const t = norm(raw);
    const probe = t.slice(0, 200);
    const recent = typed.filter((x) => x && at - x.at <= TYPED_WINDOW_MS && x.at <= at + 5000);
    // A person's queued message (the web's "send when done", a briefing
    // reply) was typed by hop, but the words are theirs.
    if (recent.some((x) => x.person && norm(x.text).includes(probe))) return 'person';
    if (probe && norm(recent.filter((x) => !x.person).map((x) => x.text).join('')).includes(probe)) return 'typed';
    if (t.length >= 20 && asked.some((x) => x && at - x.at <= REPEAT_WINDOW_MS && x.at < at && norm(x.text) === t)) return 'repeat';
    return 'person';
}

/** A question answered: kept, unread. Returns the entry. */
function add(store, a, now = Date.now()) {
    const entry = {
        id: String(a.id),
        session: String(a.session),
        agent: a.agent || null,
        question: String(a.question || '').slice(0, 8000),
        askedAt: Number(a.askedAt),
        answer: String(a.answer || '').slice(0, TEXT_MAX),
        answeredAt: Number(a.answeredAt) || now,
        readAt: null
    };
    store.items = store.items.filter((x) => x.id !== entry.id);
    store.items.push(entry);
    prune(store, now);
    return entry;
}

/** Mark read: these ids, or every answer of a session, or all. Returns how many changed. */
function markRead(store, { ids = null, session = null, all = false } = {}, now = Date.now()) {
    let n = 0;
    for (const a of store.items) {
        if (a.readAt) continue;
        if (all || (ids && ids.includes(a.id)) || (session && a.session === session)) { a.readAt = now; n++; }
    }
    return n;
}

/** Unread answers per session: { [session]: count }. */
function unreadBySession(store) {
    const out = {};
    for (const a of store.items) if (!a.readAt) out[a.session] = (out[a.session] || 0) + 1;
    return out;
}

module.exports = { KEEP_MS, KEEP_MAX, TYPED_WINDOW_MS, REPEAT_WINDOW_MS, emptyStore, normalizeStore, prune, classify, add, markRead, unreadBySession };
