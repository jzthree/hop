const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rotateAuditFile, sweepStaleAuditDirs, AUDIT_FILE_NAME } = require('../lib/audit-rotation');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hop-audit-rot-'));

test('rotateAuditFile renames the live file aside and keeps only the newest N rotations', () => {
  const dir = tmpDir();
  const live = path.join(dir, AUDIT_FILE_NAME);
  const stamps = [];
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(live, `{"n":${i}}\n`);
    const now = Date.UTC(2026, 0, 1, 0, 0, i);
    const r = rotateAuditFile(live, { keep: 2, now });
    assert.ok(r.rotatedTo, 'live file rotated');
    stamps.push(path.basename(r.rotatedTo));
    // Rotated files get distinct mtimes so the prune order is deterministic.
    fs.utimesSync(r.rotatedTo, now / 1000, now / 1000);
  }
  assert.equal(fs.existsSync(live), false);
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 2, `two rotations kept, got ${left}`);
  assert.deepEqual(left, stamps.slice(-2).sort());
});

test('rotateAuditFile is a no-op on a missing or empty live file', () => {
  const dir = tmpDir();
  const live = path.join(dir, AUDIT_FILE_NAME);
  assert.equal(rotateAuditFile(live).rotatedTo, null);
  fs.writeFileSync(live, '');
  assert.equal(rotateAuditFile(live).rotatedTo, null);
  assert.ok(fs.existsSync(live));
});

test('sweepStaleAuditDirs removes old non-live session dirs and keeps live or recent ones', () => {
  const root = tmpDir();
  const mk = (name, ageMs, now) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    const f = path.join(d, AUDIT_FILE_NAME);
    fs.writeFileSync(f, '{}\n');
    const t = (now - ageMs) / 1000;
    fs.utimesSync(f, t, t);
    fs.utimesSync(d, t, t);
    return d;
  };
  const now = Date.now();
  const day = 86400000;
  const stale = mk('old-session', 120 * day, now);
  const liveButOld = mk('live-session', 120 * day, now);
  const recent = mk('recent-session', 2 * day, now);
  const r = sweepStaleAuditDirs([root], {
    retentionMs: 90 * day,
    isLive: (name) => name === 'live-session',
    now
  });
  assert.deepEqual(r.removed, [stale]);
  assert.equal(fs.existsSync(stale), false);
  assert.ok(fs.existsSync(liveButOld));
  assert.ok(fs.existsSync(recent));
  assert.equal(r.kept, 2);
});

test('sweepStaleAuditDirs does nothing when retention is disabled or the root is missing', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'x'));
  assert.deepEqual(sweepStaleAuditDirs([root], { retentionMs: 0 }).removed, []);
  assert.deepEqual(sweepStaleAuditDirs([path.join(root, 'nope')], { retentionMs: 1 }).removed, []);
  assert.ok(fs.existsSync(path.join(root, 'x')));
});
