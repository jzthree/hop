'use strict';
// A second copy of what only the durable session metas know — the user's
// own filing (folder), name and origin per session — written on every
// daemon start and stop and hourly in between, so losing the metas (the
// 2026-09-26 `stop --all` deleted all 34 live sessions' records; a
// thermal-sleep crash before that lost three days of them) no longer means
// losing the folders too. `hop restore` re-files a session from the newest
// snapshot when its meta has forgotten which folder it was in.
//
// Pure: the daemon supplies the metas, folders and clock, and applies the
// plan. The one subtlety is the difference between "unfiled on purpose"
// and "forgot": the move endpoint now records an unfiling as an explicit
// `folderId: null`, so a meta with NO folderId key is the one that may have
// lost it. Metas older than that change have no key either way, which is
// why a session is only re-filed when a snapshot actually remembers a
// folder for it.

const KEEP = 24;

/** The identity worth a second copy, per session. */
function snapshotFromMetas(metas, folders, { at, reason } = {}) {
    const sessions = {};
    for (const m of metas || []) {
        if (!m || !m.internalName) continue;
        sessions[m.internalName] = {
            displayName: m.displayName || undefined,
            folderId: m.folderId || null,
            createdBy: m.createdBy || undefined,
            cwd: m.cwd || undefined,
            parked: m.parked === true || undefined,
            archived: m.archived === true || undefined
        };
    }
    return {
        at: at || new Date().toISOString(),
        reason: reason || '',
        folders: folders || {},
        sessions
    };
}

/**
 * Which sessions to re-file, given the current metas and the newest
 * snapshot: those whose meta has no folderId key at all (never filed, or
 * lost) but which the snapshot remembers in a folder that still exists.
 * A meta that says `folderId: null` was unfiled on purpose and is left
 * alone; one that already names a folder is not second-guessed.
 */
function planRefiles(metas, snapshot, folders) {
    if (!snapshot || !snapshot.sessions) return [];
    const out = [];
    for (const m of metas || []) {
        if (!m || !m.internalName) continue;
        if (Object.prototype.hasOwnProperty.call(m, 'folderId')) continue;
        const remembered = snapshot.sessions[m.internalName];
        const folderId = remembered && remembered.folderId;
        if (!folderId) continue;
        if (!folders || !folders[folderId]) continue;
        out.push({ internalName: m.internalName, folderId, displayName: m.displayName || remembered.displayName || m.internalName });
    }
    return out;
}

/** Snapshot file names sort by time; keep the newest KEEP. */
function pruneList(names, keep = KEEP) {
    const mine = (names || []).filter((n) => /^identity-.*\.json$/.test(n)).sort();
    return mine.slice(0, Math.max(0, mine.length - keep));
}

function snapshotFileName(at) {
    return `identity-${String(at || new Date().toISOString()).replace(/[:.]/g, '-')}.json`;
}

module.exports = { snapshotFromMetas, planRefiles, pruneList, snapshotFileName, KEEP };
