'use strict';
// The briefing's read witness: which stories the human has actually seen,
// at what strength, across every device. Clients report; the daemon keeps
// the union; the generator decides, per thread, whether the next edition
// may tell a delta or must retell cold.
//
//   glimpsed  the item was on screen (≥60% visible, tab visible, window
//             focused, user active) for ≥1.5s
//   read      on screen for the text's reading time (200 wpm), or expanded
//   acted     opened into the session, or replied to, from the briefing
//
// A card rendering is none of these; a background tab is none of these.

const LEVELS = ['glimpsed', 'read', 'acted'];
const rank = (l) => LEVELS.indexOf(l);

const GLIMPSE_MS = 1500;
const WPM = 200;

/** The level a dwell earns for a text of `words` words. null = not yet. */
function levelForDwell(dwellMs, words) {
    if (dwellMs < GLIMPSE_MS) return null;
    const readMs = Math.max(GLIMPSE_MS, Math.round((Number(words) || 0) / WPM * 60_000));
    return dwellMs >= readMs ? 'read' : 'glimpsed';
}

const key = (edition, item) => `${edition}|${item}`;

/**
 * Fold reported reads into the store: the strongest level per (edition,
 * item) wins; the first and latest sighting are kept. Reports with an
 * unknown level, or missing fields, are ignored. Returns how many changed.
 */
function mergeReads(store, reads, now = Date.now()) {
    if (!store.reads) store.reads = {};
    let changed = 0;
    for (const r of reads || []) {
        if (!r || typeof r.edition !== 'string' || typeof r.item !== 'string' || !LEVELS.includes(r.level)) continue;
        const at = Number.isFinite(r.at) ? r.at : now;
        const k = key(r.edition, r.item);
        const cur = store.reads[k];
        if (!cur) { store.reads[k] = { edition: r.edition, item: r.item, level: r.level, firstAt: at, lastAt: at }; changed++; continue; }
        let touched = false;
        if (rank(r.level) > rank(cur.level)) { cur.level = r.level; touched = true; }
        if (at > cur.lastAt) { cur.lastAt = at; touched = true; }
        if (at < cur.firstAt) { cur.firstAt = at; touched = true; }
        if (touched) changed++;
    }
    return changed;
}

/** The read record for one story. */
function readOf(store, edition, item) {
    return (store && store.reads && store.reads[key(edition, item)]) || null;
}

/** Editions with any story read at any level — the "new" badge's truth. */
function editionsSeen(store) {
    const out = new Set();
    for (const r of Object.values((store && store.reads) || {})) out.add(r.edition);
    return out;
}

/**
 * For the generator: per session, the most recent edition that told a story
 * about it and how that story was received. `editions` newest first, each
 * {generated_at, items:[{session}]}. Returns a map session -> {edition,
 * level ('unread' when never seen), at}.
 */
function readStateBySession(store, editions) {
    const out = {};
    for (const e of editions || []) {
        const stamp = e && e.generated_at;
        if (!stamp) continue;
        for (const it of e.items || []) {
            const s = it && it.session;
            if (!s || out[s]) continue; // newest telling wins
            const r = readOf(store, stamp, s);
            out[s] = { edition: stamp, level: r ? r.level : 'unread', at: r ? r.lastAt : null };
        }
    }
    return out;
}

/** Drop records older than `maxAgeMs` (editions that old are off every page). */
function pruneReads(store, now = Date.now(), maxAgeMs = 30 * 86_400_000) {
    if (!store.reads) return 0;
    let n = 0;
    for (const [k, r] of Object.entries(store.reads)) {
        if (now - (r.lastAt || 0) > maxAgeMs) { delete store.reads[k]; n++; }
    }
    return n;
}

module.exports = { LEVELS, GLIMPSE_MS, WPM, levelForDwell, mergeReads, readOf, editionsSeen, readStateBySession, pruneReads };
