// Self-service registration for hop subdomains.
//
// The landing host (e.g. hop.zhoulab.io) is public: anyone can ask for
// <name>.hop.zhoulab.io. Two gates stand between the request and a working
// tunnel — proving control of an eligible email address, and a human
// approving it. This module owns everything except transport: validation,
// the state machine, tokens, and the on-disk registry. It touches no
// network and no daemon state, so it is fully unit-testable.
//
// Lifecycle:
//   pending_email    submitted; a verification link was mailed
//   pending_approval email proven; waiting on the admin
//   approved         admin said yes; tunnel + DNS provisioned, claim mailed
//   claimed          the credential bundle was downloaded (terminal state)
//   rejected         admin said no (terminal, but the name frees up)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Who may register. Subdomains count (cs.uchicago.edu, bsd.uchicago.edu),
// because plenty of departments hand out mail there.
const DEFAULT_ALLOWED_EMAIL_DOMAIN = 'uchicago.edu';

// Names that must never become someone's terminal. Two families: hostnames
// infrastructure assumes it owns (www, mail, ns1) and the addresses CAs and
// abuse desks use to prove domain control — handing one out would let a
// registrant issue certificates for the parent domain or intercept an abuse
// report.
const RESERVED_SUBDOMAINS = new Set([
  'www', 'mail', 'smtp', 'imap', 'pop', 'ns', 'ns1', 'ns2', 'mx', 'email',
  'admin', 'administrator', 'root', 'sysadmin', 'hostmaster', 'postmaster',
  'webmaster', 'abuse', 'security', 'ssl', 'tls', 'autoconfig', 'autodiscover',
  'api', 'app', 'auth', 'login', 'logout', 'register', 'signup', 'signin',
  'account', 'accounts', 'billing', 'payment', 'pay', 'checkout',
  'hop', 'shell', 'terminal', 'console', 'dashboard', 'panel',
  'cdn', 'static', 'assets', 'media', 'img', 'images', 'files', 'download',
  'docs', 'doc', 'help', 'support', 'status', 'health', 'blog', 'news',
  'test', 'testing', 'staging', 'stage', 'dev', 'develop', 'demo', 'sandbox',
  'prod', 'production', 'internal', 'private', 'secure', 'vpn', 'proxy',
  'git', 'ci', 'build', 'registry', 'npm', 'pypi',
  'claim', 'verify', 'invite', 'zhoulab', 'lab', 'uchicago'
]);

// Bounds. A hostname label may be 63 chars; 32 is friendlier and leaves room
// for the ".hop.zhoulab.io" tail in every UI that shows a full URL.
const SUBDOMAIN_MIN = 2;
const SUBDOMAIN_MAX = 32;

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;   // a day to click the link
const CLAIM_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // two weeks to set up
// One address may not farm subdomains, but a rejected or abandoned request
// must not lock someone out forever.
const RESUBMIT_COOLDOWN_MS = 60 * 1000;

const now = () => Date.now();

/** Tokens are compared against a stored HASH, never a stored secret: the
 *  registry is a plain file, and a leaked file must not hand over live
 *  verification or claim links. */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

/** Timing-safe compare so a token cannot be recovered byte-by-byte. */
const tokenMatches = (token, storedHash) => {
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false;
  const candidate = Buffer.from(hashToken(token), 'utf8');
  const expected = Buffer.from(storedHash, 'utf8');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
};

/**
 * Validate a requested subdomain. Returns { ok, value } or { ok:false, error }.
 * The value is the normalized (lowercased) label actually used everywhere.
 */
function validateSubdomain(raw, { reserved = RESERVED_SUBDOMAINS } = {}) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return { ok: false, error: 'Pick a subdomain.' };
  if (value.length < SUBDOMAIN_MIN) return { ok: false, error: `At least ${SUBDOMAIN_MIN} characters.` };
  if (value.length > SUBDOMAIN_MAX) return { ok: false, error: `At most ${SUBDOMAIN_MAX} characters.` };
  // Letters, digits and inner hyphens only — a DNS label, nothing more.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)) {
    return { ok: false, error: 'Use letters, numbers and hyphens; start and end with a letter or number.' };
  }
  // "xn--" is the punycode prefix: a label starting with it claims to be an
  // internationalized name and renders as something else entirely.
  if (value.startsWith('xn--')) return { ok: false, error: 'That prefix is reserved.' };
  if (value.includes('--')) return { ok: false, error: 'No double hyphens.' };
  if (reserved.has(value)) return { ok: false, error: 'That name is reserved.' };
  return { ok: true, value };
}

/**
 * Validate an email and normalize it for identity purposes.
 * Plus-addressing is refused rather than stripped: on Google Workspace
 * (which uchicago.edu runs) alice+1@ and alice+2@ are one mailbox, so
 * allowing tags would let one person hold unlimited subdomains, and
 * silently rewriting the address the user typed is worse than saying no.
 */
