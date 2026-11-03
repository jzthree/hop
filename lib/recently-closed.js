'use strict';
// Recently closed sessions — the undo for a kill, a stop, or a session that
// ended on its own. Killing deletes a session's config and its restore
// records, so a snapshot taken at the moment of the kill would already be
// too late; instead the daemon keeps a recent snapshot of every LIVE session
// (its saved config and its restore records: the SessionStart-hook .json,
// the agent's .turn, the durable .meta), refreshed on a sweep. When a
// session stops being live, its last snapshot moves here, and "bring back"
// writes back whatever went missing and restores it by name — resuming the
// same Claude or Codex conversation.
//
// Pure bookkeeping: the daemon supplies the snapshots and does the I/O.

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 60;
const RECORD_EXTS = ['json', 'turn', 'meta'];

function emptyStore() {
    return { version: 1, closed: [] };
}

function normalizeStore(raw) {
    const store = emptyStore();
    if (raw && Array.isArray(raw.closed)) {
        store.closed = raw.closed.filter((e) => e && typeof e.internalName === 'string' && Number.isFinite(e.closedAt));
    }
    return store;
}

/** Keep two weeks, at most KEEP_MAX, newest first; one entry per session. */
function prune(store, now = Date.now()) {
    const seen = new Set();
    store.closed = store.closed
        .filter((e) => now - e.closedAt <= KEEP_MS)
        .sort((a, b) => b.closedAt - a.closedAt)
        .filter((e) => (seen.has(e.internalName) ? false : (seen.add(e.internalName), true)))
        .slice(0, KEEP_MAX);
    return store;
}

/**
 * Sessions that were live at the last sweep and are not now: each one's last
 * snapshot, closed now. `how` names why when the daemon knows (a kill, a
 * stop); otherwise it ended on its own. Returns the entries added.
 */
function noteClosures(store, lastLive, liveNow, { now = Date.now(), how = {} } = {}) {
    const added = [];
    for (const [internalName, snap] of lastLive) {
        if (liveNow.has(internalName)) continue;
        const entry = { ...snap, internalName, closedAt: now, how: how[internalName] || 'ended' };
        store.closed = store.closed.filter((e) => e.internalName !== internalName);
        store.closed.unshift(entry);
        added.push(entry);
    }
    prune(store, now);
    return added;
}

/** A live session is no longer "closed" (it was brought back, or reopened). */
function dropReopened(store, liveNow) {
    const before = store.closed.length;
    store.closed = store.closed.filter((e) => !liveNow.has(e.internalName));
    return before !== store.closed.length;
}

/** What the web lists: no file contents, just enough to choose. */
function listing(store, now = Date.now()) {
    return prune(store, now).closed.map((e) => ({
        internalName: e.internalName,
        displayName: e.displayName || e.internalName,
        cwd: e.cwd || null,
        agent: e.agent || null,
        how: e.how || 'ended',
        closedAt: e.closedAt,
        resumable: !!(e.records && (e.records.json || e.records.turn))
    }));
}

/** Which agent a snapshot's records say ran there, for the list. */
function agentOf(records) {
    let turn = null;
    try { turn = records && records.turn ? JSON.parse(String(records.turn)) : null; } catch (e) { turn = null; }
    if (turn && typeof turn.agent === 'string' && turn.agent) return turn.agent;
    if (records && (records.json || records.turn)) return 'claude';
    return null;
}

module.exports = { KEEP_MS, KEEP_MAX, RECORD_EXTS, emptyStore, normalizeStore, prune, noteClosures, dropReopened, listing, agentOf };
