// Cloudflare Access (Zero Trust) token verification.
//
// When Access sits in front of a hostname, every request Cloudflare forwards
// to the origin carries a signed JWT in the `Cf-Access-Jwt-Assertion` header
// (and a `CF_Authorization` cookie). The JWT names the authenticated user's
// email. Trusting the header ALONE is unsafe — anyone who can reach the
// origin directly could forge it — so this module VERIFIES the token:
// RS256 signature against the team's published keys, issuer, expiry, and
// (when configured) the application audience. Only then is the email
// believed. No dependencies: Node's crypto verifies RS256 from a JWK, and
// the keys are fetched over https.
//
// The identity gate and the credential handover both lean on this: a claim
// is served to the email the token proves, never to a typed-in address.

const crypto = require('crypto');
const https = require('https');

const JWKS_TTL_MS = 60 * 60 * 1000; // keys rotate slowly; an hour is safe
const jwksCache = new Map(); // teamDomain -> { at, keys: Map<kid, KeyObject> }

/** `acme` or `acme.cloudflareaccess.com` -> `https://acme.cloudflareaccess.com`. */
function teamBaseUrl(team) {
  const t = String(team || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!t) return null;
  const host = t.includes('.') ? t : `${t}.cloudflareaccess.com`;
  return `https://${host}`;
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`certs endpoint returned ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('certs endpoint returned non-JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('certs request timed out')); });
    req.on('error', reject);
  });
}

const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlJson = (s) => JSON.parse(b64urlToBuf(s).toString('utf8'));

/**
 * The team's signing keys as {kid -> KeyObject}, cached. `fetchImpl` is
 * injectable for tests; production uses the https fetch above.
 */
async function getSigningKeys(teamDomain, { fetchImpl = fetchJson, nowMs = Date.now() } = {}) {
  const base = teamBaseUrl(teamDomain);
  if (!base) throw new Error('no Access team configured');
  const cached = jwksCache.get(base);
  if (cached && nowMs - cached.at < JWKS_TTL_MS) return cached.keys;
  const jwks = await fetchImpl(`${base}/cdn-cgi/access/certs`);
  const keys = new Map();
  for (const jwk of (jwks && Array.isArray(jwks.keys) ? jwks.keys : [])) {
    if (!jwk || jwk.kty !== 'RSA' || !jwk.kid) continue;
    try {
      keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch (e) { /* skip a malformed key rather than fail the set */ }
  }
  if (keys.size === 0) throw new Error('no usable RSA keys at the certs endpoint');
  jwksCache.set(base, { at: nowMs, keys });
  return keys;
}

/**
 * Verify a Cloudflare Access JWT. Returns { ok, email, claims } on success or
 * { ok: false, error } otherwise.
 *
 * @param token      the raw Cf-Access-Jwt-Assertion value
 * @param teamDomain your team ("acme" or "acme.cloudflareaccess.com")
 * @param audience   optional Access application AUD tag; when given the token
 *                   MUST carry it — this pins the token to YOUR app, so a
 *                   token minted for a different app in the same team is
 *                   refused. Strongly recommended.
 */
async function verifyAccessJwt(token, { teamDomain, audience = null, fetchImpl = fetchJson, nowMs = Date.now(), clockSkewMs = 60_000 } = {}) {
  try {
    const raw = String(token || '').trim();
    if (!raw) return { ok: false, error: 'no Access token on the request' };
    const parts = raw.split('.');
    if (parts.length !== 3) return { ok: false, error: 'malformed Access token' };
    const [h, p, s] = parts;

    let header;
    try { header = b64urlJson(h); } catch (e) { return { ok: false, error: 'unreadable token header' }; }
    if (header.alg !== 'RS256') return { ok: false, error: `unexpected token algorithm ${header.alg}` };
    if (!header.kid) return { ok: false, error: 'token names no key' };

    const keys = await getSigningKeys(teamDomain, { fetchImpl, nowMs });
    const key = keys.get(header.kid);
    if (!key) return { ok: false, error: 'token signed by an unknown key' };

    // Verify the signature over the exact base64url header.payload bytes.
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      key,
      b64urlToBuf(s)
    );
    if (!ok) return { ok: false, error: 'token signature is invalid' };

    let claims;
    try { claims = b64urlJson(p); } catch (e) { return { ok: false, error: 'unreadable token body' }; }

    // Expiry / not-before, with a little skew tolerance.
    const nowS = Math.floor(nowMs / 1000);
    const skewS = Math.ceil(clockSkewMs / 1000);
    if (typeof claims.exp === 'number' && nowS > claims.exp + skewS) return { ok: false, error: 'token has expired' };
    if (typeof claims.nbf === 'number' && nowS + skewS < claims.nbf) return { ok: false, error: 'token not yet valid' };

    // Issuer must be this team.
    const expectedIss = teamBaseUrl(teamDomain);
    if (claims.iss && claims.iss.replace(/\/+$/, '') !== expectedIss) {
      return { ok: false, error: 'token issued by a different team' };
    }

    // Audience pins the token to our specific Access application.
    if (audience) {
      const auds = Array.isArray(claims.aud) ? claims.aud : (claims.aud ? [claims.aud] : []);
      if (!auds.includes(audience)) return { ok: false, error: 'token is for a different application' };
    }

    const email = String(claims.email || claims.identity || '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'token carries no email' };

    return { ok: true, email, claims };
  } catch (e) {
    return { ok: false, error: `Access verification failed: ${e.message}` };
  }
}

/** Test seam: drop cached keys. */
function _resetJwksCache() { jwksCache.clear(); }

module.exports = { verifyAccessJwt, getSigningKeys, teamBaseUrl, _resetJwksCache };