function validateEmail(raw, { allowedDomain = DEFAULT_ALLOWED_EMAIL_DOMAIN } = {}) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return { ok: false, error: 'Enter your email address.' };
  if (value.length > 254) return { ok: false, error: 'That address is too long.' };
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return { ok: false, error: 'That does not look like an email address.' };
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!/^[a-z0-9._%+-]+$/.test(local)) return { ok: false, error: 'That does not look like an email address.' };
  if (local.includes('+')) {
    return { ok: false, error: 'Use your plain address, without a “+” tag.' };
  }
  const allowed = String(allowedDomain).toLowerCase();
  if (domain !== allowed && !domain.endsWith(`.${allowed}`)) {
    return { ok: false, error: `Registration is open to ${allowed} addresses.` };
  }
  return { ok: true, value };
}

/** Registrations that still hold a name: anything not rejected or expired. */
const HOLDS_NAME = new Set(['pending_email', 'pending_approval', 'approved', 'claimed']);

class RegistrationStore {
  /**
   * @param {string} filePath registry location (JSON, written 0600)
   * @param {object} options  { allowedDomain, reserved, takenSubdomains }
   *   takenSubdomains is a callback into the live users registry, so a name
   *   already provisioned outside this flow can never be handed out twice.
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.allowedDomain = options.allowedDomain || DEFAULT_ALLOWED_EMAIL_DOMAIN;
    this.reserved = options.reserved || RESERVED_SUBDOMAINS;
    this.takenSubdomains = options.takenSubdomains || (() => []);
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {}; // absent or corrupt: an empty registry, never a crash
    }
  }

  save(all) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // 0600 from the moment it exists: this file holds email addresses.
    fs.writeFileSync(this.filePath, JSON.stringify(all, null, 2), { mode: 0o600 });
  }

  list() {
    return Object.values(this.load()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  get(subdomain) {
    return this.load()[String(subdomain || '').toLowerCase()] || null;
  }

  pending() {
    return this.list().filter((r) => r.status === 'pending_approval');
  }

  /** Is this name free to request right now? */
  isAvailable(subdomain) {
    const check = validateSubdomain(subdomain, { reserved: this.reserved });
    if (!check.ok) return check;
    const taken = new Set((this.takenSubdomains() || []).map((n) => String(n).toLowerCase()));
    if (taken.has(check.value)) return { ok: false, error: 'That name is taken.' };
    const existing = this.load()[check.value];
    if (existing && HOLDS_NAME.has(existing.status)) {
      // An abandoned email verification should not park a name forever.
      const stale = existing.status === 'pending_email'
        && (existing.verifyExpiresAt || 0) < now();
      if (!stale) return { ok: false, error: 'That name is taken.' };
    }
    return { ok: true, value: check.value };
  }

  /**
   * Record a new request. Returns { ok, subdomain, token } — the RAW token is
   * returned exactly once, for the mailer; only its hash is persisted.
   */
  submit({ subdomain, email, fullName = '', ip = '' }) {
    const nameCheck = this.isAvailable(subdomain);
    if (!nameCheck.ok) return { ok: false, error: nameCheck.error, field: 'subdomain' };
    const emailCheck = validateEmail(email, { allowedDomain: this.allowedDomain });
    if (!emailCheck.ok) return { ok: false, error: emailCheck.error, field: 'email' };

    const all = this.load();
    // One live request per address. Rejections do not count — a person told
    // "no" for a bad name should be able to try a better one.
    const held = Object.values(all).find((r) => r.email === emailCheck.value && HOLDS_NAME.has(r.status));
    if (held && held.subdomain !== nameCheck.value) {
      return {
        ok: false,
        field: 'email',
        error: `That address already has a registration (${held.subdomain}).`
      };
    }
    const previous = all[nameCheck.value];
    if (previous && previous.email === emailCheck.value
      && (now() - (previous.updatedAt || 0)) < RESUBMIT_COOLDOWN_MS) {
      return { ok: false, field: 'email', error: 'Just sent — check your inbox.' };
    }

    const token = newToken();
    all[nameCheck.value] = {
      subdomain: nameCheck.value,
      email: emailCheck.value,
      fullName: String(fullName || '').slice(0, 120),
      status: 'pending_email',
      verifyTokenHash: hashToken(token),
      verifyExpiresAt: now() + VERIFY_TOKEN_TTL_MS,
      createdAt: previous?.createdAt || now(),
      updatedAt: now(),
      requestIp: String(ip || '').slice(0, 64)
    };
    this.save(all);
    return { ok: true, subdomain: nameCheck.value, email: emailCheck.value, token };
  }

