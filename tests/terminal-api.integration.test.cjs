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
let daemonEnv;
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

async function launchDaemon(previousState = null) {
  const output = [];
  let exitCode = null;
  const child = spawn(process.execPath, [HOP_BIN, '--daemon'], {
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.once('exit', (code) => { exitCode = code; });
  child.unref();
  daemonPid = child.pid;

  const start = Date.now();
  while (Date.now() - start < 20000) {
    try {
      const next = await readState(hopHome);
      if (next && next.url && (!previousState || next.startTime !== previousState.startTime)) {
        state = next;
        daemonPid = next.pid;
        return;
      }
    } catch (e) {
      // daemon has not written fresh state yet
    }
    if (exitCode !== null) {
      throw new Error(`Hop daemon exited with code ${exitCode}:\n${output.join('')}`);
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for restarted hop state:\n${output.join('')}`);
}

async function startDaemon() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hop-api-test-'));
  hopHome = path.join(tempDir, 'hop_home');
  binDir = path.join(tempDir, 'bin');
  cloudflaredLog = path.join(tempDir, 'cloudflared.log');
  await fs.mkdir(hopHome, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await writeFakeCloudflared(path.join(binDir, 'cloudflared'), cloudflaredLog);

  daemonEnv = {
    ...process.env,
    HOP_HOME: hopHome,
    HOP_NO_TUNNEL: '1',
    PATH: `${binDir}:${process.env.PATH || ''}`,
    CLOUDFLARED_LOG: cloudflaredLog
  };

  await launchDaemon();
}

async function stopDaemon(waitForExit = false) {
  if (!daemonPid) return;
  const stoppedPid = daemonPid;
  try { process.kill(stoppedPid, 'SIGTERM'); } catch (e) {}
  if (waitForExit) {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try {
        process.kill(stoppedPid, 0);
      } catch (e) {
        daemonPid = null;
        return;
      }
      await delay(100);
    }
    throw new Error(`Timed out waiting for hop daemon ${stoppedPid} to stop`);
  }
}

async function stopHayHost() {
  let pid = null;
  try {
    const raw = await fs.readFile(path.join(hopHome, '.hay-host-state'), 'utf8');
    pid = Number(JSON.parse(raw)?.pid);
  } catch (e) {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return; }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      return;
    }
    await delay(100);
  }
  try { process.kill(pid, 'SIGKILL'); } catch (e) {}
}

const agentHeaders = { 'X-Hop-Actor': 'agent' };
const userHeaders = { 'X-Hop-Actor': 'user' };

const before = test.before;
const after = test.after;

before(async () => {
  await startDaemon();
});

after(async () => {
  await stopDaemon(true);
  await stopHayHost();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
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

test('agent session origin survives a daemon restart', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'agent-restart-origin',
    cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);

  const previousState = state;
  await stopDaemon(true);
  await launchDaemon(previousState);

  const sessions = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const restored = sessions.data.sessions.find(s => s.displayName === 'agent-restart-origin');
  assert.ok(restored);
  assert.equal(restored.createdBy, 'agent');
  assert.equal(restored.agentPermitted, true);

  const attached = await requestJson(
    state.port,
    state.sessionSecret,
    'POST',
    '/api/terminals/attach',
    { name: 'agent-restart-origin' },
    agentHeaders
  );
  assert.equal(attached.status, 200);
  const cleanup = await requestJson(
    state.port,
    state.sessionSecret,
    'DELETE',
    `/api/terminals/${attached.data.id}?killSession=true`,
    null,
    agentHeaders
  );
  assert.equal(cleanup.status, 200);
});

test('incremental output endpoint + grid-backed preview', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'prevgrid',
    cwd: tempDir,
    startup: 'echo grid-marker-one',
    autoStart: true
  }, userHeaders);
  assert.equal(create.status, 200);
  await waitForSseEvent(state.port, state.sessionSecret, create.data.id, (payload) => {
    return (payload.type === 'output' || payload.type === 'snapshot')
      && typeof payload.data === 'string' && payload.data.includes('grid-marker-one');
  }, 6000);

  const sessions = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const entry = sessions.data.sessions.find(s => s.displayName === 'prevgrid');
  assert.ok(entry, 'expected prevgrid session listed');

  // Direct host endpoint: /rooms/:id/output hands out a reset tail, then
  // exact deltas from the returned cursor.
  const hostState = JSON.parse(await fs.readFile(path.join(hopHome, '.hay-host-state'), 'utf8'));
  const hostGet = (p) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: hostState.port, path: p, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end();
  });
  const seed = await hostGet(`/rooms/${encodeURIComponent(entry.internalName)}/output`);
  assert.equal(seed.status, 200);
  assert.equal(seed.data.reset, true);
  assert.ok(seed.data.data.includes('grid-marker-one'));
  assert.ok(Number.isInteger(seed.data.cols) && seed.data.cols > 0);
  const idle = await hostGet(`/rooms/${encodeURIComponent(entry.internalName)}/output?since=${seed.data.offset}`);
  assert.equal(idle.status, 200);
  assert.equal(idle.data.reset, false);
  assert.equal(idle.data.data, '');

  // Grid-backed preview: the marker is on screen, and a second poll (the
  // incremental path) must not duplicate screen content.
  const first = await requestJson(state.port, state.sessionSecret, 'GET',
    `/api/sessions/preview?name=${encodeURIComponent(entry.internalName)}`);
  assert.equal(first.status, 200);
  assert.ok(typeof first.data.text === 'string' && first.data.text.includes('grid-marker-one'),
    `expected marker in preview, got: ${JSON.stringify(first.data).slice(0, 300)}`);
  const second = await requestJson(state.port, state.sessionSecret, 'GET',
    `/api/sessions/preview?name=${encodeURIComponent(entry.internalName)}`);
  assert.equal(second.status, 200);
  const countMarks = (t) => t.split('grid-marker-one').length - 1;
  assert.equal(countMarks(second.data.text), countMarks(first.data.text),
    'second (incremental) poll must not duplicate screen content');

  // Serialized screen (fast attach): ANSI repaint of the current screen.
  const screen = await requestJson(state.port, state.sessionSecret, 'GET',
    `/api/sessions/screen?name=${encodeURIComponent(entry.internalName)}`);
  assert.equal(screen.status, 200);
  assert.ok(typeof screen.data.data === 'string' && screen.data.data.includes('grid-marker-one'),
    'expected serialized screen to contain the marker');
  assert.ok(Number.isInteger(screen.data.cols) && screen.data.cols > 0);

  const del = await requestJson(state.port, state.sessionSecret, 'DELETE',
    `/api/terminals/${create.data.id}?killSession=true`, null, userHeaders);
  assert.equal(del.status, 200);
});

// Regression: the recurring "rename is broken" bug, in both of its halves.
//
// Half one — the rename silently reverted. renameSessionDisplayName chose ONE
// layer to write via the workspace-GATED getSavedSessionConfig, while every
// reader (getEffectiveSessionConfig, reconcileRuntimeSessions,
// getSessionDisplayName) consults the UNGATED store first. A session with a
// store entry and no workspace therefore kept its stale name: the new name
// landed only in runtime metadata and the next reconcile tick copied the old
// one back over it, seconds later.
//
// Half two — the revert then MANUFACTURED a second session. The UI connects
// by display name; resolveSessionDisplayName's fallback returned the
// requested name whether or not anything by that name existed (both ternary
// branches were identical), so /ws?room=<new name> created a brand new empty
// session wearing the new name while the real one kept running, unreachable,
// behind the old one. Both names then resolved to the phantom.
test('rename sticks across reconcile ticks and never manufactures a session', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions', {
    name: 'RenameOrigin', type: 'terminal', cwd: tempDir, startRuntime: true
  });
  assert.equal(create.status, 200);

  const renamed = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/rename', {
    oldName: 'RenameOrigin', newName: 'RenameTarget', internalName: 'RenameOrigin'
  });
  assert.equal(renamed.status, 200);

  // Survive several reconcile ticks — the old bug reverted on the first one.
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await delay(1200);
    const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
    const entry = list.data.sessions.find(s => s.internalName === 'RenameOrigin');
    seen.push(entry ? entry.displayName : '(missing)');
  }
  assert.deepEqual(seen, ['RenameTarget', 'RenameTarget', 'RenameTarget', 'RenameTarget'],
    `rename must not revert on a reconcile tick, saw: ${seen.join(' → ')}`);

  // The rename must be addressable by its new name, and must NOT have spawned
  // a second session anywhere.
  const after = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const byTarget = after.data.sessions.filter(s => s.displayName === 'RenameTarget');
  assert.equal(byTarget.length, 1, 'exactly one session may hold the new name');
  assert.equal(byTarget[0].internalName, 'RenameOrigin', 'the ORIGINAL session must be the one wearing it');
  assert.ok(!after.data.sessions.some(s => s.internalName === 'RenameTarget'),
    'no phantom session may be created under the new name');

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete',
    { name: 'RenameTarget', internalName: 'RenameOrigin' });
});

// Regression: connecting by a name nothing owns must REFUSE, not create.
// This is the mechanism that turned a stale rename into a phantom session —
// and it is a hazard on its own: any typo'd or stale room name in a client
// URL silently manufactured an empty shell wearing that name.
test('websocket attach to an unknown session refuses instead of creating one', async () => {
  const WebSocket = require('ws');
  const before = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const beforeCount = before.data.sessions.length;

  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${state.port}/ws?room=NoSuchSessionHere&name=probe`
      + `&token=${state.sessionSecret}&cols=80&rows=24`
    );
    const done = (v) => { try { ws.close(); } catch (e) { /* already closing */ } resolve(v); };
    ws.on('open', () => setTimeout(() => done('opened'), 800));
    ws.on('error', () => done('refused'));
    ws.on('unexpected-response', () => done('refused'));
  });
  assert.equal(outcome, 'refused', 'an unknown room name must not open a session');

  await delay(500);
  const after = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  assert.ok(!after.data.sessions.some(s => s.internalName === 'NoSuchSessionHere'
    || s.displayName === 'NoSuchSessionHere'), 'no session may be manufactured by attaching');
  assert.equal(after.data.sessions.length, beforeCount, 'session count must be unchanged');
});
