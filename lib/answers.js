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
// Where the agent app says where a prompt came from (Claude's transcript
// marks a scheduled run, a peer agent's message, a task notice), the hook
// writes it beside the answer, and a turn none of whose prompts came from
// a person is never a question. The text rules below catch the rest.
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

// Claude Code and Codex put these in the user's turn themselves (Codex's
// app asks the thread for a catch-up when its person comes back).
const INTERNAL_RE = /^\s*(<(task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)\b|Caveat: The messages below|Write a brief catch-up for a user returning to this task|Your claude\.ai usage limit has reset)/;
// hop's sender line, the CEO's push (it writes in its person's voice), and
// Claude's own agents: a subagent's hand-back, another session's message,
// a coordinator's.
const AGENT_RE = /^\s*(\[hop message from |\[CEO\]|<agent-message\b|Another Claude session sent a message|The coordinator sent a message)/;
// A loop's run: /loop as it fires again (its agent may rewrite the prompt
// each time, so it is never the same words twice), or its sentinel.
const LOOP_RE = /^\s*(\/loop\b|<<autonomous-loop)/;
// Where Claude's transcript says a prompt came from: a person, or one of
// these, which are never a person's question. Any other kind (an SDK
// driver, one no one has told hop about yet) leaves it to the text.
const HUMAN_ORIGINS = new Set(['human']);
const AUTOMATIC_ORIGINS = new Set(['scheduled', 'task-notification', 'task_notification', 'peer', 'coordinator', 'auto-continuation', 'auto_continuation', 'system']);

// Claude wraps a paste in <pasted_content id="…"> … </pasted_content id="…">,
// a long one in several pieces with one id. hop delivers by pasting, so
// its messages arrive wrapped: what counts is what is inside.
function unwrapPastes(t) {
    return String(t || '')
        .replace(/\n?<\/pasted_content(?: [^>]*)?>\n*<pasted_content(?: [^>]*)?>\n?/g, '')
        .replace(/<\/?pasted_content(?: [^>]*)?>/g, '\n');
}

const norm = (t) => String(t || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

function emptyStore() {
    return { version: 1, items: [] };
}

function normalizeStore(raw) {
    const store = emptyStore();
    if (raw && Array.isArray(raw.items)) {
        store.items = raw.items.filter((a) => a && typeof a.id === 'string' && typeof a.session === 'string' && Number.isFinite(a.askedAt))
            // Kept before a rule knew better (a loop's run, an agent's
            // message): not the person's, so not kept.
            .filter((a) => ['person', 'typed', 'repeat'].includes(classify(a.question, { at: a.askedAt })));
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
 * 'agent' (another session, the CEO, a subagent), 'loop' (a /loop run),
 * 'typed' (hop or an agent typed it through hop), 'repeat' (the same
 * words again: a schedule).
 *
 * typed: [{ at, text, person }] — what went into this session's terminal
 * through hop (deliveries mark the person's own queued messages); asked:
 * [{ at, text }] — this session's earlier prompts.
 */
function classify(text, { at = Date.now(), typed = [], asked = [] } = {}) {
    const raw = unwrapPastes(text);
    if (!raw.trim()) return 'internal';
    if (INTERNAL_RE.test(raw)) return 'internal';
    if (AGENT_RE.test(raw)) return 'agent';
    if (LOOP_RE.test(raw)) return 'loop';
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

/**
 * Did a person start any of this turn's prompts? The hook's list of where
 * they came from: true, false (all scheduled, peers, notices), or null —
 * nothing said (Codex, Antigravity, an older Claude): the text decides.
 */
function humanTurn(origins) {
    if (!Array.isArray(origins) || !origins.length) return null;
    if (origins.some((o) => HUMAN_ORIGINS.has(o))) return true;
    return origins.every((o) => AUTOMATIC_ORIGINS.has(o)) ? false : null;
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

module.exports = { KEEP_MS, KEEP_MAX, TYPED_WINDOW_MS, REPEAT_WINDOW_MS, emptyStore, normalizeStore, prune, classify, unwrapPastes, humanTurn, add, markRead, unreadBySession };
