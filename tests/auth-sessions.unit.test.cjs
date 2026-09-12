const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AuthSessionStore, hashToken, isSessionToken, DEFAULT_TTL_MS } = require('../lib/auth-sessions');

const tmpStore = (options = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-auth-sessions-'));
  const filePath = path.join(dir, '.auth-sessions.json');
  return { store: new AuthSessionStore(filePath, options), filePath, dir };
};

test('create mints a distinct token per login and stores only its hash', () => {
  const { store, filePath } = tmpStore();
  const a = store.create({ via: 'totp', label: 'laptop' });
  const b = store.create({ via: 'passkey', label: 'phone' });
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.id, b.id);
  assert.ok(isSessionToken(a.token));
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.ok(!raw.includes(a.token), 'raw token must never be written to disk');
  assert.ok(raw.includes(hashToken(a.token)));
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('verify accepts a live token, rejects garbage, the daemon secret shape, and revoked tokens', () => {
  const { store } = tmpStore();
  const { id, token } = store.create({ via: 'totp' });
  assert.equal(store.verify(token).id, id);
  assert.equal(store.verify('nope'), null);
  assert.equal(store.verify(''), null);
  assert.equal(store.verify(undefined), null);
  // A 64-hex value is the legacy process-wide secret's shape: never a session.
  assert.equal(store.verify('a'.repeat(64)), null);
  assert.equal(store.revoke(id), true);
  assert.equal(store.verify(token), null);
  assert.equal(store.revoke(id), false);
});

test('sessions expire after the ttl (30 days by default) and are pruned', () => {
  let now = 1_000_000;
  const { store } = tmpStore({ now: () => now });
  const { token, expiresAt } = store.create({ via: 'totp' });
  assert.equal(expiresAt, now + DEFAULT_TTL_MS);
  assert.equal(DEFAULT_TTL_MS, 30 * 86400000);
  now += DEFAULT_TTL_MS - 1;
  assert.ok(store.verify(token));
  now += 2;
  assert.equal(store.verify(token), null);
  assert.equal(store.list().length, 0);
});

test('a custom ttl and no-expiry device tokens are honored', () => {
  let now = 5000;
  const { store } = tmpStore({ now: () => now });
  const short = store.create({ via: 'cli', ttlMs: 1000 });
  const forever = store.create({ via: 'cli', noExpiry: true, label: 'iphone' });
  assert.equal(forever.expiresAt, null);
  now += 1500;
  assert.equal(store.verify(short.token), null);
  assert.equal(store.verify(forever.token).label, 'iphone');
});

test('list hides token material and revokeAll can keep the caller', () => {
  const { store } = tmpStore();
  const keep = store.create({ via: 'passkey', label: 'me' });
  store.create({ via: 'totp', label: 'old laptop' });
  store.create({ via: 'totp', label: 'old phone' });
  const listed = store.list();
  assert.equal(listed.length, 3);
  for (const s of listed) {
    assert.equal(s.tokenHash, undefined);
    assert.equal(s.token, undefined);
  }
  assert.equal(store.revokeAll({ exceptId: keep.id }), 2);
  assert.deepEqual(store.list().map((s) => s.id), [keep.id]);
  assert.equal(store.revokeAll(), 1);
  assert.equal(store.list().length, 0);
});

test('state survives a fresh store instance (daemon restart)', () => {
  const { store, filePath } = tmpStore();
  const { token, id } = store.create({ via: 'totp' });
  const reopened = new AuthSessionStore(filePath);
  assert.equal(reopened.verify(token).id, id);
});

test('a corrupt state file is treated as empty, not fatal', () => {
  const { store, filePath } = tmpStore();
  fs.writeFileSync(filePath, '{not json');
  assert.deepEqual(store.list(), []);
  const { token } = store.create({ via: 'totp' });
  assert.ok(store.verify(token));
});
