// Size rotation and age-based retention for per-session audit logs.
//
// Each hop session writes `<logsDir>/<session>/audit.ndjson`: every keystroke
// and every byte of output, forever. Nothing ever trimmed it. A chatty agent
// session left running for weeks grows to gigabytes, and a session that
// ended a year ago still has its full transcript on disk. Two limits:
//
//   - SIZE: when the live file passes maxBytes it is renamed to
//     audit.ndjson.<utc-timestamp> and a fresh file starts; only the newest
//     `keep` rotated files survive.
//   - AGE: a session directory whose newest file is older than retentionMs,
//     and whose session is not live, is deleted whole.
//
// Pure functions over the filesystem so they can be unit-tested without the
// daemon.

const fs = require('fs');
const path = require('path');

const AUDIT_FILE_NAME = 'audit.ndjson';

function rotatedName(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${AUDIT_FILE_NAME}.${stamp}`;
}

/**
 * Rename the live audit file aside and prune old rotations.
 * Caller must have closed its write stream first.
 * @returns {{ rotatedTo: string|null, pruned: string[] }}
 */
function rotateAuditFile(filePath, { keep = 5, now = Date.now() } = {}) {
  const dir = path.dirname(filePath);
  let rotatedTo = null;
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      let target = path.join(dir, rotatedName(now));
      // Two rotations inside one second: keep both.
      let n = 1;
      while (fs.existsSync(target)) target = path.join(dir, `${rotatedName(now)}.${n++}`);
      fs.renameSync(filePath, target);
      rotatedTo = target;
    }
  } catch (e) {
    return { rotatedTo: null, pruned: [] };
  }
  const pruned = [];
  try {
    const rotated = fs.readdirSync(dir)
      .filter((name) => name.startsWith(`${AUDIT_FILE_NAME}.`))
      .map((name) => {
        const full = path.join(dir, name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (e) { }
        return { full, mtime, name };
      })
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    for (const extra of rotated.slice(Math.max(0, keep))) {
      try { fs.unlinkSync(extra.full); pruned.push(extra.full); } catch (e) { }
    }
  } catch (e) { }
  return { rotatedTo, pruned };
}

function newestMtime(dir) {
  let newest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch (e) { }
    }
    if (newest === 0) newest = fs.statSync(dir).mtimeMs;
  } catch (e) { }
  return newest;
}

/**
 * Delete per-session log directories that are stale.
 * @param {string[]} logsRoots directories whose children are per-session dirs
 * @param {object} options
 * @param {number} options.retentionMs age after which a non-live dir goes
 * @param {(sessionName: string) => boolean} options.isLive
 * @param {number} [options.now]
 * @returns {{ removed: string[], kept: number }}
 */
function sweepStaleAuditDirs(logsRoots, { retentionMs, isLive = () => false, now = Date.now() } = {}) {
  const removed = [];
  let kept = 0;
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) return { removed, kept };
  for (const root of logsRoots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionName = entry.name;
      const dir = path.join(root, sessionName);
      if (isLive(sessionName)) { kept++; continue; }
      const age = now - newestMtime(dir);
      if (age < retentionMs) { kept++; continue; }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch (e) {
        kept++;
      }
    }
  }
  return { removed, kept };
}

module.exports = { rotateAuditFile, sweepStaleAuditDirs, rotatedName, AUDIT_FILE_NAME };
