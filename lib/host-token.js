'use strict';
// The key to the terminal host (scripts/hay-host.js).
//
// The host runs every terminal, and anything that can talk to it can read
// their screens, type into them, end them, or start a new terminal running
// any command. It listens on 127.0.0.1 — which every user of a shared
// machine can reach, and so can a web page in a browser that finds the port.
// So the host answers only a request that carries this key, and the key
// lives in hop's private folder (~/.hop2 is 0700, the file 0600): only this
// account can read it.
//
// The key travels in a header, never in a URL: URLs end up in logs and in
// command lines (`ps` shows those to every user on Linux), and a browser
// cannot set a custom header on a cross-site request or a WebSocket.
//
// One persistent key, not one per start: the host deliberately outlives the
// daemon, and a restarted daemon must still be able to talk to it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOST_TOKEN_HEADER = 'x-hop-host-token';
const HOST_TOKEN_FILE = '.host-token';
const VALID = /^[A-Za-z0-9_-]{32,128}$/;

function hostTokenPath(hopHome) {
    return path.join(hopHome, HOST_TOKEN_FILE);
}

function readHostToken(hopHome) {
    try {
        const t = fs.readFileSync(hostTokenPath(hopHome), 'utf8').trim();
        return VALID.test(t) ? t : null;
    } catch (e) {
        return null;
    }
}

/**
 * The key, made on first use. The daemon and the host may both get here
 * first: the key is written whole to a private temp file and LINKED into
 * place, which fails if another process already did — so nobody ever reads
 * a half-written key, and both end up with the same one.
 */
function hostToken(hopHome) {
    const existing = readHostToken(hopHome);
    if (existing) return existing;
    fs.mkdirSync(hopHome, { recursive: true, mode: 0o700 });
    const file = hostTokenPath(hopHome);
    const fresh = crypto.randomBytes(32).toString('base64url');
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, fresh, { mode: 0o600 });
    try {
        fs.linkSync(tmp, file);
        return fresh;
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const winner = readHostToken(hopHome);
        if (winner) return winner;
        // A file that is there but is not a key (emptied, edited): replace it.
        fs.renameSync(tmp, file);
        return fresh;
    } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* linked or renamed */ }
    }
}

/** Does this request carry the key? Constant-time. */
function requestHasHostToken(headers, token) {
    const got = headers && headers[HOST_TOKEN_HEADER];
    if (typeof got !== 'string' || !token) return false;
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { HOST_TOKEN_HEADER, hostToken, readHostToken, hostTokenPath, requestHasHostToken };
