const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RegistrationStore,
  validateSubdomain,
  validateEmail
} = require('../lib/registration');

const tmpStore = (options = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-reg-'));
  return new RegistrationStore(path.join(dir, 'registrations.json'), options);
};

test('subdomain validation refuses names that would break or impersonate DNS', () => {
  assert.equal(validateSubdomain('alice').ok, true);
  assert.equal(validateSubdomain('alice-lab-2').ok, true);
  // Case is normalized, because DNS is.
  assert.equal(validateSubdomain('ALICE').value, 'alice');

  for (const bad of ['', 'a', '-alice', 'alice-', 'al--ice', 'ali ce', 'ali_ce', 'a'.repeat(33), 'ali.ce']) {
    assert.equal(validateSubdomain(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  // Punycode prefix: renders as a different name than it reads as.
  assert.equal(validateSubdomain('xn--80ak6aa92e').ok, false);
  // Infrastructure and domain-control names stay ours.
  for (const reserved of ['www', 'mail', 'admin', 'postmaster', 'api', 'security', 'hop']) {
    assert.equal(validateSubdomain(reserved).ok, false, `${reserved} must be reserved`);
  }
});

test('email validation admits uchicago addresses and nothing else', () => {
  assert.equal(validateEmail('Alice@uchicago.edu').value, 'alice@uchicago.edu');
  assert.equal(validateEmail('bob@cs.uchicago.edu').ok, true, 'department subdomains count');

  for (const bad of ['alice@gmail.com', 'alice@uchicago.edu.evil.com', 'alice@notuchicago.edu', 'alice', '@uchicago.edu', '']) {
    assert.equal(validateEmail(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  // Plus-addressing would let one mailbox hold unlimited subdomains.
  assert.equal(validateEmail('alice+2@uchicago.edu').ok, false);
});

test('a submission holds the name, and the raw token is returned exactly once', () => {
  const store = tmpStore();
  const res = store.submit({ subdomain: 'alice', email: 'alice@uchicago.edu' });
  assert.equal(res.ok, true);
  assert.ok(res.token, 'caller gets the raw token to mail');

  const saved = store.get('alice');
  assert.equal(saved.status, 'pending_email');
  assert.equal(saved.email, 'alice@uchicago.edu');
  // The registry must never hold anything that works as a link.
  const onDisk = fs.readFileSync(store.filePath, 'utf8');
  assert.ok(!onDisk.includes(res.token), 'raw token must not be persisted');
  assert.ok(saved.verifyTokenHash, 'only the hash is stored');

  // The name is now spoken for.
  assert.equal(store.isAvailable('alice').ok, false);
});

test('verification is single-use, idempotent for double clicks, and expires', () => {
  const store = tmpStore();
  const { token } = store.submit({ subdomain: 'alice', email: 'alice@uchicago.edu' });

  const first = store.verify(token);
  assert.equal(first.ok, true);
  assert.equal(store.get('alice').status, 'pending_approval');
  assert.equal(store.get('alice').verifyTokenHash, undefined, 'token is consumed');

  // Mail clients prefetch links; a second click must not read as an error.
  const second = store.verify(token);
  assert.equal(second.ok, false, 'the consumed token no longer resolves');

  assert.equal(store.verify('not-a-real-token').ok, false);

  // Expiry is enforced against the stored deadline.
  const expired = tmpStore();
  const sub = expired.submit({ subdomain: 'bob', email: 'bob@uchicago.edu' });
  const all = JSON.parse(fs.readFileSync(expired.filePath, 'utf8'));
  all.bob.verifyExpiresAt = Date.now() - 1000;
  fs.writeFileSync(expired.filePath, JSON.stringify(all));
  assert.equal(expired.verify(sub.token).ok, false, 'an expired link is refused');
});

test('one live registration per address, but a rejection frees the person', () => {
  const store = tmpStore();
  store.submit({ subdomain: 'alice', email: 'alice@uchicago.edu' });

  const second = store.submit({ subdomain: 'alice2', email: 'alice@uchicago.edu' });
  assert.equal(second.ok, false);
  assert.match(second.error, /already has a registration/);

  store.reject('alice', { reason: 'name too generic' });
  const retry = store.submit({ subdomain: 'alice2', email: 'alice@uchicago.edu' });
  assert.equal(retry.ok, true, 'a rejected applicant may try again');
  // And the rejected name is available to anyone.
  assert.equal(store.isAvailable('alice').ok, true);
});

test('approval mints a claim token; only a verified registration can be approved', () => {
  const store = tmpStore();
  const { token } = store.submit({ subdomain: 'alice', email: 'alice@uchicago.edu' });

  // Not yet email-verified — approval must refuse.
  const early = store.approve('alice');
  assert.equal(early.ok, false);

  store.verify(token);
  const approved = store.approve('alice', { by: 'jianzhou' });
  assert.equal(approved.ok, true);
  assert.ok(approved.token, 'claim token returned once');
  assert.equal(store.get('alice').status, 'approved');
  const onDisk = fs.readFileSync(store.filePath, 'utf8');
  assert.ok(!onDisk.includes(approved.token), 'claim token is stored only as a hash');

  // Double approval is refused rather than minting a second live link.
  assert.equal(store.approve('alice').ok, false);

  const resolved = store.resolveClaim(approved.token);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.registration.subdomain, 'alice');

  // Resolving does NOT consume: a failed download must stay claimable.
  assert.equal(store.resolveClaim(approved.token).ok, true);

  store.markClaimed('alice');
  assert.equal(store.get('alice').status, 'claimed');
  assert.equal(store.resolveClaim(approved.token).ok, false, 'claimed link is dead');
});

test('names already provisioned outside this flow are never handed out', () => {
  const store = tmpStore({ takenSubdomains: () => ['jianzhou', 'Existing'] });
  assert.equal(store.isAvailable('jianzhou').ok, false);
  assert.equal(store.isAvailable('existing').ok, false, 'comparison is case-insensitive');
  assert.equal(store.isAvailable('newperson').ok, true);
  assert.equal(store.submit({ subdomain: 'jianzhou', email: 'a@uchicago.edu' }).ok, false);
});

test('an abandoned verification releases the name once it expires', () => {
  const store = tmpStore();
  store.submit({ subdomain: 'ghost', email: 'ghost@uchicago.edu' });
  assert.equal(store.isAvailable('ghost').ok, false, 'held while the link is live');

  const all = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  all.ghost.verifyExpiresAt = Date.now() - 1000;
  fs.writeFileSync(store.filePath, JSON.stringify(all));
  assert.equal(store.isAvailable('ghost').ok, true, 'an expired hold frees the name');
});

test('the registry file is created private — it holds email addresses', () => {
  const store = tmpStore();
  store.submit({ subdomain: 'alice', email: 'alice@uchicago.edu' });
  const mode = fs.statSync(store.filePath).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('pending() lists exactly what the admin must decide on', () => {
  const store = tmpStore();
  const a = store.submit({ subdomain: 'alice', email: 'alice@uchicago.edu' });
  store.submit({ subdomain: 'bob', email: 'bob@uchicago.edu' });   // never verified
  const c = store.submit({ subdomain: 'carol', email: 'carol@uchicago.edu' });
  store.verify(a.token);
  store.verify(c.token);
  store.approve('carol');

  assert.deepEqual(store.pending().map((r) => r.subdomain), ['alice']);
});
