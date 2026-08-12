// End-to-end for the public signup surface: a real daemon, a real HTTP
// request on the landing hostname, a real SMTP conversation into a fake
// server. Nothing here touches Cloudflare — approval (which provisions a
// tunnel) is covered at the store level in registration.unit.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const HOP_BIN = path.join(__dirname, '..', 'hop');
const LANDING_HOST = 'hoptest.example.com';

let tempDir;
let hopHome;
let binDir;
let daemonPid;
let state;
let smtp;

/** Fake SMTP that accepts anything and keeps the messages it was handed. */
function startFakeSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let dataBuf = '';
    let authStep = 0;
    socket.setEncoding('utf8');
    socket.on('error', () => {});   // clients hang up right after QUIT
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      if (inData) {
        dataBuf += chunk;
        if (dataBuf.includes('\r\n.\r\n')) {
          inData = false;
          const raw = dataBuf.split('\r\n.\r\n')[0];
          const [headers, body] = raw.split('\r\n\r\n');
          messages.push({
            headers,
            to: (/^To: (.*)$/m.exec(headers) || [])[1],
            subject: (/^Subject: (.*)$/m.exec(headers) || [])[1],
            text: Buffer.from(String(body || '').replace(/\r\n/g, ''), 'base64').toString('utf8')
          });
          dataBuf = '';
          socket.write('250 queued\r\n');
        }
        return;
      }
      for (const line of chunk.split('\r\n').filter(Boolean)) {
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) socket.write('250-fake\r\n250 AUTH LOGIN\r\n');
        // AUTH LOGIN is three turns: the command, then the base64 username,
        // then the base64 password. Answering 250 to the credential lines
        // (as a catch-all would) makes every send fail at the AUTH step.
        else if (upper === 'AUTH LOGIN') { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
        else if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (authStep === 2) { authStep = 0; socket.write('235 accepted\r\n'); }
        else if (upper === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (upper === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, messages }));
  });
}

