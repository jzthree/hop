'use strict';
// What moving a session's conversation to another account folder needs:
//
//  - the copy as the session last wrote it. A conversation file only grows,
//    so the largest copy is the most complete one; a copy left in the target
//    by an earlier stay there is older and is replaced (it used to be kept,
//    and a session moved back would have resumed where it was days before).
//  - for Codex, every conversation it was forked from: `codex resume` reads
//    the whole fork lineage ("invalid paginated history lineage … missing
//    source rollout" otherwise), and older ones are kept compressed
//    (rollout-….jsonl.zst).
//  - for Codex, the thread's goal, kept in the account folder's database.
//  - for Codex, the trust the person gave hop's own hook in the default
//    folder, so the moved session does not stop at "Hooks need review".
//
// Plain file work; the daemon finds the files and runs the agent.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const sizeOf = (f) => { try { return fs.statSync(f).size; } catch (e) { return -1; } };

/** The most complete of several copies of one conversation file (null for none). */
function newestCopy(files) {
    let best = null, bestSize = -1;
    for (const f of files || []) {
        if (!f) continue;
        // A live rollout is plain .jsonl; a compressed one was put away.
        const s = sizeOf(f);
        if (s < 0) continue;
        const plain = !f.endsWith('.zst');
        const bestPlain = best ? !best.endsWith('.zst') : false;
        if (!best || (plain && !bestPlain) || (plain === bestPlain && s > bestSize)) { best = f; bestSize = s; }
    }
    return best;
}

/**
 * Put `src` at `dest` unless `dest` already holds as much. Written beside it
 * and renamed into place, so a reader never sees half a file. Returns
 * 'copied', 'replaced' or 'kept'.
 */
function copyIfNewer(src, dest) {
    if (path.resolve(src) === path.resolve(dest)) return 'kept';
    const had = sizeOf(dest);
    if (had >= 0 && had >= sizeOf(src)) return 'kept';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.hop-copy-${process.pid}`;
    // A clone where the disk can make one (APFS): instant, and no extra space
    // for a conversation that runs to a gigabyte.
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_FICLONE);
    try { fs.chmodSync(tmp, fs.statSync(src).mode & 0o777); } catch (e) { /* the copy's own mode is fine */ }
    fs.renameSync(tmp, dest);
    return had >= 0 ? 'replaced' : 'copied';
}

/** A rollout's first line (its session_meta payload), plain or .zst, read without loading the file. */
function readRolloutMeta(file) {
    return new Promise((resolve) => {
        let text = '';
        let done = false;
        const finish = (v) => { if (done) return; done = true; try { src.destroy(); } catch (e) { /* closed */ } resolve(v); };
        const parse = () => {
            const i = text.indexOf('\n');
            const line = i >= 0 ? text.slice(0, i) : text;
            try { const j = JSON.parse(line); return j && j.type === 'session_meta' ? (j.payload || null) : null; } catch (e) { return null; }
        };
        let src;
        try { src = fs.createReadStream(file); } catch (e) { resolve(null); return; }
        let stream = src;
        if (file.endsWith('.zst')) {
            if (typeof zlib.createZstdDecompress !== 'function') { resolve(null); return; }
            stream = src.pipe(zlib.createZstdDecompress());
            stream.on('error', () => finish(null));
        }
        src.on('error', () => finish(null));
        stream.on('data', (chunk) => {
            text += chunk.toString('utf8');
            if (text.includes('\n') || text.length > 4 * 1024 * 1024) finish(parse());
        });
        stream.on('end', () => finish(parse()));
    });
}

/**
 * Everything else `codex resume` reads for a thread, as [{ id, file }]: the
 * conversations it was forked from, nearest first, and each one's history
 * segments — a long conversation continues in further files named
 * rollout-…-<thread>_<segment>.jsonl(.zst), and the resume refused a move
 * without them ("invalid paginated history lineage for <segment>: missing
 * source rollout"). `findCopies(id)` lists a thread's own rollout files in
 * every folder; `findSegments(id)` its segment files. Stops at a thread it
 * cannot find (file: null — the caller says so).
 */
async function codexForkLineage(rootFile, findCopies, findSegments = () => [], maxDepth = 32) {
    const out = [];
    const seen = new Set();
    // Each segment once, at its most complete copy.
    const segmentsOf = (id) => {
        const byName = new Map();
        for (const f of findSegments(id) || []) {
            const k = path.basename(f);
            byName.set(k, [...(byName.get(k) || []), f]);
        }
        for (const [k, files] of byName) out.push({ id: k.replace(/^rollout-[^_]*?-([0-9a-f-]{36}_)/, '$1').replace(/\.jsonl(\.zst)?$/, ''), file: newestCopy(files) });
    };
    let meta = await readRolloutMeta(rootFile);
    if (meta && meta.id) { seen.add(meta.id); segmentsOf(meta.id); }
    for (let i = 0; i < maxDepth; i++) {
        const id = meta && typeof meta.forked_from_id === 'string' ? meta.forked_from_id : null;
        if (!id || seen.has(id)) break;
        seen.add(id);
        const file = newestCopy(findCopies(id));
        out.push({ id, file });
        if (!file) break;
        segmentsOf(id);
        meta = await readRolloutMeta(file);
    }
    return out;
}

// ---- Codex goals ------------------------------------------------------------
// A thread's goal ("Pursuing goal", /goal) lives in the account folder's
// goals_1.sqlite, not in the conversation: a session moved without it
// resumed with its goal gone. Codex restores the goal on resume from the
// folder it runs in, so the row goes along — unless the target holds as
// recent a one.

/** Copy a thread's goal (and its deferral mark) between two goals_1.sqlite files: 'copied', 'replaced', 'kept' or 'none'. */
function copyCodexGoal(fromFile, toFile, threadId) {
    if (!threadId || !fs.existsSync(fromFile)) return 'none';
    if (!fs.existsSync(toFile)) return 'no-target';
    const { DatabaseSync } = require('node:sqlite');
    const src = new DatabaseSync(fromFile, { readOnly: true });
    try {
        src.exec('PRAGMA busy_timeout = 3000');
        const row = src.prepare('SELECT * FROM thread_goals WHERE thread_id = ?').get(threadId);
        if (!row) return 'none';
        const deferred = !!src.prepare('SELECT 1 AS x FROM thread_goal_continuation_deferrals WHERE thread_id = ?').get(threadId);
        const dst = new DatabaseSync(toFile);
        try {
            dst.exec('PRAGMA busy_timeout = 5000');
            const have = dst.prepare('SELECT updated_at_ms FROM thread_goals WHERE thread_id = ?').get(threadId);
            if (have && Number(have.updated_at_ms) >= Number(row.updated_at_ms)) return 'kept';
            const cols = Object.keys(row).filter((c) => /^[a-z_]+$/.test(c));
            dst.exec('BEGIN IMMEDIATE');
            try {
                dst.prepare(`INSERT OR REPLACE INTO thread_goals (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
                dst.prepare('DELETE FROM thread_goal_continuation_deferrals WHERE thread_id = ?').run(threadId);
                if (deferred) dst.prepare('INSERT INTO thread_goal_continuation_deferrals (thread_id) VALUES (?)').run(threadId);
                dst.exec('COMMIT');
            } catch (e) { try { dst.exec('ROLLBACK'); } catch (e2) { /* none open */ } throw e; }
            return have ? 'replaced' : 'copied';
        } finally { dst.close(); }
    } finally { src.close(); }
}

