// Per-device login sessions for the hop daemon.
//
// Before this module every browser, phone and script that ever logged in
// held the same credential: the daemon's process-wide session secret, minted
// straight into the cookie. One value for every device meant nothing could
// be revoked short of rotating the secret and logging everyone out.
//
// Now each successful login (TOTP, password+TOTP, passkey) mints its own
// random token. Only a SHA-256 hash is stored, so the state file cannot be
// replayed if it leaks; the raw token lives in the client's cookie (or, for
// device tokens minted from the CLI, wherever the operator pastes it). Each
// session carries a label, how it was created, and an expiry — 30 days by
// default, so a phone that logs in once a month stays signed in — and any
// session can be listed and revoked on its own.
//
// The daemon's own secret is still accepted as a Bearer token for local
// hop-to-hop IPC (CLI, MCP, hay). It is never a cookie any more.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'hs_';
const ID_PREFIX = 'as_';
// How often verify() persists lastSeenAt. Every request would turn each
// keystroke's WebSocket poll into a disk write.
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function isSessionToken(value) {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX) && value.length >= 40 && value.length <= 128;
}

function timingSafeEqualHex(a, b) {
  const ab = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

class AuthSessionStore {
  /**
   * @param {string} filePath JSON state file (written 0600)
   * @param {object} [options]
   * @param {number} [options.ttlMs] default lifetime for new sessions
   * @param {() => number} [options.now] clock, for tests
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this._cache = null;
  }

  _load() {
    if (this._cache) return this._cache;
    let sessions = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(parsed?.sessions)) {
        sessions = parsed.sessions.filter((s) => s && typeof s.id === 'string' && typeof s.tokenHash === 'string');
      }
    } catch (e) {
      sessions = [];
    }
    this._cache = { sessions };
    return this._cache;
  }

  _save() {
    const state = this._load();
    const dir = path.dirname(this.filePath);
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { }
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: state.sessions }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch (e) { }
  }

  /** Drop expired sessions. Returns how many were removed. */
  prune({ save = true } = {}) {
    const state = this._load();
    const now = this.now();
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((s) => !(Number.isFinite(s.expiresAt) && s.expiresAt <= now));
    const removed = before - state.sessions.length;
    if (removed > 0 && save) this._save();
    return removed;
  }

  /**
   * Mint a new session. The raw token is returned exactly once.
   * @param {object} [meta] { label, via, ip, userAgent, ttlMs }
   */
  create(meta = {}) {
    const state = this._load();
    this.prune({ save: false });
    const now = this.now();
    const ttl = Number.isFinite(meta.ttlMs) && meta.ttlMs > 0 ? meta.ttlMs : this.ttlMs;
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const session = {
      id: ID_PREFIX + crypto.randomBytes(6).toString('hex'),
      tokenHash: hashToken(token),
      label: String(meta.label || '').slice(0, 80) || null,
      via: String(meta.via || 'unknown').slice(0, 32),
      ip: meta.ip ? String(meta.ip).slice(0, 64) : null,
      userAgent: meta.userAgent ? String(meta.userAgent).slice(0, 200) : null,
      createdAt: now,
      lastSeenAt: now,
      // null = never expires (device tokens for automation, created explicitly).
      expiresAt: meta.noExpiry === true ? null : now + ttl
    };
    state.sessions.push(session);
    this._save();
    return { id: session.id, token, expiresAt: session.expiresAt };
  }

  /**
   * Look a raw token up. Returns the public view of the session or null.
   * Refreshes lastSeenAt (persisted at most every few minutes).
   */
  verify(token) {
    if (!isSessionToken(token)) return null;
    const state = this._load();
    const hash = hashToken(token);
    const now = this.now();
    for (const s of state.sessions) {
      if (!timingSafeEqualHex(s.tokenHash, hash)) continue;
      if (Number.isFinite(s.expiresAt) && s.expiresAt <= now) {
        this.prune();
        return null;
      }
      if (!Number.isFinite(s.lastSeenAt) || now - s.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
        s.lastSeenAt = now;
        try { this._save(); } catch (e) { }
      }
      return this._public(s);
    }
    return null;
  }

  /** Revoke one session by id. */
  revoke(id) {
    const state = this._load();
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((s) => s.id !== String(id));
    const removed = before - state.sessions.length;
    if (removed > 0) this._save();
    return removed > 0;
  }

  /** Revoke every session, optionally keeping one (the caller's own). */
  revokeAll({ exceptId = null } = {}) {
    const state = this._load();
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((s) => exceptId && s.id === exceptId);
    const removed = before - state.sessions.length;
    if (removed > 0) this._save();
    return removed;
  }

  /** Every live session, newest first, without token material. */
  list() {
    this.prune();
    return this._load().sessions
      .map((s) => this._public(s))
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  }

  _public(s) {
    return {
      id: s.id,
      label: s.label,
      via: s.via,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt
    };
  }
}

module.exports = {
  AuthSessionStore,
  hashToken,
  isSessionToken,
  DEFAULT_TTL_MS,
  TOKEN_PREFIX
};
