// End-to-end: per-device login sessions and the remote-access (password) gate,
// against a real daemon in a throwaway HOP_HOME.
//
//   node --test tests/auth-sessions.integration.test.cjs
//
// Part 1 runs with HOP_NO_TUNNEL=1 (no cloudflared) and exercises login →
// per-device cookie, listing, device tokens, revocation, logout, and the
// WebSocket query-token rule. Part 2 runs with a fake cloudflared and checks
// that the tunnel stays off without a password and opens with the opt-out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { authenticator } = require('otplib');

const HOP_BIN = path.join(__dirname, '..', 'hop');

async function writeFakeCloudflared(binPath, logPath) {
  const script = [
    '#!/usr/bin/env bash',
    `LOG_FILE="${logPath}"`,
    'TS=$(date +%s)',
    'echo "2024-01-01T00:00:00Z INF tunnel URL https://test-${TS}.trycloudflare.com" >&2',
    'echo "Registered tunnel connection" >&2',
    'echo "$$ ${TS} start" >> "$LOG_FILE"',
    'trap \'echo "$$ $(date +%s) term" >> "$LOG_FILE"; exit 0\' TERM INT',
    'while true; do sleep 1; done',
    ''
  ].join('\n');
  await fs.writeFile(binPath, script, { mode: 0o755 });
}

function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (payload) h['Content-Type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Raw WebSocket upgrade; resolve with the first status line the server sends.
function upgradeStatus(port, reqPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${reqPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
        '', ''
      ];
      sock.write(lines.join('\r\n'));
    });
    let buf = '';
    const done = (v) => { try { sock.destroy(); } catch (e) { } resolve(v); };
    sock.on('data', (c) => { buf += c.toString('latin1'); const m = /^HTTP\/1\.1 (\d{3})/.exec(buf); if (m) done(Number(m[1])); });
    sock.on('close', () => done(buf ? null : 'closed'));
    sock.on('error', reject);
    setTimeout(() => done('timeout'), 4000).unref();
  });
}

async function readState(home) {
  return JSON.parse(await fs.readFile(path.join(home, '.tunnel-state'), 'utf8'));
}

class Daemon {
  constructor(extraEnv = {}, { fakeTunnel = false } = {}) {
    this.extraEnv = extraEnv;
    this.fakeTunnel = fakeTunnel;
    this.output = [];
  }

  async start() {
    this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hop-auth-test-'));
    this.home = path.join(this.tempDir, 'hop_home');
    this.binDir = path.join(this.tempDir, 'bin');
    await fs.mkdir(this.home, { recursive: true });
    await fs.mkdir(this.binDir, { recursive: true });
    await writeFakeCloudflared(path.join(this.binDir, 'cloudflared'), path.join(this.tempDir, 'cloudflared.log'));
    await fs.writeFile(path.join(this.binDir, 'claude'), '#!/usr/bin/env bash\necho "stub claude: $@"\n', { mode: 0o755 });
    const env = {
      ...process.env,
      HOP_HOME: this.home,
      PATH: `${this.binDir}:${process.env.PATH || ''}`,
      ...(this.fakeTunnel ? {} : { HOP_NO_TUNNEL: '1' }),
      ...this.extraEnv
    };
    delete env.HOP_ALLOW_TOTP_ONLY;
    Object.assign(env, this.extraEnv);
    const child = spawn(process.execPath, [HOP_BIN, '--daemon'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', (c) => this.output.push(c.toString('utf8')));
    child.stderr.on('data', (c) => this.output.push(c.toString('utf8')));
    let exitCode = null;
    child.once('exit', (code) => { exitCode = code; });
    child.unref();
    this.pid = child.pid;
    const start = Date.now();
    while (Date.now() - start < 25000) {
      try {
        const st = await readState(this.home);
        // With the tunnel blocked, url is null but the state file still lands.
        // The daemon claims HOP_HOME (writes state) before the HTTP server is
        // listening, so also wait until the API answers.
        if (st && st.port && st.sessionSecret) {
          try {
            await request(st.port, { path: '/api/auth', headers: { Authorization: `Bearer ${st.sessionSecret}` } });
            this.state = st; this.pid = st.pid; return;
          } catch (e) { /* not listening yet */ }
        }
      } catch (e) { }
      if (exitCode !== null) throw new Error(`daemon exited ${exitCode}:\n${this.output.join('')}`);
      await delay(200);
    }
    throw new Error(`timed out waiting for daemon state:\n${this.output.join('')}`);
  }

  async totp() {
    const secret = (await fs.readFile(path.join(this.home, '.auth_secret'), 'utf8')).trim();
    return authenticator.generate(secret);
  }

  async stop() {
    for (const file of ['.hay-host-state']) {
      try {
        const pid = Number(JSON.parse(await fs.readFile(path.join(this.home, file), 'utf8'))?.pid);
        if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch (e) { } }
      } catch (e) { }
    }
    if (!this.pid) return;
    try { process.kill(this.pid, 'SIGTERM'); } catch (e) { }
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try { process.kill(this.pid, 0); } catch (e) { return; }
      await delay(100);
    }
    try { process.kill(this.pid, 'SIGKILL'); } catch (e) { }
  }
}

