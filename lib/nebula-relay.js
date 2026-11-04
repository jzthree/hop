'use strict';
// Nebula inside hop: /nebula/<port>/… relays to the Nebula server this
// machine reaches at localhost:<port> (typically an ssh tunnel to the
// cluster), so "Open in Nebula" can open the live notebook in hop itself.
// Nebula serves under any path prefix (its lib/basePath.ts), so nothing is
// rewritten in the page.
//
// The relay must not weaken Nebula's own sign-in. Nebula lets a token-less
// request from loopback WITHOUT an Origin header borrow the browser's saved
// session (that is its CLI/MCP piggyback), and every relayed request arrives
// from loopback. Browsers leave Origin off same-origin GETs, so a relay that
// passed headers through unchanged would sign every viewer in for free. So:
// every relayed request carries an Origin (hop's own, when the browser sent
// none) — Nebula then treats it as the browser it is, and asks for its own
// login. hop's cookies never reach Nebula; Nebula's token travels in its own
// Authorization header or ?token=, which pass through untouched.
//
// Only ports a Nebula link names (or the configured Nebula) are relayed:
// this is not a way to reach arbitrary local services.

const PATH_RE = /^\/nebula\/(\d{2,5})(\/.*)?$/;

/** { port, rest } for /nebula/<port>/<rest>, else null. rest keeps the query. */
function parseRelayPath(rawUrl) {
    const url = String(rawUrl || '');
    const q = url.indexOf('?');
    const pathname = q >= 0 ? url.slice(0, q) : url;
    const m = PATH_RE.exec(pathname);
    if (!m) return null;
    const port = Number(m[1]);
    if (!(port > 0 && port < 65536)) return null;
    return { port, rest: (m[2] || '') + (q >= 0 ? url.slice(q) : ''), needsSlash: !m[2] };
}

/** The port of a loopback Nebula address, else null. */
function loopbackPort(address) {
    try {
        const u = new URL(String(address));
        if (u.protocol !== 'http:') return null;
        if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
        return Number(u.port || 80);
    } catch (e) {
        return null;
    }
}

/** The ports the relay serves: the configured Nebula and any a link names. */
function allowedPorts(configuredUrl, linkTargets) {
    const ports = new Set();
    for (const t of [configuredUrl || 'http://localhost:3000', ...(linkTargets || [])]) {
        const p = loopbackPort(t);
        if (p) ports.add(p);
    }
    return ports;
}

/** A Nebula link's address, as the same page through the relay. */
function relayUrlFor(target) {
    const port = loopbackPort(target);
    if (!port) return null;
    const u = new URL(String(target));
    return `/nebula/${port}${u.pathname || '/'}${u.search}${u.hash}`;
}

const HOP_ONLY = ['cookie', 'x-hop-actor', 'x-hop-via', 'x-hop-client'];

/** The headers Nebula sees: hop's removed, an Origin always, the public host forwarded. */
function relayRequestHeaders(headers, { port, publicOrigin }) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
        const key = k.toLowerCase();
        if (HOP_ONLY.includes(key)) continue;
        out[key] = v;
    }
    // A hop device token is hop's; Nebula's own Bearer token passes through.
    if (typeof out.authorization === 'string' && /^Bearer\s+hs_/.test(out.authorization)) delete out.authorization;
    const pub = new URL(publicOrigin);
    out.origin = out.origin || pub.origin;
    out.host = `localhost:${port}`;
    // Nebula derives its passkey origin from these.
    out['x-forwarded-host'] = pub.host;
    out['x-forwarded-proto'] = pub.protocol.replace(':', '');
    delete out.referer;
    return out;
}

/** Response headers back to the browser: nothing that sets hop-origin cookies. */
function relayResponseHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
        const key = k.toLowerCase();
        if (key === 'set-cookie') continue;
        // Hop frames it (Views); a same-origin frame is all that is asked for.
        if (key === 'x-frame-options') continue;
        if (key === 'content-security-policy' && typeof v === 'string') {
            out[k] = v.replace(/frame-ancestors[^;]*;?/i, "frame-ancestors 'self';");
            continue;
        }
        out[k] = v;
    }
    return out;
}

/** A redirect inside Nebula stays inside the relay. */
function relayLocation(location, port) {
    if (typeof location !== 'string' || !location) return location;
    if (location.startsWith('/') && !location.startsWith('//')) return `/nebula/${port}${location}`;
    const lp = loopbackPort(location);
    if (lp === port) {
        const u = new URL(location);
        return `/nebula/${port}${u.pathname}${u.search}${u.hash}`;
    }
    return location;
}

module.exports = { parseRelayPath, loopbackPort, allowedPorts, relayUrlFor, relayRequestHeaders, relayResponseHeaders, relayLocation };
