'use strict';
// hop's own copy of the Antigravity conversations its sessions run.
//
// agy (1.5.x) keeps only about its 500 newest conversations and deletes the
// rest, open ones included, and every `agy -p` counts as one. On
// 2026-11-20 a batch of `agy -p` judge runs (about ten a minute) deleted the
// conversations of every long-running agy session within an hour of their
// starting: resuming them found nothing ("Conversation … not found,
// ignoring --conversation flag") and started blank. Claude Code and Codex
// keep their transcripts; agy needs keeping for it.
//
// What a conversation is, on disk (agy 1.5.13):
//   conversations/<id>.db   the conversation itself (SQLite, with -wal/-shm)
//   brain/<id>/             its artifacts and transcript logs
// Both are copied to <archive>/<id>/ — the database through SQLite's own
// backup (consistent while agy writes), the folder as files — and put back
// when agy has lost them, before a resume.

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SQLITE = '/usr/bin/sqlite3';

const live = (dataDir, id) => ({
    db: path.join(dataDir, 'conversations', `${id}.db`),
    brain: path.join(dataDir, 'brain', id)
});
const kept = (archiveRoot, id) => ({
    dir: path.join(archiveRoot, id),
    db: path.join(archiveRoot, id, `${id}.db`),
    brain: path.join(archiveRoot, id, 'brain'),
    stamp: path.join(archiveRoot, id, 'archived.json')
});

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } };
/** Newest change to a conversation: its database, its write-ahead log, its transcript. */
function changedAt(dataDir, id) {
    const l = live(dataDir, id);
    return Math.max(mtime(l.db), mtime(`${l.db}-wal`), mtime(path.join(l.brain, '.system_generated', 'logs', 'transcript_full.jsonl')), mtime(l.brain));
}
function readStamp(archiveRoot, id) {
    try { return JSON.parse(fs.readFileSync(kept(archiveRoot, id).stamp, 'utf8')); } catch (e) { return null; }
}

/** Is there anything of this conversation for agy to open? */
function isLive(dataDir, id) {
    const l = live(dataDir, id);
    return fs.existsSync(l.db);
}
/** Does hop hold a copy? */
function hasCopy(archiveRoot, id) {
    return ID_RE.test(id) && fs.existsSync(kept(archiveRoot, id).db);
}

const run = (file, args, timeoutMs) => new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err) => resolve(!err));
});

/**
 * Copy one conversation into the archive when it changed since the last
 * copy. → 'copied' | 'unchanged' | 'missing' | 'failed'. Asynchronous and
 * written aside first, so a copy cut short never replaces a good one.
 */
async function archiveConversation({ dataDir, archiveRoot, id, now = Date.now(), sqlite = SQLITE }) {
    if (!ID_RE.test(id)) return 'failed';
    const l = live(dataDir, id);
    if (!fs.existsSync(l.db)) return 'missing';
    const k = kept(archiveRoot, id);
    const changed = changedAt(dataDir, id);
    const stamp = readStamp(archiveRoot, id);
    if (stamp && stamp.changedAt >= changed && fs.existsSync(k.db)) return 'unchanged';
    const tmp = `${k.dir}.part-${process.pid}`;
    try {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
        if (!await run(sqlite, [l.db, `.backup '${path.join(tmp, `${id}.db`).replace(/'/g, "''")}'`], 120_000)) throw new Error('sqlite backup failed');
        if (fs.existsSync(l.brain) && !await run('/bin/cp', ['-R', l.brain, path.join(tmp, 'brain')], 120_000)) throw new Error('copying the brain folder failed');
        fs.writeFileSync(path.join(tmp, 'archived.json'), JSON.stringify({ id, at: now, changedAt: changed }) + '\n', { mode: 0o600 });
        fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
        const old = `${k.dir}.old-${process.pid}`;
        if (fs.existsSync(k.dir)) fs.renameSync(k.dir, old);
        fs.renameSync(tmp, k.dir);
        fs.rmSync(old, { recursive: true, force: true });
        return 'copied';
    } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return 'failed';
    }
}

/**
 * Put a conversation agy lost back where agy looks, from hop's copy.
 * Synchronous (a resume waits on it). Never overwrites a live conversation.
 * → true when it is there now.
 */
function restoreConversation({ dataDir, archiveRoot, id }) {
    if (isLive(dataDir, id)) return true;
    if (!hasCopy(archiveRoot, id)) return false;
    const l = live(dataDir, id);
    const k = kept(archiveRoot, id);
    try {
        fs.mkdirSync(path.dirname(l.db), { recursive: true });
        // A clone where the disk makes one: a conversation runs to tens of MB,
        // and one deleted again is put back again.
        fs.copyFileSync(k.db, `${l.db}.restoring`, fs.constants.COPYFILE_FICLONE);
        fs.renameSync(`${l.db}.restoring`, l.db);
        if (fs.existsSync(k.brain)) {
            // A folder agy re-created since holds only its own few steps:
            // kept beside the copy, never thrown away.
            if (fs.existsSync(l.brain)) fs.renameSync(l.brain, `${l.brain}.before-restore-${Date.now()}`);
            execFileSync('/bin/cp', ['-R', k.brain, l.brain], { timeout: 120_000 });
        }
        return fs.existsSync(l.db);
    } catch (e) { return false; }
}

/** Copies of conversations no session has named for `keepMs`: the ones to let go. */
function staleCopies(archiveRoot, wanted, now = Date.now(), keepMs = 30 * 86400_000) {
    let names = [];
    try { names = fs.readdirSync(archiveRoot); } catch (e) { return []; }
    return names.filter((id) => ID_RE.test(id) && !wanted.has(id) && now - (readStamp(archiveRoot, id)?.at || 0) > keepMs);
}

module.exports = { archiveConversation, restoreConversation, hasCopy, isLive, changedAt, staleCopies, ID_RE };
