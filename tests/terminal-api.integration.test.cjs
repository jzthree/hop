const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const HOP_BIN = path.join(__dirname, '..', 'hop');

let tempDir;
let hopHome;
let binDir;
let cloudflaredLog;
let daemonPid;
let state;

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

async function readState(home) {
  const statePath = path.join(home, '.tunnel-state');
  const data = await fs.readFile(statePath, 'utf8');
  return JSON.parse(data);
}

async function waitForState(home, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = await readState(home);
      if (data && data.url) return data;
    } catch (e) {
      // ignore
    }
    await delay(200);
  }
  throw new Error('Timed out waiting for hop state');
}

function requestJson(port, secret, method, reqPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: `Bearer ${secret}`,
      ...extraHeaders
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestStatus(port, secret, method, reqPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Bearer ${secret}`,
      ...extraHeaders
    };
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers
    }, (res) => {
      const status = res.statusCode;
      res.resume();
      resolve({ status });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForSseEvent(port, secret, terminalId, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${secret}` };
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/terminals/${terminalId}/stream`,
      method: 'GET',
      headers
    }, (res) => {
      let buffer = '';
      const timer = setTimeout(() => {
        req.destroy();
        resolve(null);
      }, timeoutMs);

      res.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);
          if (!block.startsWith('data:')) continue;
          const jsonText = block.replace(/^data:\s*/, '');
          try {
            const payload = JSON.parse(jsonText);
            if (predicate(payload)) {
              clearTimeout(timer);
              req.destroy();
              resolve(payload);
              return;
            }
          } catch (e) {
            // ignore
          }
        }
      });

      res.on('end', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function startDaemon() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hop-api-test-'));
  hopHome = path.join(tempDir, 'hop_home');
  binDir = path.join(tempDir, 'bin');
  cloudflaredLog = path.join(tempDir, 'cloudflared.log');
  await fs.mkdir(hopHome, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await writeFakeCloudflared(path.join(binDir, 'cloudflared'), cloudflaredLog);

  const env = {
    ...process.env,
    HOP_HOME: hopHome,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    CLOUDFLARED_LOG: cloudflaredLog
  };

  const child = spawn(process.execPath, [HOP_BIN, '--daemon'], {
    env,
    stdio: 'ignore',
    detached: true
  });
  child.unref();

  state = await waitForState(hopHome);
  daemonPid = state.pid;
}

async function stopDaemon() {
  if (!daemonPid) return;
  try { process.kill(daemonPid, 'SIGTERM'); } catch (e) {}
}

const agentHeaders = { 'X-Hop-Actor': 'agent' };
const userHeaders = { 'X-Hop-Actor': 'user' };

const before = test.before;
const after = test.after;

before(async () => {
  await startDaemon();
});

after(async () => {
  await stopDaemon();
});

test('agent terminal create + stream', async () => {
  const res = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'agent1',
    cwd: tempDir,
    startup: 'echo agent-start',
    autoStart: true
  }, agentHeaders);
  assert.equal(res.status, 200);
  assert.ok(res.data?.id);

  const event = await waitForSseEvent(state.port, state.sessionSecret, res.data.id, (payload) => {
    return payload.type === 'output' || payload.type === 'snapshot';
  });
  assert.ok(event, 'expected terminal stream output');

  const sessions = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const entry = sessions.data.sessions.find(s => s.displayName === 'agent1');
  assert.ok(entry);
  assert.equal(entry.createdBy, 'agent');
  assert.equal(entry.agentPermitted, true);
});

test('agent attach denied until permitted', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'user1',
    cwd: tempDir
  }, userHeaders);
  assert.equal(create.status, 200);

  const attachDenied = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals/attach', {
    name: 'user1'
  }, agentHeaders);
  assert.equal(attachDenied.status, 403);

  const sessions = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const userSession = sessions.data.sessions.find(s => s.displayName === 'user1');
  assert.ok(userSession);

  const permit = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/agent-permission', {
    internalName: userSession.internalName,
    allowed: true
  });
  assert.equal(permit.status, 200);

  const attachOk = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals/attach', {
    name: 'user1'
  }, agentHeaders);
  assert.equal(attachOk.status, 200);
  const terminalId = attachOk.data.id;

  const writeRes = await requestJson(state.port, state.sessionSecret, 'POST', `/api/terminals/${terminalId}/write`, {
    data: 'echo hello\n'
  }, agentHeaders);
  assert.equal(writeRes.status, 200);

  const resizeRes = await requestJson(state.port, state.sessionSecret, 'POST', `/api/terminals/${terminalId}/resize`, {
    cols: 100,
    rows: 40
  }, agentHeaders);
  assert.equal(resizeRes.status, 200);

  const outputEvent = await waitForSseEvent(state.port, state.sessionSecret, terminalId, (payload) => {
    return payload.type === 'output' && typeof payload.data === 'string' && payload.data.includes('hello');
  }, 5000);
  assert.ok(outputEvent, 'expected output from terminal');

  const delRes = await requestJson(state.port, state.sessionSecret, 'DELETE', `/api/terminals/${terminalId}`);
  assert.equal(delRes.status, 200);
});

test('agent cannot list or stream user terminal when not permitted', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'user-private-observe-denied',
    cwd: tempDir
  }, userHeaders);
  assert.equal(create.status, 200);
  const terminalId = create.data.id;

  const listAsAgent = await requestJson(state.port, state.sessionSecret, 'GET', '/api/terminals', null, agentHeaders);
  assert.equal(listAsAgent.status, 200);
  const listedIds = (listAsAgent.data?.terminals || []).map((entry) => entry.id);
  assert.ok(!listedIds.includes(terminalId));

  const streamAsAgent = await requestStatus(
    state.port,
    state.sessionSecret,
    'GET',
    `/api/terminals/${terminalId}/stream`,
    agentHeaders
  );
  assert.equal(streamAsAgent.status, 403);

  const cleanup = await requestJson(state.port, state.sessionSecret, 'DELETE', `/api/terminals/${terminalId}?killSession=true`, null, userHeaders);
  assert.equal(cleanup.status, 200);
});
