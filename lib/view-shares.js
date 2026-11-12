'use strict';
// Shared views: a public link to one published view, for someone who has no
// way to sign in to this hop — a collaborator, a phone that isn't yours.
//
// The link is /shared/<token>, the token random and unguessable, and it names
// nothing: not the session, not the file. It lives in the view's own entry in
// its session's .meta.json (`share: { token, at }`), so every way a view goes
// away — `hop view --rm`, Delete in Views, --clear, the size budget, a
// forgotten session — takes its link with it, and re-publishing the same file
// keeps the link and shows the new copy. Only the person shares: an agent
// publishes, and its person decides who else sees it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

/** A fresh link token: 144 random bits, URL-safe. */
function newShareToken() {
    return crypto.randomBytes(18).toString('base64url');
}

/** The public address of a shared view. */
function shareUrl(base, token) {
    return `${String(base || '').replace(/\/+$/, '')}/shared/${token}`;
}

/**
 * Finds the view a token opens. The views folder is the truth: an index
 * (token → session, file) is only a shortcut, re-read when a token misses,
 * at most every `rescanMs`, and every hit is checked against the view's
 * current entry, so a link stops the moment its view or its share is gone.
 */
function createShareIndex({ viewsDir, readMeta, rescanMs = 2000, now = Date.now }) {
    let index = new Map();
    let scannedAt = -Infinity;
    const scan = () => {
        const next = new Map();
        let sessions = [];
        try { sessions = fs.readdirSync(viewsDir); } catch (e) { sessions = []; }
        for (const session of sessions) {
            if (session.startsWith('.') || session === 'manifest.json') continue;
            const meta = readMeta(session) || {};
            for (const [name, m] of Object.entries(meta)) {
                const token = m && m.share && m.share.token;
                if (typeof token === 'string' && TOKEN_RE.test(token)) next.set(token, { session, name });
            }
        }
        index = next;
        scannedAt = now();
    };
    const check = (token, at) => {
        if (!at) return null;
        const m = (readMeta(at.session) || {})[at.name];
        if (!m || !m.share || m.share.token !== token) return null;
        if (m.kind === 'server' || m.kind === 'link') return null;
        const file = path.join(viewsDir, at.session, at.name);
        try { if (!fs.statSync(file).isFile()) return null; } catch (e) { return null; }
        return { session: at.session, name: at.name, file, title: m.title || '', at: m.share.at || null };
    };
    return {
        find(token) {
            if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
            const hit = check(token, index.get(token));
            if (hit) return hit;
            if (now() - scannedAt < rescanMs) return null;
            scan();
            return check(token, index.get(token));
        },
        // After a share is made or stopped here: the next miss reads again.
        invalidate() { scannedAt = -Infinity; }
    };
}

/**
 * Turn sharing of one view on or off in its session's meta (mutated and
 * returned). Turning it on again keeps the existing link.
 */
function setShared(meta, name, on, at = Date.now()) {
    const m = { ...(meta[name] || {}) };
    if (on) {
        if (!m.share || !TOKEN_RE.test(String(m.share.token || ''))) m.share = { token: newShareToken(), at };
    } else {
        delete m.share;
    }
    meta[name] = m;
    return meta;
}

module.exports = { TOKEN_RE, newShareToken, shareUrl, createShareIndex, setShared };