  /** Consume a verification token. Moves pending_email → pending_approval. */
  verify(token) {
    const all = this.load();
    const entry = Object.values(all).find((r) => tokenMatches(token, r.verifyTokenHash));
    if (!entry) return { ok: false, error: 'That link is not valid.' };
    if (entry.status === 'pending_approval' || entry.status === 'approved' || entry.status === 'claimed') {
      // Clicking twice is not an error — mail clients prefetch links.
      return { ok: true, already: true, registration: entry };
    }
    if (entry.status !== 'pending_email') return { ok: false, error: 'That link is no longer valid.' };
    if ((entry.verifyExpiresAt || 0) < now()) return { ok: false, error: 'That link has expired. Register again.' };

    entry.status = 'pending_approval';
    entry.verifiedAt = now();
    entry.updatedAt = now();
    delete entry.verifyTokenHash; // single use
    delete entry.verifyExpiresAt;
    this.save(all);
    return { ok: true, registration: entry };
  }

  /**
   * Admin approval. Returns the raw claim token once, for the mailer.
   * Provisioning (tunnel + DNS) happens outside; record it with markProvisioned.
   */
  approve(subdomain, { by = 'admin' } = {}) {
    const all = this.load();
    const entry = all[String(subdomain || '').toLowerCase()];
    if (!entry) return { ok: false, error: 'No such registration.' };
    if (entry.status === 'approved' || entry.status === 'claimed') {
      return { ok: false, error: `Already approved (${entry.status}).` };
    }
    if (entry.status !== 'pending_approval') {
      return { ok: false, error: `Cannot approve a registration that is ${entry.status}.` };
    }
    const token = newToken();
    entry.status = 'approved';
    entry.claimTokenHash = hashToken(token);
    entry.claimExpiresAt = now() + CLAIM_TOKEN_TTL_MS;
    entry.decidedAt = now();
    entry.decidedBy = by;
    entry.updatedAt = now();
    this.save(all);
    return { ok: true, registration: entry, token };
  }

  reject(subdomain, { reason = '', by = 'admin' } = {}) {
    const all = this.load();
    const entry = all[String(subdomain || '').toLowerCase()];
    if (!entry) return { ok: false, error: 'No such registration.' };
    if (entry.status === 'claimed') return { ok: false, error: 'Already claimed; remove the user instead.' };
    entry.status = 'rejected';
    entry.reason = String(reason || '').slice(0, 500);
    entry.decidedAt = now();
    entry.decidedBy = by;
    entry.updatedAt = now();
    delete entry.claimTokenHash;
    delete entry.verifyTokenHash;
    this.save(all);
    return { ok: true, registration: entry };
  }

  /** Record the provisioning result (hostname/tunnel) against a registration. */
  markProvisioned(subdomain, { hostname, tunnelId, tunnelName }) {
    const all = this.load();
    const entry = all[String(subdomain || '').toLowerCase()];
    if (!entry) return { ok: false, error: 'No such registration.' };
    entry.hostname = hostname;
    entry.tunnelId = tunnelId;
    entry.tunnelName = tunnelName;
    entry.provisionedAt = now();
    entry.updatedAt = now();
    this.save(all);
    return { ok: true, registration: entry };
  }

  /**
   * Look up a claim token WITHOUT consuming it — the download itself may
   * fail, and a bundle nobody received must stay claimable.
   */
  resolveClaim(token) {
    const entry = Object.values(this.load()).find((r) => tokenMatches(token, r.claimTokenHash));
    if (!entry) return { ok: false, error: 'That link is not valid.' };
    if (entry.status !== 'approved') return { ok: false, error: 'That link is no longer valid.' };
    if ((entry.claimExpiresAt || 0) < now()) return { ok: false, error: 'That link has expired. Ask the admin to re-issue it.' };
    return { ok: true, registration: entry };
  }

  /** Mark a claim consumed once the bundle actually went out. */
  markClaimed(subdomain) {
    const all = this.load();
    const entry = all[String(subdomain || '').toLowerCase()];
    if (!entry) return { ok: false, error: 'No such registration.' };
    entry.status = 'claimed';
    entry.claimedAt = now();
    entry.updatedAt = now();
    delete entry.claimTokenHash;
    delete entry.claimExpiresAt;
    this.save(all);
    return { ok: true, registration: entry };
  }
}

module.exports = {
  RegistrationStore,
  validateSubdomain,
  validateEmail,
  hashToken,
  newToken,
  tokenMatches,
  RESERVED_SUBDOMAINS,
  DEFAULT_ALLOWED_EMAIL_DOMAIN,
  VERIFY_TOKEN_TTL_MS,
  CLAIM_TOKEN_TTL_MS
};