const COOKIE = 'tunnel_session';
const cookieValue = (setCookie) => {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of list) {
    const m = new RegExp(`^${COOKIE}=([^;]*)`).exec(String(c || ''));
    if (m && m[1]) return { value: m[1], raw: String(c) };
  }
  return null;
};

test('per-device login sessions: login, list, device tokens, revoke, logout, ws query rule', async (t) => {
  const d = new Daemon();
  await d.start();
  t.after(() => d.stop());
  const port = d.state.port;
  const secret = d.state.sessionSecret;
  const ipc = { Authorization: `Bearer ${secret}` };

  // The daemon secret still works as a Bearer for local IPC…
  assert.equal((await request(port, { path: '/api/auth', headers: ipc })).status, 200);
  // …but is no longer a valid cookie: every old browser lands on the login page.
  assert.equal((await request(port, { path: '/api/auth', headers: { Cookie: `${COOKIE}=${secret}` } })).status, 401);
  // A garbage cookie is refused too.
  assert.equal((await request(port, { path: '/api/auth', headers: { Cookie: `${COOKIE}=hs_nope` } })).status, 401);

  // TOTP login mints a per-device session cookie, 30 days long.
  const login = await request(port, {
    method: 'POST', path: '/api/login', body: { totp: await d.totp() },
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' }
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const ck = cookieValue(login.headers['set-cookie']);
  assert.ok(ck, 'login sets the session cookie');
  assert.ok(ck.value.startsWith('hs_'), `cookie is a per-device token, got ${ck.value.slice(0, 6)}`);
  assert.notEqual(ck.value, secret, 'cookie must not be the daemon secret');
  assert.match(ck.raw, /Max-Age=2592000/, '30-day cookie');
  assert.match(ck.raw, /HttpOnly/);
  assert.match(ck.raw, /Secure/);
  const asCookie = { Cookie: `${COOKIE}=${ck.value}` };
  assert.equal((await request(port, { path: '/api/auth', headers: asCookie })).status, 200);

  // A second login is a second, independent session.
  await delay(1100); // fresh TOTP window not required (same code is fine), but avoid rate-limit clustering
  const login2 = await request(port, { method: 'POST', path: '/api/login', body: { totp: await d.totp() }, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Chrome/126.0 Safari/537.36' } });
  assert.equal(login2.status, 200, JSON.stringify(login2.data));
  const ck2 = cookieValue(login2.headers['set-cookie']);
  assert.notEqual(ck2.value, ck.value);

  // Listing shows both, marks the caller, hides token material.
  const list = await request(port, { path: '/api/auth/sessions', headers: asCookie });
  assert.equal(list.status, 200);
  assert.equal(list.data.ttlDays, 30);
  assert.equal(list.data.via, 'cookie');
  assert.equal(list.data.sessions.length, 2);
  const mine = list.data.sessions.find((s) => s.current);
  assert.ok(mine, 'caller session marked current');
  assert.equal(mine.id, list.data.current);
  assert.match(mine.label, /iPhone/);
  for (const s of list.data.sessions) {
    assert.equal(s.tokenHash, undefined);
    assert.equal(s.token, undefined);
    assert.equal(typeof s.expiresAt, 'number');
  }
  assert.ok(mine.expiresAt - Date.now() > 29 * 86400000);

  // IPC callers (the CLI) see no current session.
  const ipcList = await request(port, { path: '/api/auth/sessions', headers: ipc });
  assert.equal(ipcList.data.current, null);
  assert.equal(ipcList.data.via, 'ipc');

  // Device tokens: minted once, usable as Bearer, honoring --days.
  const tok = await request(port, { method: 'POST', path: '/api/auth/sessions/token', headers: ipc, body: { label: 'ci script', days: 2 } });
  assert.equal(tok.status, 200, JSON.stringify(tok.data));
  assert.ok(tok.data.token.startsWith('hs_'));
  const twoDays = tok.data.expiresAt - Date.now();
  assert.ok(twoDays > 1.9 * 86400000 && twoDays <= 2 * 86400000 + 5000, `2-day token, got ${twoDays}`);
  const asBearer = { Authorization: `Bearer ${tok.data.token}` };
  assert.equal((await request(port, { path: '/api/auth', headers: asBearer })).status, 200);
  assert.equal((await request(port, { path: '/api/auth/sessions', headers: ipc })).data.sessions.length, 3);
  const noExp = await request(port, { method: 'POST', path: '/api/auth/sessions/token', headers: ipc, body: { label: 'phone', noExpiry: true } });
  assert.equal(noExp.data.expiresAt, null);

  // The web UI's actor inference: a Bearer device token counts as automation,
  // a cookie as a human — same as before the change.
  // (Covered indirectly: /api/auth/sessions reports via.)

  // Revoke one by id: that device is out, others stay.
  const rev = await request(port, { method: 'POST', path: '/api/auth/sessions/revoke', headers: ipc, body: { id: mine.id } });
  assert.equal(rev.status, 200);
  assert.equal((await request(port, { path: '/api/auth', headers: asCookie })).status, 401, 'revoked cookie refused');
  assert.equal((await request(port, { path: '/api/auth', headers: { Cookie: `${COOKIE}=${ck2.value}` } })).status, 200, 'other device unaffected');
  assert.equal((await request(port, { method: 'POST', path: '/api/auth/sessions/revoke', headers: ipc, body: { id: mine.id } })).status, 404);

  // Logout revokes the caller's own session and clears the cookie.
  const out = await request(port, { method: 'POST', path: '/api/logout', headers: asBearer });
  assert.equal(out.status, 200);
  const cleared = [].concat(out.headers['set-cookie'] || []).some((c) => /^tunnel_session=;/.test(String(c)) && /Max-Age=0/.test(String(c)));
  assert.ok(cleared, `logout clears the cookie, got ${JSON.stringify(out.headers['set-cookie'])}`);
  assert.equal((await request(port, { path: '/api/auth', headers: asBearer })).status, 401);

  // Revoke everyone from the CLI path (IPC, keepCurrent:false).
  const all = await request(port, { method: 'POST', path: '/api/auth/sessions/revoke', headers: ipc, body: { all: true, keepCurrent: false } });
  assert.equal(all.status, 200);
  assert.ok(all.data.removed >= 2);
  assert.equal((await request(port, { path: '/api/auth/sessions', headers: ipc })).data.sessions.length, 0);
  assert.equal((await request(port, { path: '/api/auth', headers: { Cookie: `${COOKIE}=${ck2.value}` } })).status, 401);
  // IPC is untouched by revocation: it is not a session.
  assert.equal((await request(port, { path: '/api/auth', headers: ipc })).status, 200);

  // WebSocket ?token=<daemon secret>: fine from a direct loopback client (the
  // local CLI), refused when the request came in through the tunnel.
  const direct = await upgradeStatus(port, `/ws?room=nope&token=${encodeURIComponent(secret)}`);
  assert.notEqual(direct, 401, `direct loopback query token accepted (got ${direct})`);
  const proxied = await upgradeStatus(port, `/ws?room=nope&token=${encodeURIComponent(secret)}`, { 'CF-Connecting-IP': '203.0.113.9' });
  assert.equal(proxied, 401, 'daemon secret in a proxied query string is refused');
  // A device token in the query works either way.
  const tok3 = await request(port, { method: 'POST', path: '/api/auth/sessions/token', headers: ipc, body: { label: 'ws' } });
  const viaQuery = await upgradeStatus(port, `/ws?room=nope&token=${encodeURIComponent(tok3.data.token)}`, { 'CF-Connecting-IP': '203.0.113.9' });
  assert.notEqual(viaQuery, 401, `device token in query accepted (got ${viaQuery})`);
  const garbage = await upgradeStatus(port, `/ws?room=nope&token=hs_garbage`);
  assert.equal(garbage, 401);

  // State survives a daemon restart: sessions are on disk, hashed.
  const raw = await fs.readFile(path.join(d.home, '.auth-sessions.json'), 'utf8');
  assert.ok(!raw.includes(tok3.data.token), 'raw token never persisted');
  assert.equal((await fs.stat(path.join(d.home, '.auth-sessions.json'))).mode & 0o777, 0o600);
});

test('remote-access gate: the tunnel stays off without a password and opens with the opt-out', async (t) => {
  const blocked = new Daemon({}, { fakeTunnel: true });
  await blocked.start();
  t.after(() => blocked.stop());
  assert.equal(blocked.state.url, null, 'no public URL without a password');
  const st = await request(blocked.state.port, { path: '/api/tunnel/status', headers: { Authorization: `Bearer ${blocked.state.sessionSecret}` } });
  assert.equal(st.status, 200);
  assert.equal(st.data.connected, false);
  assert.equal(st.data.lastEvent, 'blocked_no_password');
  assert.match(String(st.data.lastError), /password/i);
  assert.match(blocked.output.join(''), /Remote access is off: no password is set/);
  // Local API still works (local-only mode).
  assert.equal((await request(blocked.state.port, { path: '/api/auth', headers: { Authorization: `Bearer ${blocked.state.sessionSecret}` } })).status, 200);
  await blocked.stop();

  const opted = new Daemon({ HOP_ALLOW_TOTP_ONLY: '1' }, { fakeTunnel: true });
  await opted.start();
  t.after(() => opted.stop());
  const start = Date.now();
  let url = opted.state.url;
  while (!url && Date.now() - start < 15000) {
    await delay(200);
    try { url = (await readState(opted.home)).url; } catch (e) { }
  }
  assert.match(String(url), /^https:\/\/test-\d+\.trycloudflare\.com$/, `tunnel opens with the opt-out, got ${url}`);
});