function request(method, reqPath, { host = LANDING_HOST, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: state.port,
      path: reqPath,
      method,
      headers: {
        Host: host,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Config is cached briefly in the daemon; poll rather than assume. */
const until = async (predicate, what, timeoutMs = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(150);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const readRegistry = () => {
  try { return JSON.parse(fsSync.readFileSync(path.join(hopHome, '.registrations.json'), 'utf8')); }
  catch (e) { return {}; }
};

const restoreMail = () => writeJson('.mail-config.json', {
  host: '127.0.0.1', port: smtp.port, user: 'hop', pass: 'x',
  from: 'hop <hop@hoptest.example.com>', insecure: true
});

const writeJson = (file, value) =>
  fs.writeFile(path.join(hopHome, file), JSON.stringify(value, null, 2), { mode: 0o600 });

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hop-reg-e2e-'));
  hopHome = path.join(tempDir, 'hop_home');
  binDir = path.join(tempDir, 'bin');
  await fs.mkdir(hopHome, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, 'cloudflared'),
    '#!/usr/bin/env bash\nwhile true; do sleep 1; done\n', { mode: 0o755 });

  smtp = await startFakeSmtp();

  // hop refuses to serve a publicly-known custom domain without a password.
  // Same scrypt format as hashPassword(); the value is irrelevant here — the
  // point is that the landing page must be reachable WITHOUT it.
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  await fs.writeFile(path.join(hopHome, '.password_hash'),
    `${salt}:${crypto.scryptSync('test-password', salt, 64).toString('hex')}`, { mode: 0o600 });

  // A custom domain makes this host the landing host; registration on; mail
  // pointed at the fake (insecure is allowed only for loopback).
  await writeJson('.domain-config.json', { tunnelName: 'hop', tunnelId: 't-1', hostname: LANDING_HOST });
  await writeJson('.registration.json', { enabled: true, allowedEmailDomain: 'uchicago.edu', adminSubdomain: 'admin' });
  await writeJson('.mail-config.json', {
    host: '127.0.0.1', port: smtp.port, user: 'hop', pass: 'x',
    from: 'hop <hop@hoptest.example.com>', insecure: true
  });

  const child = spawn(process.execPath, [HOP_BIN, '--daemon'], {
    env: { ...process.env, HOP_HOME: hopHome, HOP_NO_TUNNEL: '1', PATH: `${binDir}:${process.env.PATH || ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  const output = [];
  child.stdout.on('data', (c) => output.push(c.toString()));
  child.stderr.on('data', (c) => output.push(c.toString()));
  child.unref();
  daemonPid = child.pid;

  // Wait for the port to actually ACCEPT — a state file only says the daemon
  // got far enough to write one, not that it survived to listen.
  const accepts = (port) => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
  });

  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(hopHome, '.tunnel-state'), 'utf8'));
      if (parsed && parsed.port && await accepts(parsed.port)) {
        state = parsed;
        daemonPid = parsed.pid;
        return;
      }
    } catch (e) { /* not up yet */ }
    await delay(200);
  }
  throw new Error(`daemon never came up:\n${output.join('')}`);
});

test.after(async () => {
  if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM'); } catch (e) {} }
  if (smtp) smtp.server.close();
  await delay(300);
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('the landing host serves a public signup page instead of the login gate', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /Request a subdomain/);
  assert.match(res.body, new RegExp(LANDING_HOST));
  assert.match(res.body, /uchicago\.edu/);
  // The point of the change: no credential prompt for a stranger.
  assert.ok(!/Security Check/.test(res.body), 'must not be the login page');
});

test('any other hostname is untouched — the admin still gets the login gate', async () => {
  const res = await request('GET', '/', { host: 'localhost' });
  assert.equal(res.status, 200);
  assert.match(res.body, /Security Check/, 'localhost keeps the login page');
  assert.ok(!/Request a subdomain/.test(res.body));
});

test('/signin on the landing host is the admin escape hatch', async () => {
  const res = await request('GET', '/signin');
  assert.match(res.body, /Security Check/, 'the login page stays reachable');
});

test('a valid request is recorded and mailed a confirmation link', async () => {
  const before = smtp.messages.length;
  const res = await request('POST', '/api/register', {
    body: { subdomain: 'alice', email: 'Alice@uchicago.edu', fullName: 'Alice A' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);

  const started = Date.now();
  while (smtp.messages.length === before && Date.now() - started < 5000) await delay(100);
  assert.equal(smtp.messages.length, before + 1, 'a confirmation email went out');

  const mail = smtp.messages[smtp.messages.length - 1];
  assert.match(mail.to, /alice@uchicago\.edu/);
  assert.match(mail.subject, /alice\.hoptest\.example\.com/);
  const link = (/https:\/\/\S+\/verify\?token=\S+/.exec(mail.text) || [])[0];
  assert.ok(link, `the email carries a verification link:\n${mail.text}`);

  const registry = readRegistry();
  assert.equal(registry.alice.status, 'pending_email');
  assert.equal(registry.alice.email, 'alice@uchicago.edu', 'address is normalized');
  // The live token must exist only in the mail, never at rest.
  const token = new URL(link).searchParams.get('token');
  assert.ok(!JSON.stringify(registry).includes(token), 'raw token is not persisted');

  // Following the link promotes the request to the admin queue.
  const verify = await request('GET', `/verify?token=${encodeURIComponent(token)}`);
  assert.equal(verify.status, 200);
  assert.match(verify.body, /Email confirmed/);
  assert.equal(readRegistry().alice.status, 'pending_approval');
});

test('ineligible addresses and unusable names are refused before anything is stored', async () => {
  const cases = [
    { subdomain: 'bob', email: 'bob@gmail.com', expect: /uchicago\.edu/ },
    { subdomain: 'www', email: 'bob@uchicago.edu', expect: /reserved/i },
    { subdomain: 'admin', email: 'bob@uchicago.edu', expect: /taken|reserved/i },
    { subdomain: 'alice', email: 'other@uchicago.edu', expect: /taken/i },
    { subdomain: 'x', email: 'bob@uchicago.edu', expect: /characters/i },
    { subdomain: 'bad name', email: 'bob@uchicago.edu', expect: /letters, numbers/i }
  ];
  for (const c of cases) {
    const res = await request('POST', '/api/register', { body: { subdomain: c.subdomain, email: c.email } });
    assert.equal(res.status, 400, `${c.subdomain}/${c.email} must be refused`);
    assert.match(res.json.error, c.expect);
  }
  const registry = readRegistry();
  assert.ok(!registry.bob && !registry.www, 'nothing was written for a refused request');
});

test('a bad verification token never reveals whether one exists', async () => {
  const res = await request('GET', '/verify?token=totally-made-up');
  assert.equal(res.status, 400);
  assert.match(res.body, /did not work/i);
});

test('a claim link is required to reach credentials', async () => {
  const res = await request('GET', '/claim?token=nope');
  assert.equal(res.status, 400);
  const file = await request('GET', '/claim/credentials.json?token=nope');
  assert.equal(file.status, 400);
});

test('turning registration off restores the login gate on the landing host', async () => {
  // Restore in a finally: a failed assertion here must not leave the daemon
  // configured differently for every test that follows.
  try {
    await writeJson('.registration.json', { enabled: false, allowedEmailDomain: 'uchicago.edu' });
    await until(async () => /Security Check/.test((await request('GET', '/')).body),
      'the landing host to fall back to the login page');

    // The public endpoint stops registering anyone. It falls through to the
    // login page (hop's standard answer to any unauthenticated request), so
    // the property that matters is that nothing was accepted or stored.
    const post = await request('POST', '/api/register', { body: { subdomain: 'carol', email: 'carol@uchicago.edu' } });
    assert.notEqual(post.json?.ok, true, 'no registration may succeed while disabled');
    assert.ok(!readRegistry().carol, 'nothing is written while disabled');
  } finally {
    await writeJson('.registration.json', { enabled: true, allowedEmailDomain: 'uchicago.edu', adminSubdomain: 'admin' });
  }
});

test('signups are refused outright when mail cannot be sent', async () => {
  try {
    await until(async () => /Request a subdomain/.test((await request('GET', '/')).body),
      'registration to be back on');
    await fs.rm(path.join(hopHome, '.mail-config.json'));
    const res = await request('POST', '/api/register', { body: { subdomain: 'dave', email: 'dave@uchicago.edu' } });
    assert.equal(res.status, 503);
    assert.ok(!readRegistry().dave, 'a name is never held for a confirmation we cannot send');
  } finally {
    await restoreMail();
  }
});

test('a name is not left stranded when the confirmation email fails', async () => {
  try {
    // Point mail at a closed port: the send must fail, and the hold must lift.
    await writeJson('.mail-config.json', {
      host: '127.0.0.1', port: 1, user: 'hop', pass: 'x',
      from: 'hop <hop@hoptest.example.com>', insecure: true
    });
    const res = await request('POST', '/api/register', { body: { subdomain: 'erin', email: 'erin@uchicago.edu' } });
    assert.equal(res.status, 502);
    const entry = readRegistry().erin;
    assert.ok(!entry || entry.status === 'rejected', `the name must not stay held, got ${entry && entry.status}`);
  } finally {
    await restoreMail();
  }
});

// ── Moving hosts ──────────────────────────────────────────────────────────
// A client set up against the old hostname has to (a) find out where home is
// now and (b) get there without the user re-entering a password and a TOTP
// code on every device.

const setCanonical = (host) => writeJson('.config.json', host ? { canonicalHost: host } : {});

test('/api/instance tells an unauthenticated client where home is now', async () => {
  try {
    await setCanonical('me.hoptest.example.com');
    await until(async () => (await request('GET', '/api/instance')).json?.canonicalHost === 'me.hoptest.example.com',
      'the canonical host to be advertised');

    const res = await request('GET', '/api/instance');
    assert.equal(res.status, 200);
    // No cookie was sent: a lapsed client is exactly the one that must be told.
    assert.equal(res.json.canonicalUrl, 'https://me.hoptest.example.com');
    assert.equal(res.json.host, LANDING_HOST);
    assert.equal(res.json.isCanonical, false, 'this client is on the old hostname');

    const onCanonical = await request('GET', '/api/instance', { host: 'me.hoptest.example.com' });
    assert.equal(onCanonical.json.isCanonical, true, 'a client already home is told to stay');
  } finally {
    await setCanonical(null);
  }
});

test('with no canonical host configured, nothing claims a client should move', async () => {
  await until(async () => (await request('GET', '/api/instance')).json?.canonicalHost === null,
    'the canonical host to clear');
  const res = await request('GET', '/api/instance');
  assert.equal(res.json.canonicalHost, null);
  assert.equal(res.json.isCanonical, true, 'no configured move means every host is home');
});

test('a handoff is refused to anyone not already signed in', async () => {
  try {
    await setCanonical('me.hoptest.example.com');
    await until(async () => (await request('GET', '/api/instance')).json?.canonicalHost, 'canonical host');

    const res = await request('POST', '/api/handoff', { body: {} });
    assert.equal(res.status, 401, 'a handoff may never create access that did not exist');
  } finally {
    await setCanonical(null);
  }
});

test('a signed-in client hands its session to the new hostname exactly once', async () => {
  try {
    await setCanonical('me.hoptest.example.com');
    await until(async () => (await request('GET', '/api/instance')).json?.canonicalHost, 'canonical host');

    const auth = { Cookie: `tunnel_session=${state.sessionSecret}` };
    const mint = await request('POST', '/api/handoff', { body: {}, headers: auth });
    assert.equal(mint.status, 200);
    assert.match(mint.json.url, /^https:\/\/me\.hoptest\.example\.com\/api\/handoff\/redeem\?token=/);

    const token = new URL(mint.json.url).searchParams.get('token');

    // Redeeming on the OLD hostname must fail — the link is bound to the
    // destination, so a stray click cannot re-authorize the wrong host.
    const wrongHost = await request('GET', `/api/handoff/redeem?token=${encodeURIComponent(token)}`);
    assert.equal(wrongHost.status, 400);
    assert.ok(!String(wrongHost.headers['set-cookie'] || '').includes('tunnel_session='), 'no cookie on the wrong host');

    // A misdirected attempt does NOT spend the token: it granted nothing, and
    // burning it would let one stray redirect strand a device mid-migration.
    // Only a genuine redeem on the destination consumes it.
    const redeemed = await request('GET', `/api/handoff/redeem?token=${encodeURIComponent(token)}`,
      { host: 'me.hoptest.example.com' });
    assert.equal(redeemed.status, 302);
    assert.equal(redeemed.headers.location, '/');
    const setCookie = String(redeemed.headers['set-cookie'] || '');
    assert.match(setCookie, /tunnel_session=/);
    assert.match(setCookie, /HttpOnly/i);
    // Host-scoped: a Domain= cookie here would hand this secret to every
    // registered user's subdomain.
    assert.ok(!/Domain=/i.test(setCookie), `handoff cookie must not be domain-wide: ${setCookie}`);

    // Replay is dead.
    const replay = await request('GET', `/api/handoff/redeem?token=${encodeURIComponent(token)}`,
      { host: 'me.hoptest.example.com' });
    assert.equal(replay.status, 400);
  } finally {
    await setCanonical(null);
  }
});

test('a made-up handoff token is refused even on the right hostname', async () => {
  try {
    await setCanonical('me.hoptest.example.com');
    await until(async () => (await request('GET', '/api/instance')).json?.canonicalHost, 'canonical host');
    const res = await request('GET', '/api/handoff/redeem?token=invented',
      { host: 'me.hoptest.example.com' });
    assert.equal(res.status, 400);
    assert.ok(!String(res.headers['set-cookie'] || '').includes('tunnel_session='), 'no cookie is minted');
  } finally {
    await setCanonical(null);
  }
});
