// Cloudflare Access JWT verification is the identity gate for registration —
// a bad verifier hands out credentials to the wrong person. These tests mint
// REAL RS256 tokens with a generated key and exercise every rejection path,
// with the JWKS fetch stubbed so nothing touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyAccessJwt, teamBaseUrl, _resetJwksCache } = require('../lib/cf-access');

const TEAM = 'acme';
const ISS = 'https://acme.cloudflareaccess.com';
const AUD = 'aud-tag-for-our-app';
const KID = 'test-key-1';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Mint a signed token. Overrides let each test bend one thing.
const mint = (claims = {}, { kid = KID, alg = 'RS256', key = privateKey, tamper = false } = {}) => {
  const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({
    iss: ISS, aud: [AUD], email: 'alice@uchicago.edu',
    iat: now, exp: now + 3600, ...claims
  }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), key);
  let sigStr = b64url(sig);
  if (tamper) sigStr = sigStr.slice(0, -2) + (sigStr.endsWith('AA') ? 'BB' : 'AA');
  return `${header}.${body}.${sigStr}`;
};

// A JWKS fetch that serves our generated public key as a JWK.
const jwk = publicKey.export({ format: 'jwk' });
const fetchImpl = async () => ({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });

const opts = (extra = {}) => ({ teamDomain: TEAM, audience: AUD, fetchImpl, ...extra });

test.beforeEach(() => _resetJwksCache());

test('teamBaseUrl normalises a bare team and a full host', () => {
  assert.equal(teamBaseUrl('acme'), 'https://acme.cloudflareaccess.com');
  assert.equal(teamBaseUrl('acme.cloudflareaccess.com'), 'https://acme.cloudflareaccess.com');
  assert.equal(teamBaseUrl('https://acme.cloudflareaccess.com/'), 'https://acme.cloudflareaccess.com');
  assert.equal(teamBaseUrl(''), null);
});

test('a valid token yields the lower-cased email', async () => {
  const r = await verifyAccessJwt(mint({ email: 'Alice@UChicago.edu' }), opts());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.email, 'alice@uchicago.edu');
});

test('a tampered signature is refused', async () => {
  const r = await verifyAccessJwt(mint({}, { tamper: true }), opts());
  assert.equal(r.ok, false);
  assert.match(r.error, /signature/);
});

test('a token signed by a DIFFERENT key is refused', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const r = await verifyAccessJwt(mint({}, { key: other }), opts());
  assert.equal(r.ok, false);
  assert.match(r.error, /signature/);
});

test('an unknown kid is refused (not silently accepted)', async () => {
  const r = await verifyAccessJwt(mint({}, { kid: 'someone-elses-key' }), opts());
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown key/);
});

test('a non-RS256 alg is refused — no alg-confusion', async () => {
  // Even a "valid-looking" token must be rejected on algorithm alone.
  const r = await verifyAccessJwt(mint({}, { alg: 'HS256' }), opts());
  assert.equal(r.ok, false);
  assert.match(r.error, /algorithm/);
});

test('an expired token is refused', async () => {
  const past = Math.floor(Date.now() / 1000) - 7200;
  const r = await verifyAccessJwt(mint({ iat: past, exp: past + 60 }), opts());
  assert.equal(r.ok, false);
  assert.match(r.error, /expired/);
});

test('a token from another team is refused', async () => {
  const r = await verifyAccessJwt(mint({ iss: 'https://evil.cloudflareaccess.com' }), opts());
  assert.equal(r.ok, false);
  assert.match(r.error, /different team/);
});

test('a token for another application (aud) is refused when audience is pinned', async () => {
  const r = await verifyAccessJwt(mint({ aud: ['some-other-apps-aud'] }), opts());
  assert.equal(r.ok, false);
  assert.match(r.error, /different application/);
});

test('audience is optional — omitting it skips the app check', async () => {
  const r = await verifyAccessJwt(mint({ aud: ['whatever'] }), opts({ audience: null }));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.email, 'alice@uchicago.edu');
});

test('a malformed token is refused, not thrown', async () => {
  for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d']) {
    const r = await verifyAccessJwt(bad, opts());
    assert.equal(r.ok, false, `"${bad}" should be refused`);
  }
});

test('a token with no email claim is refused', async () => {
  const r = await verifyAccessJwt(mint({ email: '' }), opts());
  assert.equal(r.ok, false);
  assert.match(r.error, /no email/);
});