/** A thread's goal status in a goals_1.sqlite ('active', 'usage_limited', …), or null. */
function codexGoalStatus(goalsFile, threadId) {
    if (!threadId || !fs.existsSync(goalsFile)) return null;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(goalsFile, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout = 2000');
        const row = db.prepare('SELECT status FROM thread_goals WHERE thread_id = ?').get(threadId);
        return row && typeof row.status === 'string' ? row.status : null;
    } finally { db.close(); }
}

// ---- Codex hook trust -------------------------------------------------------
// config.toml keeps, per hook, the hash the person trusted, keyed by the
// hooks.json path:
//   [hooks.state."/Users/x/.codex/hooks.json:permission_request:0:0"]
//   trusted_hash = "sha256:…"
// An account folder made from the default has the same hooks.json under its
// own path, so none of those keys match it.

const TRUST_RE = /^\[hooks\.state\."((?:[^"\\]|\\.)+)"\]\s*\n\s*trusted_hash\s*=\s*"([^"]+)"/gm;

/** { key → hash } of the trusted hooks in a config.toml's text. */
function trustedHooks(configText) {
    const out = new Map();
    for (const m of String(configText || '').matchAll(TRUST_RE)) out.set(m[1], m[2]);
    return out;
}

/**
 * The trust entries a folder's config.toml lacks, as TOML to append: each
 * hook the default folder trusts, re-keyed to the folder's own hooks.json —
 * only when that file is the default's byte for byte, so the same hooks and
 * nothing else are trusted. '' when there is nothing to add.
 */
function missingHookTrust({ defaultDir, dir, defaultConfig, config, defaultHooks, hooks }) {
    if (!defaultHooks || !hooks || !Buffer.from(defaultHooks).equals(Buffer.from(hooks))) return '';
    const from = path.join(defaultDir, 'hooks.json');
    const to = path.join(dir, 'hooks.json');
    const have = trustedHooks(config);
    let add = '';
    for (const [key, hash] of trustedHooks(defaultConfig)) {
        if (!key.startsWith(`${from}:`)) continue;
        const mine = to + key.slice(from.length);
        if (have.get(mine) === hash) continue;
        if (have.has(mine)) continue; // the person decided otherwise there
        add += `\n[hooks.state."${mine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]\ntrusted_hash = "${hash}"\n`;
    }
    return add;
}

/** Give a Codex account folder the default's trust of the same hooks. Returns how many were added. */
function ensureCodexHookTrust(defaultDir, dir) {
    if (!dir || path.resolve(dir) === path.resolve(defaultDir)) return 0;
    const read = (f) => { try { return fs.readFileSync(f); } catch (e) { return null; } };
    const configFile = path.join(dir, 'config.toml');
    const defaultConfig = read(path.join(defaultDir, 'config.toml'));
    const config = read(configFile);
    if (!defaultConfig || config === null) return 0;
    const add = missingHookTrust({
        defaultDir, dir,
        defaultConfig: defaultConfig.toString('utf8'), config: config.toString('utf8'),
        defaultHooks: read(path.join(defaultDir, 'hooks.json')), hooks: read(path.join(dir, 'hooks.json'))
    });
    if (!add) return 0;
    const text = config.toString('utf8');
    fs.appendFileSync(configFile, (text.endsWith('\n') ? '' : '\n') + add);
    return (add.match(/trusted_hash/g) || []).length;
}

module.exports = { newestCopy, copyIfNewer, readRolloutMeta, codexForkLineage, copyCodexGoal, codexGoalStatus, trustedHooks, missingHookTrust, ensureCodexHookTrust };
