'use strict';
// The message log — what sessions said to each other, for their person to
// read. Messaging is for agents (lib/messages.js): hop types a message into
// the recipient's input box, and once delivered the queue forgets it within
// a day. This keeps the conversation: who wrote whom, what, when, and what
// became of it (waiting for the turn to end, delivered, refused, held by
// the loop brake), plus the answer when the sender read it off the
// recipient's turn (send-and-wait) instead of getting a message back.
//
// Read-only for people: nothing here sends. Pure: the daemon does the I/O.

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 2000;
// A send-and-wait answer is the recipient's next finished turn; one that
// never finishes stops being waited on.
const REPLY_WAIT_MS = 6 * 60 * 60 * 1000;
const TEXT_MAX = 8000;

const STATUSES = new Set(['waiting', 'delivered', 'failed', 'cancelled', 'refused', 'held']);

function emptyLog() {
    return { version: 1, messages: [] };
}

function normalizeLog(raw) {
    const log = emptyLog();
    if (raw && Array.isArray(raw.messages)) {
        log.messages = raw.messages.filter((m) => m && typeof m.id === 'string' && typeof m.to === 'string' && Number.isFinite(m.at));
    }
    return log;
}

/** Thirty days, at most KEEP_MAX, oldest first. */
function prune(log, now = Date.now()) {
    log.messages = log.messages
        .filter((m) => now - m.at <= KEEP_MS)
        .sort((a, b) => a.at - b.at);
    if (log.messages.length > KEEP_MAX) log.messages = log.messages.slice(-KEEP_MAX);
    return log;
}

/**
 * Record one message (or update it, by id). `from` is the sending session,
 * null for an agent outside hop. Returns the stored entry.
 */
function record(log, m, now = Date.now()) {
    const entry = {
        id: String(m.id),
        from: m.from || null,
        fromName: m.fromName || m.from || null,
        fromAgent: m.fromAgent || null,
        to: String(m.to),
        toName: m.toName || m.to,
        text: String(m.text || '').slice(0, TEXT_MAX),
        at: Number.isFinite(m.at) ? m.at : now,
        status: STATUSES.has(m.status) ? m.status : 'waiting',
        ...(m.reason ? { reason: String(m.reason) } : {}),
        ...(m.scheduled ? { scheduled: true } : {}),
        ...(m.replyHere ? { replyHere: true } : {}),
        ...(Number.isFinite(m.deliveredAt) ? { deliveredAt: m.deliveredAt } : {})
    };
    const i = log.messages.findIndex((x) => x.id === entry.id);
    if (i >= 0) log.messages[i] = { ...log.messages[i], ...entry };
    else log.messages.push(entry);
    prune(log, now);
    return entry;
}

/**
 * Mirror the queue's word on a message it carries (delivered, failed,
 * cancelled, still waiting and why). Returns true when the entry changed.
 * `turnCount`: the recipient's finished turns at delivery, so a
 * send-and-wait answer can be told from turns before it.
 */
function mirror(log, cb, { turnCount = null } = {}) {
    const m = log.messages.find((x) => x.id === cb.id);
    if (!m) return false;
    const status = cb.status === 'delivered' ? 'delivered'
        : cb.status === 'failed' ? 'failed'
        : cb.status === 'cancelled' ? 'cancelled'
        : (cb.status === 'pending' && cb.deliveredAt) ? 'delivered' // a recurring one: delivered at least once
        : 'waiting';
    const reason = status === 'waiting' || status === 'failed' ? (cb.lastError || undefined) : undefined;
    const deliveredAt = Number.isFinite(cb.deliveredAt) ? cb.deliveredAt : undefined;
    if (m.status === status && m.reason === reason && m.deliveredAt === deliveredAt) return false;
    m.status = status;
    if (reason) m.reason = reason; else delete m.reason;
    if (deliveredAt) m.deliveredAt = deliveredAt;
    if (status === 'delivered' && m.replyHere && m.turnBase == null && Number.isFinite(turnCount)) m.turnBase = turnCount;
    return true;
}

/** Messages whose sender waits on the recipient's turn, answer not yet seen. */
function awaitingReply(log, now = Date.now()) {
    return log.messages.filter((m) => m.replyHere && m.status === 'delivered' && !m.replyAt
        && Number.isFinite(m.turnBase) && now - (m.deliveredAt || m.at) < REPLY_WAIT_MS);
}

/**
 * The recipient finished a turn after the message went in: that turn's last
 * words are the answer the sender read. `turn`: { count, at, lastMessage }.
 */
function noteReply(m, turn) {
    if (!turn || !Number.isFinite(turn.count) || turn.count <= m.turnBase) return false;
    const at = Date.parse(turn.at) || Date.now();
    if (at < (m.deliveredAt || m.at)) return false;
    m.replyAt = at;
    m.reply = typeof turn.lastMessage === 'string' ? turn.lastMessage.slice(0, TEXT_MAX) : '';
    return true;
}

module.exports = { KEEP_MS, KEEP_MAX, REPLY_WAIT_MS, emptyLog, normalizeLog, prune, record, mirror, awaitingReply, noteReply };
