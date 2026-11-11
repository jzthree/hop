'use strict';
// Messages between sessions — hop as an instant messenger for its agents.
//
// hop's queue (lib/checkbacks.js) types a message into an agent's input box
// when the agent is free. When ANOTHER session sent it, the agent there has
// to know three things the bare text cannot say: who wrote it, that its own
// person did not, and how to answer. So the typed text leads with one line
// saying so. The stored message stays as written — the queue card shows it
// and it can be edited — and the line is added only at typing time.
//
// Presence (who is free to talk) comes from what hop already tracks: the
// agent's turn phase, an open question for its person, whether it runs.
//
// Pure: the daemon supplies the records and the clock.

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

// Every sender line starts this way; stripEnvelope relies on it.
const ENVELOPE_RE = /^\[hop message from [^\]\n]*\]\s*/;

/** A session name as one shell word: bare when safe, else double-quoted. */
function shellName(name) {
    const s = String(name || '');
    return /^[A-Za-z0-9_.@%+=:,/-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Who sent a queued message or check-back, as the recipient should hear it;
 * null when nobody else did (its own person, or a reminder it set itself).
 */
function senderOf(cb) {
    if (!cb) return null;
    if (cb.fromOutside === true) return { outside: true };
    if (cb.fromSession && cb.fromSession !== cb.session) {
        return { name: cb.fromName || cb.fromSession, agent: cb.fromAgent || null, readsHere: cb.replyHere === true };
    }
    return null;
}

/**
 * The line before a message from someone else. `readsHere`: the sender waits
 * on this turn and reads the answer from it (an orchestrator's send-and-wait),
 * so a separate reply would arrive twice.
 */
function envelope(from) {
    if (!from) return '';
    if (from.outside) return '[hop message from an agent outside hop, not your user]';
    if (!from.name) return '';
    const kind = AGENT_NAMES[from.agent];
    const who = kind ? ` (${/^[AEIOU]/.test(kind) ? 'an' : 'a'} ${kind} agent, not your user)` : '';
    const head = `[hop message from session ${JSON.stringify(String(from.name))}${who}`;
    if (from.readsHere) return `${head}. It reads your reply here.]`;
    return `${head}. To answer, if an answer is needed: hop send ${shellName(from.name)} "<your reply>"]`;
}

/** What hop types for a queued message or check-back. */
function typedText(cb) {
    const line = envelope(senderOf(cb));
    return line ? `${line} ${cb.message}` : cb.message;
}

/** A prompt without hop's sender line (taglines read what was asked). */
function stripEnvelope(text) {
    return String(text || '').replace(ENVELOPE_RE, '');
}

/**
 * A session as a contact: 'free' (an agent between turns), 'busy' (mid-turn:
 * a message waits for the turn to end), 'needs-user' (waiting on its person),
 * 'offline' (not running), 'shell' (no agent to message).
 */
function presence(s) {
    if (!s || s.live !== true) return 'offline';
    if (!s.agent) return 'shell';
    if (s.attentionReason === 'ask') return 'needs-user';
    if (s.agentPhase === 'working') return 'busy';
    return 'free';
}

// Two agents thanking each other forever would spend both users' turns. A
// pair that has traded this many messages within the window is held for
// its person instead.
const PAIR_WINDOW_MS = 10 * 60_000;
const PAIR_MAX = 12;

/** How many messages a and b have sent each other within the window. */
function pairTraffic(items, a, b, now = Date.now(), windowMs = PAIR_WINDOW_MS) {
    return (items || []).filter((c) => c && c.fromSession
        && ((c.fromSession === a && c.session === b) || (c.fromSession === b && c.session === a))
        && now - (Number(c.createdAt) || 0) < windowMs).length;
}

// Anyone who writes to you may be answered: a reply to a session that wrote
// within this long is allowed even where agents may not otherwise go.
const REPLY_WINDOW_MS = 24 * 3_600_000;

/** Did session `to` write to session `from` recently (so `from` may answer)? */
function mayAnswer(items, from, to, now = Date.now(), windowMs = REPLY_WINDOW_MS) {
    return (items || []).some((c) => c && c.fromSession === to && c.session === from
        && now - (Number(c.deliveredAt) || Number(c.createdAt) || 0) < windowMs);
}

module.exports = {
    AGENT_NAMES, PAIR_MAX, PAIR_WINDOW_MS, REPLY_WINDOW_MS,
    shellName, senderOf, envelope, typedText, stripEnvelope, presence, pairTraffic, mayAnswer
};
