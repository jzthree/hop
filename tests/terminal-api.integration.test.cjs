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
  // An inert `claude`: the fork test relaunches a recorded conversation, and
  // the real binary must never start inside a test harness.
  await fs.writeFile(path.join(binDir, 'claude'),
    '#!/usr/bin/env bash\necho "stub claude: $@"\n', { mode: 0o755 });
  await fs.writeFile(path.join(binDir, 'codex'),
    '#!/usr/bin/env bash\necho "stub codex: $@"\n', { mode: 0o755 });

  daemonEnv = {
    ...process.env,
    HOP_HOME: hopHome,
    HOP_NO_TUNNEL: '1',
    HOP_NO_UPDATE_CHECK: '1',
    // Never the real ~/.codex: tests plant their own rollouts here.
    CODEX_HOME: path.join(tempDir, 'codex_home'),
    // …nor the real ~/.gemini (agy's hooks and conversations), nor the real
    // agy: a session's login shell finds ~/.local/bin/agy before binDir.
    HOP_GEMINI_HOME: path.join(tempDir, 'gemini_home'),
    HOP_AGY_BIN: path.join(binDir, 'agy'),
    // A session's login shell puts the real claude and codex first on PATH
    // too: forks and Continue-in launch these stand-ins by full path.
    HOP_CLAUDE_BIN: path.join(binDir, 'claude'),
    HOP_CODEX_BIN: path.join(binDir, 'codex'),
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

test('with agent access permitted by default, your new sessions admit agents until blocked', async () => {
  const cfgPath = path.join(hopHome, '.config.json');
  const before = await fs.readFile(cfgPath, 'utf8').catch(() => null);
  await fs.writeFile(cfgPath, JSON.stringify({ ...(before ? JSON.parse(before) : {}), agent_access_default: 'permit' }), { mode: 0o600 });
  await delay(3200); // the daemon re-reads the default every few seconds
  try {
    const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
      name: 'opendefault', cwd: tempDir
    }, userHeaders);
    assert.equal(create.status, 200);
    const internal = create.data.sessionName;
    const sessions = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
    const entry = sessions.data.sessions.find((x) => x.internalName === internal);
    assert.equal(entry?.createdBy, 'user');
    assert.equal(entry?.agentPermitted, true);
    const attach = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals/attach', { name: 'opendefault' }, agentHeaders);
    assert.equal(attach.status, 200, JSON.stringify(attach.data));
    await requestJson(state.port, state.sessionSecret, 'DELETE', `/api/terminals/${attach.data.id}`);

    const block = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/agent-permission', { internalName: internal, allowed: false });
    assert.equal(block.status, 200);
    const denied = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals/attach', { name: 'opendefault' }, agentHeaders);
    assert.equal(denied.status, 403, 'a session you block stays blocked');
    await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: internal, internalName: internal });
  } finally {
    if (before === null) await fs.rm(cfgPath, { force: true });
    else await fs.writeFile(cfgPath, before, { mode: 0o600 });
    await delay(3200);
  }
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

test('a permission you set on a session survives a daemon restart', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'permit-restart', cwd: tempDir
  }, userHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;
  const permit = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/agent-permission', { internalName: internal, allowed: true });
  assert.equal(permit.status, 200);
  const meta = JSON.parse(await fs.readFile(path.join(hopHome, 'claude-sessions', `${internal}.meta`), 'utf8'));
  assert.equal(meta.agentPermitted, true, 'the answer is kept in the session record');

  const previousState = state;
  await stopDaemon(true);
  await launchDaemon(previousState);
  const sessions = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  assert.equal(sessions.data.sessions.find((x) => x.internalName === internal)?.agentPermitted, true);
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: internal, internalName: internal });
});

test('search finds a conversation line behind megabytes of tool output, and a new turn at once', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name: 'deepsearch', cwd: tempDir }, userHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;
  const sessionId = '33333333-4444-5555-6666-777777777777';
  const configDir = path.join(tempDir, 'claude-cfg');
  const pdir = path.join(configDir, 'projects', tempDir.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(pdir, { recursive: true });
  const tfile = path.join(pdir, `${sessionId}.jsonl`);
  const line = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';
  await fs.writeFile(tfile, line('we settled on the quartzlantern plan') + JSON.stringify({ type: 'user', toolUseResult: 'x'.repeat(3 * 1024 * 1024) }) + '\n' + line('later chatter'));
  await fs.writeFile(path.join(hopHome, 'claude-sessions', `${internal}.json`), JSON.stringify({
    sessionId, cwd: tempDir, configDir, launchCmd: 'claude', updatedAt: new Date().toISOString()
  }), { mode: 0o600 });

  const find = async (q) => {
    for (let i = 0; i < 30; i++) {
      const r = await requestJson(state.port, state.sessionSecret, 'GET', `/api/sessions/search?q=${encodeURIComponent(q)}`);
      const hit = (r.data.matches || []).find((m) => m.internalName === internal);
      if (hit) return hit;
      await delay(200); // the older text is loaded in the background
    }
    return null;
  };
  const old = await find('quartzlantern');
  assert.ok(old, 'a line 3 MB back is in the window');
  assert.match(old.snippet, /quartzlantern plan/);

  await fs.appendFile(tfile, line('fresh emberwick turn'));
  const r = await requestJson(state.port, state.sessionSecret, 'GET', `/api/sessions/search?q=emberwick`);
  assert.ok((r.data.matches || []).some((m) => m.internalName === internal), 'an appended turn is found on the next search');

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: internal, internalName: internal });
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
  const hostKey = (await fs.readFile(path.join(hopHome, '.host-token'), 'utf8')).trim();
  const hostGet = (p, headers = { 'x-hop-host-token': hostKey }) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: hostState.port, path: p, method: 'GET', headers }, (res) => {
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
  const originId = create.data.internalName;

  const renamed = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/rename', {
    oldName: 'RenameOrigin', newName: 'RenameTarget', internalName: originId
  });
  assert.equal(renamed.status, 200);

  // Survive several reconcile ticks — the old bug reverted on the first one.
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await delay(1200);
    const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
    const entry = list.data.sessions.find(s => s.internalName === originId);
    seen.push(entry ? entry.displayName : '(missing)');
  }
  assert.deepEqual(seen, ['RenameTarget', 'RenameTarget', 'RenameTarget', 'RenameTarget'],
    `rename must not revert on a reconcile tick, saw: ${seen.join(' → ')}`);

  // The rename must be addressable by its new name, and must NOT have spawned
  // a second session anywhere.
  const after = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const byTarget = after.data.sessions.filter(s => s.displayName === 'RenameTarget');
  assert.equal(byTarget.length, 1, 'exactly one session may hold the new name');
  assert.equal(byTarget[0].internalName, originId, 'the ORIGINAL session must be the one wearing it');
  assert.ok(!after.data.sessions.some(s => s.displayName === 'RenameOrigin'),
    'no phantom session may be created under the old name');

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete',
    { name: 'RenameTarget', internalName: originId });
});

// Regression: connecting by a name nothing owns must REFUSE, not create.
// This is the mechanism that turned a stale rename into a phantom session —
// and it is a hazard on its own: any typo'd or stale room name in a client
// URL silently manufactured an empty shell wearing that name.
test('websocket attach to an unknown session refuses instead of creating one', async () => {
  const WebSocket = require('ws');
  const before = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const beforeNames = new Set(before.data.sessions.map(s => s.internalName));

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
  // Nothing NEW may appear. Not a strict count: an earlier test's short-lived
  // session can be reaped inside this window, and its exit is not this
  // regression — a manufactured session is.
  const appeared = after.data.sessions.filter(s => !beforeNames.has(s.internalName));
  assert.deepEqual(appeared.map(s => s.internalName), [], 'no session may appear during a refused attach');
});

// Regression: a name a session USED to have must be reusable.
//
// isDisplayNameInUse resolved the candidate through the alias map, so after
// rename A→B→C the alias B→C still pointed at a live session and "B" read as
// taken forever — while nothing displayed it. Renaming anything to B failed
// with 409 "Session name already in use", with no way to free the name short
// of restarting the daemon.
test('a display name freed by a later rename can be reused', async () => {
  const one = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions',
    { name: 'AliasOne', type: 'terminal', cwd: tempDir, startRuntime: true });
  const two = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions',
    { name: 'AliasTwo', type: 'terminal', cwd: tempDir, startRuntime: true });
  const oneId = one.data.internalName;
  const twoId = two.data.internalName;
  await delay(600);

  // AliasOne: Freed → Final, leaving the alias "Freed" behind.
  for (const [from, to] of [['AliasOne', 'Freed'], ['Freed', 'Final']]) {
    const r = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/rename',
      { oldName: from, newName: to, internalName: oneId });
    assert.equal(r.status, 200, `rename ${from}→${to} failed: ${JSON.stringify(r.data)}`);
  }

  // "Freed" is now worn by nobody, so another session may take it.
  const reuse = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/rename',
    { oldName: 'AliasTwo', newName: 'Freed', internalName: twoId });
  assert.equal(reuse.status, 200, `a freed name must be reusable, got: ${JSON.stringify(reuse.data)}`);

  const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const freed = list.data.sessions.filter(s => s.displayName === 'Freed');
  assert.equal(freed.length, 1, 'exactly one session may wear the reused name');
  assert.equal(freed[0].internalName, twoId);

  // A name a LIVE session still wears stays protected.
  const collide = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/rename',
    { oldName: 'Final', newName: 'Freed', internalName: oneId });
  assert.equal(collide.status, 409, 'a name in active use must still be refused');

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: 'Final', internalName: oneId });
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: 'Freed', internalName: twoId });
});

// Regression: folder membership must survive every cache rebuild. The store
// entry is a CACHE any path may recreate without folderId (restore's fresh
// session definitions did exactly that), and buildSessionEntries' store loop
// read that raw cache — clobbering the correct value the durable meta (and
// the live-rooms loop) already knew. Nine of eleven folder assignments
// vanished from the UI after a host cycle while every meta on disk was right.
test('folder membership survives restore re-registration and a daemon restart', async () => {
  const created = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions',
    { name: 'FolderKeeper', type: 'terminal', cwd: tempDir, startRuntime: true });
  const keeperId = created.data.internalName;
  await delay(600);
  const folder = await requestJson(state.port, state.sessionSecret, 'POST', '/api/folders', { name: 'KeeperShelf' });
  assert.equal(folder.status, 200, `folder create failed: ${JSON.stringify(folder.data)}`);
  const folderId = folder.data.folder.id;
  const moved = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/move',
    { name: 'FolderKeeper', folderId });
  assert.equal(moved.status, 200, `move failed: ${JSON.stringify(moved.data)}`);

  const listedNow = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  assert.equal(listedNow.data.sessions.find(s => s.internalName === keeperId)?.folderId, folderId,
    'freshly moved session must list its folder');

  // Restore re-registration recreates cached session definitions — the write
  // that used to outrank the durable meta in the listing.
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/restore', {});
  await delay(1200);
  const afterRestore = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  assert.equal(afterRestore.data.sessions.find(s => s.internalName === keeperId)?.folderId, folderId,
    'folder membership must survive restore re-registration');

  const previousState = state;
  await stopDaemon(true);
  await launchDaemon(previousState);
  const afterRestart = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  assert.equal(afterRestart.data.sessions.find(s => s.internalName === keeperId)?.folderId, folderId,
    'folder membership must survive a daemon restart');

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: 'FolderKeeper', internalName: keeperId });
});

// Session names resolve case-insensitively everywhere a name addresses a
// session: exact-case wearers win, a UNIQUE folded match resolves, and two
// sessions differing only by case stay exact-only rather than guessed at.
test('session names resolve case-insensitively', async () => {
  const caseCreate = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions',
    { name: 'CaseFold', type: 'terminal', cwd: tempDir, startRuntime: true });
  const caseId = caseCreate.data.internalName;
  await delay(600);

  // A by-name API call accepts any casing — no internalName hint given.
  const renamed = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/rename',
    { oldName: 'casefold', newName: 'CaseKept' });
  assert.equal(renamed.status, 200, `lowercase lookup must find CaseFold: ${JSON.stringify(renamed.data)}`);

  // Changing ONLY the casing of your own name is not a collision.
  const caseOnly = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/rename',
    { oldName: 'CaseKept', newName: 'casekept' });
  assert.equal(caseOnly.status, 200, `case-only rename must be allowed: ${JSON.stringify(caseOnly.data)}`);

  const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const worn = list.data.sessions.filter(s => s.internalName === caseId);
  assert.equal(worn.length, 1, 'still exactly one session — folded lookups must never mint twins');
  assert.equal(worn[0].displayName, 'casekept', 'the case-only rename is the worn spelling');

  // A name another session wears — in ANY casing — is a collision.
  const other = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions',
    { name: 'CaseOther', type: 'terminal', cwd: tempDir, startRuntime: true });
  await delay(400);
  const collide = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/rename',
    { oldName: 'CaseOther', newName: 'CASEKEPT', internalName: other.data.internalName });
  assert.equal(collide.status, 409, 'a differently-cased spelling of a worn name must be refused');

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: 'casekept', internalName: caseId });
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: 'CaseOther', internalName: other.data.internalName });
});

// Taking a thread back from the Codex app quits the app, so the endpoint
// must refuse anything that is not a session with a recorded Codex
// conversation before it touches the app.
test('take-from-Codex-app refuses a session with no Codex conversation', async () => {
  const missing = await requestJson(state.port, state.sessionSecret, 'POST', '/api/codex/take', { internalName: 'no-such-session' });
  assert.equal(missing.status, 404);
  const plain = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions',
    { name: 'TakePlain', type: 'terminal', cwd: tempDir, startRuntime: true });
  await delay(400);
  const refused = await requestJson(state.port, state.sessionSecret, 'POST', '/api/codex/take', { internalName: plain.data.internalName });
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.match(refused.data.error, /No Codex conversation/);
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: 'TakePlain', internalName: plain.data.internalName });
});

// Regression: an undeclared Bearer-token creation is automation, not a human.
// Agents' raw scripts rarely remember x-hop-actor, and every one that forgot
// landed its sessions in the USER tab (SelectProbe). Cookie-auth (the web UI)
// and the hop CLI's via stamp still default to user; explicit headers win.
test('bare token API creations default to agent origin', async () => {
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions',
    { name: 'BareTokenProbe', type: 'terminal', cwd: tempDir, startRuntime: true });
  await delay(400);
  const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const s = list.data.sessions.find(x => x.displayName === 'BareTokenProbe');
  assert.ok(s, 'session exists');
  assert.equal(s.createdBy, 'agent', `undeclared token caller must be agent, got ${s.createdBy}`);

  // The hop CLI's own via stamp keeps humans human.
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions',
    { name: 'CliUserProbe', type: 'terminal', cwd: tempDir, startRuntime: true },
    { 'X-Hop-Via': 'cli' });
  await delay(400);
  const list2 = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const s2 = list2.data.sessions.find(x => x.displayName === 'CliUserProbe');
  assert.equal(s2 && s2.createdBy, 'user', 'CLI-stamped caller stays user');

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: 'BareTokenProbe', internalName: 'BareTokenProbe' });
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: 'CliUserProbe', internalName: 'CliUserProbe' });
});

// An agent attach with no API activity and no open stream must expire — a
// crashed or forgetful agent otherwise parks an "agent" in the session's
// presence forever. Needs a daemon with a short TTL, so this test relaunches
// (declaration order puts it last; nothing later depends on daemon state).
test('an idle agent terminal attach is reaped after the TTL', async () => {
  const previousState = state;
  daemonEnv = {
    ...daemonEnv,
    HOP_TERMINAL_API_IDLE_TTL_MS: '1500',
    HOP_TERMINAL_API_SWEEP_MS: '300'
  };
  await stopDaemon(true);
  await launchDaemon(previousState);

  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'idle-agent-probe',
    cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);
  const terminalId = create.data.id;

  const listed = await requestJson(state.port, state.sessionSecret, 'GET', '/api/terminals', null, agentHeaders);
  assert.ok(listed.data.terminals.some(t => t.id === terminalId), 'attach visible before the TTL');

  // Touches reset the clock: keep it alive past one full TTL with writes.
  await delay(1000);
  await requestJson(state.port, state.sessionSecret, 'POST', `/api/terminals/${terminalId}/write`,
    { data: ' ' }, agentHeaders);
  await delay(1000);
  const alive = await requestJson(state.port, state.sessionSecret, 'GET', '/api/terminals', null, agentHeaders);
  assert.ok(alive.data.terminals.some(t => t.id === terminalId), 'touched attach survives past a TTL of idle-from-create');

  // Now go silent: the sweep must detach it (session itself stays alive).
  await delay(2500);
  const after = await requestJson(state.port, state.sessionSecret, 'GET', '/api/terminals', null, agentHeaders);
  assert.ok(!after.data.terminals.some(t => t.id === terminalId), 'idle attach reaped');
  const sessions = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const s = sessions.data.sessions.find(x => x.displayName === 'idle-agent-probe');
  assert.ok(s, 'the session itself outlives its reaped attach');
  const clients = Number(s.clientCount) || 0;
  assert.equal(clients, 0, `reap must detach the room client, got clientCount=${clients}`);

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete',
    { name: 'idle-agent-probe', internalName: s.internalName });
});

// Dropping a file into the web terminal uploads its BYTES (a browser never
// reveals the real path) and hands back a host path the session can open.
// The filename is attacker-shaped input on its way to becoming a path.
function requestUpload(port, secret, reqPath, buffer) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }); }
        catch (e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.end(buffer);
  });
}

test('a dropped file uploads to host staging and never escapes it', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'upload-probe',
    cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);
  const session = create.data.sessionName;

  // Every byte value, so a text-mode body handler would visibly corrupt it.
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const up = await requestUpload(
    state.port, state.sessionSecret,
    `/api/sessions/upload?name=${encodeURIComponent(session)}&filename=shot.png`,
    bytes
  );
  assert.equal(up.status, 200);
  assert.ok(up.data.path, 'returns the host path');
  const landed = await fs.readFile(up.data.path);
  assert.ok(landed.equals(bytes), 'bytes survive the round trip unmodified');
  assert.equal(path.basename(up.data.path), 'shot.png');
  assert.ok(up.data.path.startsWith(path.join(hopHome, 'uploads')),
    `staged under HOP_HOME/uploads, got ${up.data.path}`);

  // A second drop of the same name is a second file, not an overwrite.
  const again = await requestUpload(
    state.port, state.sessionSecret,
    `/api/sessions/upload?name=${encodeURIComponent(session)}&filename=shot.png`,
    Buffer.from('second')
  );
  assert.equal(again.status, 200);
  assert.notEqual(again.data.path, up.data.path, 'collision gets its own path');
  assert.ok((await fs.readFile(up.data.path)).equals(bytes), 'first upload untouched');

  // Traversal in the filename must collapse to a basename inside staging.
  const evil = await requestUpload(
    state.port, state.sessionSecret,
    `/api/sessions/upload?name=${encodeURIComponent(session)}&filename=${encodeURIComponent('../../../../etc/hop-pwned')}`,
    Buffer.from('nope')
  );
  assert.equal(evil.status, 200);
  assert.ok(evil.data.path.startsWith(path.join(hopHome, 'uploads')),
    `traversal stayed in staging, got ${evil.data.path}`);
  assert.equal(path.basename(evil.data.path), 'hop-pwned');

  // An unknown session is not a place to write files.
  const nowhere = await requestUpload(
    state.port, state.sessionSecret,
    '/api/sessions/upload?name=no-such-session-here&filename=x.txt',
    Buffer.from('x')
  );
  assert.equal(nowhere.status, 404);

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete',
    { name: 'upload-probe', internalName: session });
});


// Fork must never send a session to live among the transcripts: the hook's
// record is the preferred cwd source (claude --resume runs where the
// conversation lives) but also the most clobber-prone, and a value inside
// ~/.claude*/projects/* is never a real workspace.
test('fork falls past a poisoned record cwd to the durable one', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'forksrc',
    cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;

  // A poisoned hook record: right conversation, transcript-store cwd.
  await fs.mkdir(path.join(hopHome, 'claude-sessions'), { recursive: true });
  await fs.writeFile(path.join(hopHome, 'claude-sessions', `${internal}.json`), JSON.stringify({
    sessionId: '11111111-2222-3333-4444-555555555555',
    cwd: path.join(os.homedir(), '.claude', 'projects', '-Users-test-project'),
    launchCmd: 'claude',
    updatedAt: new Date().toISOString()
  }), { mode: 0o600 });

  const fork = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/fork', {
    internalName: internal
  });
  assert.equal(fork.status, 200);
  assert.equal(fork.data.kind, 'claude', 'the record still drives a claude-resume fork');

  await delay(600);
  const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const forked = list.data.sessions.find(s => s.internalName === fork.data.internalName);
  assert.ok(forked, 'fork exists');
  assert.equal(forked.cwd, tempDir,
    `fork must inherit the session's real cwd, got ${forked.cwd}`);

  for (const name of [internal, fork.data.internalName]) {
    await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete',
      { name, internalName: name });
  }
});


// A Stop & parked session has no room and its saved definition lives only in
// memory, so after a daemon restart only its durable record remains. It must
// still be LISTED — parked and stopped — or the wall's parked section and
// search lose it while opening it would still resume the conversation.
test('a stopped & parked session known only from its record is listed, parked', async () => {
  const name = 'parkedonlyrecord';
  await fs.mkdir(path.join(hopHome, 'claude-sessions'), { recursive: true });
  await fs.writeFile(path.join(hopHome, 'claude-sessions', `${name}.meta`), JSON.stringify({
    internalName: name, displayName: 'lightscope-probe', cwd: tempDir, createdBy: 'user', parked: true, archived: true
  }), { mode: 0o600 });
  try {
    const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
    const hit = list.data.sessions.find((s) => s.internalName === name);
    assert.ok(hit, 'the stopped session is in the list');
    assert.equal(hit.displayName, 'lightscope-probe');
    assert.equal(hit.parked, true);
    assert.equal(hit.archived, true);
    assert.equal(hit.live, false);
  } finally {
    await fs.rm(path.join(hopHome, 'claude-sessions', `${name}.meta`), { force: true });
  }
});

// Recently closed lists what stopped running — never what runs. A host too
// busy to answer (memory pressure, 2026-11-11) once read as "no sessions at
// all", and every running session landed in Recently closed; Bring back on
// one of those could tear a live room down to relaunch it.
test('a host that does not answer is no news: nothing running is closed, and bring back leaves a running session alone', async () => {
  const S = (method, p, body) => requestJson(state.port, state.sessionSecret, method, p, body, userHeaders);
  const create = await S('POST', '/api/sessions', { name: 'stallprobe', type: 'terminal', cwd: tempDir, startRuntime: true });
  assert.equal(create.status, 200);
  const internal = create.data.internalName;
  const created = [internal];
  let hostPid = null;
  try {
    // Listed as closed while it runs (as the stall did): a restart reads it.
    const previousState = state;
    await stopDaemon(true);
    await fs.writeFile(path.join(hopHome, 'recently-closed.json'), JSON.stringify({
      version: 1, closed: [{ internalName: internal, displayName: 'stallprobe', cwd: tempDir, closedAt: Date.now(), how: 'ended', records: {} }]
    }), { mode: 0o600 });
    await launchDaemon(previousState);
    const closed = await S('GET', '/api/sessions/closed');
    assert.ok(!closed.data.closed.some((c) => c.internalName === internal), 'a running session is not closed');
    const back = await S('POST', '/api/sessions/bring-back', { internalName: internal });
    assert.equal(back.status, 409);
    assert.equal(back.data.running, true);
    const live = await S('GET', '/api/sessions');
    assert.equal(live.data.sessions.find((s) => s.internalName === internal)?.live, true, 'still the same live room');
    const stored = JSON.parse(await fs.readFile(path.join(hopHome, 'recently-closed.json'), 'utf8'));
    assert.ok(!stored.closed.some((c) => c.internalName === internal), 'and the stray row is gone');

    // A kill is listed at once.
    await S('POST', '/api/sessions/delete', { name: internal, internalName: internal });
    const killed = await S('GET', '/api/sessions/closed');
    assert.ok(killed.data.closed.some((c) => c.internalName === internal && c.how === 'killed'), 'a kill is listed');
    const again = await S('POST', '/api/sessions', { name: 'stallprobe2', type: 'terminal', cwd: tempDir, startRuntime: true });
    assert.equal(again.status, 200);
    created.push(again.data.internalName);

    // The host stops answering for a few seconds: unknown, not empty.
    hostPid = Number(JSON.parse(await fs.readFile(path.join(hopHome, '.hay-host-state'), 'utf8')).pid);
    process.kill(hostPid, 'SIGSTOP');
    await delay(400);
    const stalled = await S('GET', '/api/sessions');
    assert.equal(stalled.data.runtimeAvailable, false, 'no answer is not "nothing runs"');
    process.kill(hostPid, 'SIGCONT');
    hostPid = null;
    let recovered = null;
    for (let i = 0; i < 40 && !recovered?.data?.runtimeAvailable; i++) {
      if (i) await delay(250);
      recovered = await S('GET', '/api/sessions');
    }
    assert.equal(recovered.data.runtimeAvailable, true, 'answers again once the host does');
    assert.equal(recovered.data.sessions.find((s) => s.internalName === created[1])?.live, true);
  } finally {
    if (hostPid) try { process.kill(hostPid, 'SIGCONT'); } catch (e) { /* gone */ }
    for (const n of created) {
      await S('POST', '/api/sessions/delete', { name: n, internalName: n });
      await S('POST', '/api/sessions/closed/forget', { internalName: n });
    }
  }
});


// `hop view --nebula`: a notebook on a Nebula server becomes a LINK that
// opens in the Nebula UI this machine reaches. A relative path is pinned to
// the server's working directory, and a notebook the server doesn't have is
// refused rather than filed as a dead link.
test('hop view --nebula files a link to the notebook on its Nebula server', async () => {
  const { execFile } = require('node:child_process');
  const nebula = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/api/health') return res.end(JSON.stringify({ status: 'ok', cwd: '/srv/lab' }));
    if (u.pathname === '/api/fs/file-mtime') {
      if (u.searchParams.get('path') === '/srv/lab/runs/fit.ipynb') return res.end(JSON.stringify({ mtime: 1 }));
      res.statusCode = 404; return res.end(JSON.stringify({ detail: 'File not found' }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => nebula.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${nebula.address().port}`;
  const run = (args) => new Promise((resolve) => execFile(process.execPath,
    [path.join(__dirname, '..', 'hop'), 'view', '--session', 'nebulaprobe', ...args],
    { env: daemonEnv, timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })));
  try {
    const ok = await run(['--nebula', '--nebula-url', base, '--title', 'Fit results', 'runs/fit.ipynb']);
    assert.equal(ok.code, 0, ok.out);
    const want = `${base}/?file=${encodeURIComponent('/srv/lab/runs/fit.ipynb')}`;
    assert.ok(ok.out.includes(`View: ${want}`), ok.out);

    const missing = await run(['--nebula', '--nebula-url', base, 'runs/gone.ipynb']);
    assert.notEqual(missing.code, 0);
    assert.match(missing.out, /no notebook at \/srv\/lab\/runs\/gone\.ipynb/);

    const views = await requestJson(state.port, state.sessionSecret, 'GET', '/api/views');
    const mine = views.data.items.filter((i) => i.session === 'nebulaprobe');
    assert.equal(mine.length, 1, JSON.stringify(mine));
    assert.equal(mine[0].kind, 'link');
    assert.equal(mine[0].app, 'nebula');
    assert.equal(mine[0].title, 'Fit results');
    assert.equal(mine[0].target, want);
  } finally {
    nebula.close();
    await fs.rm(path.join(hopHome, 'views', 'nebulaprobe'), { recursive: true, force: true });
  }
});


// A view the browser cannot display (pptx, zip) is saved instead of shown.
// Opening it must still name the file — without a Content-Disposition name
// the browser took the URL's last segment and every download read "inline".
test('a view keeps its file name when opened, downloaded or range-read', async () => {
  const dir = path.join(hopHome, 'views', 'nameprobe');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'deck v2.pptx'), Buffer.alloc(64, 1));
  const head = (reqPath, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: state.port, path: reqPath, method: 'GET',
      headers: { Authorization: `Bearer ${state.sessionSecret}`, ...extra } }, (res) => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
  const base = '/view/nameprobe/' + encodeURIComponent('deck v2.pptx');
  const opened = await head(base + '/inline');
  assert.equal(opened.status, 200);
  assert.match(opened.headers['content-disposition'] || '', /^inline;.*filename\*=UTF-8''deck%20v2\.pptx/);
  const saved = await head(base + '/download');
  assert.match(saved.headers['content-disposition'] || '', /^attachment;.*filename="deck v2\.pptx"/);
  const ranged = await head(base + '/inline', { Range: 'bytes=0-9' });
  assert.equal(ranged.status, 206);
  assert.match(ranged.headers['content-disposition'] || '', /deck%20v2\.pptx/);
  await fs.rm(dir, { recursive: true, force: true });
});


// "Continue in fresh Claude": the same agent, started over from the
// condensed trajectory instead of resuming the full history. The new session
// runs the SOURCE's claude launch (a fake one here, so no real agent starts)
// with the prompt to read the extract first.
test('condense into the same agent hands off the trajectory to a fresh session', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'condensesrc',
    cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;

  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const configDir = path.join(tempDir, 'claude-cfg');
  const projectDir = path.join(configDir, 'projects', tempDir.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, `${sessionId}.jsonl`), [
    { type: 'user', timestamp: '2026-10-13T10:00:00Z', message: { role: 'user', content: 'tune the scroll pacing' } },
    { type: 'assistant', timestamp: '2026-10-13T10:00:05Z', message: { content: [{ type: 'text', text: 'Batched output to one message per redraw.' }] } }
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const argvFile = path.join(tempDir, 'fake-claude-argv.txt');
  const fakeClaude = path.join(tempDir, 'claude-fake');
  await fs.writeFile(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nsleep 30\n`, { mode: 0o755 });
  await fs.mkdir(path.join(hopHome, 'claude-sessions'), { recursive: true });
  await fs.writeFile(path.join(hopHome, 'claude-sessions', `${internal}.json`), JSON.stringify({
    sessionId, cwd: tempDir, configDir, launchCmd: `${fakeClaude} --model opus`,
    updatedAt: new Date().toISOString()
  }), { mode: 0o600 });

  const fresh = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/fork', {
    internalName: internal, target: 'claude', condense: true
  });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal(fresh.data.kind, 'handoff');
  assert.match(fresh.data.name, /^condensesrc-cont\d*$/);
  assert.equal(fresh.data.extract.turns, 1);
  const extract = await fs.readFile(fresh.data.extract.path, 'utf8');
  assert.match(extract, /tune the scroll pacing/);

  let argv = '';
  for (let i = 0; i < 40 && !argv; i++) {
    await delay(150);
    argv = await fs.readFile(argvFile, 'utf8').catch(() => '');
  }
  assert.match(argv, /^--model\nopus\n/, `the source's own claude launch, got ${JSON.stringify(argv)}`);
  assert.ok(argv.includes(fresh.data.extract.path), 'the prompt names the extract');

  const plain = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/fork', {
    internalName: internal, target: 'claude'
  });
  assert.equal(plain.status, 200);
  assert.equal(plain.data.kind, 'claude', 'without condense, the same agent is a conversation fork');


  for (const name of [internal, plain.data.internalName, fresh.data.internalName]) {
    await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete',
      { name, internalName: name });
  }
});


// A session continued from the Codex app used to carry the thread's title
// verbatim ("Find grant opportunities and draft") — spaces a session name
// may not hold, so renaming it and Continue-in both failed. Such a session
// can still be renamed by its internal name and forked under a valid name.
test('a session whose display name has spaces can be renamed and forked', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'spacedsrc',
    cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;
  const metaPath = path.join(hopHome, 'claude-sessions', `${internal}.meta`);
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8').catch(() => '{}'));
  await fs.writeFile(metaPath, JSON.stringify({ ...meta, internalName: internal, displayName: 'Find grant opportunities' }), { mode: 0o600 });
  await fs.writeFile(path.join(hopHome, 'claude-sessions', `${internal}.json`), JSON.stringify({
    sessionId: '22222222-3333-4444-5555-666666666666', cwd: tempDir, launchCmd: 'claude',
    updatedAt: new Date().toISOString()
  }), { mode: 0o600 });

  const before = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  assert.equal(before.data.sessions.find((s) => s.internalName === internal)?.displayName, 'Find grant opportunities');

  const fork = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/fork', {
    internalName: internal
  });
  assert.equal(fork.status, 200, JSON.stringify(fork.data));
  assert.match(fork.data.internalName, /^s_[0-9a-f]{10}$/, 'a fork gets an opaque id, not its (possibly long) name');

  const rename = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/rename', {
    oldName: 'Find grant opportunities', newName: 'grant-search', internalName: internal
  });
  assert.equal(rename.status, 200, JSON.stringify(rename.data));

  for (const name of [internal, fork.data.internalName]) {
    await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete',
      { name, internalName: name });
  }
});


// The host cuts room ids to 32 characters. A record filed under a longer
// name belongs to the room with the cut name, and while that room runs,
// restore must not plan the record as a dead session.
test('restore does not take a long-named record for dead while its cut room runs', async () => {
  const dir = path.join(hopHome, 'claude-sessions');
  await fs.mkdir(dir, { recursive: true });
  const cut = 'longnamerecordcheck-abcdefghijkl'; // 32 characters
  const long = cut + '-continued';
  assert.equal(cut.length, 32);
  await fs.writeFile(path.join(dir, `${cut}.meta`), JSON.stringify({ internalName: cut, cwd: tempDir }), { mode: 0o600 });
  const up = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/restore', { only: [cut] });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  let running = false;
  for (let i = 0; i < 40 && !running; i++) {
    const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
    running = !!list.data.sessions.find((x) => x.internalName === cut && x.live !== false);
    if (!running) await delay(150);
  }
  assert.ok(running, 'the 32-character room is up');

  await fs.writeFile(path.join(dir, `${long}.meta`), JSON.stringify({ internalName: long, displayName: long, cwd: tempDir }), { mode: 0o600 });
  const plan = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/restore', { dryRun: true });
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  const names = (plan.data.restored || []).map((x) => x.name);
  assert.ok(!names.includes(long), `planned the live session again: ${names.join(', ')}`);

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: cut, internalName: cut });
  await fs.rm(path.join(dir, `${long}.meta`), { force: true });
});


// A session continued from the Codex app has no turn record until its first
// turn finishes in hop — and until then Continue-in-Claude refused it as a
// plain shell. Its record names the app thread, and that thread's rollout
// is the conversation to hand off (hop's own fork of it holds only a pointer).
test('a Codex-app session hands off to claude before its first turn in hop', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'codexappsrc',
    cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;
  const threadId = '01a14846-0000-7000-8000-00000000abcd';
  const day = path.join(daemonEnv.CODEX_HOME, 'sessions', '2026', '10', '18');
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(path.join(day, `rollout-2026-10-18T10-00-00-${threadId}.jsonl`), [
    { type: 'session_meta', timestamp: '2026-10-18T10:00:00Z', payload: { id: threadId, cwd: tempDir } },
    { type: 'event_msg', timestamp: '2026-10-18T10:00:01Z', payload: { type: 'user_message', message: 'find grant opportunities for the lab' } },
    { type: 'response_item', timestamp: '2026-10-18T10:00:05Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'NSF MCB fits best.' }] } }
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const metaPath = path.join(hopHome, 'claude-sessions', `${internal}.meta`);
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8').catch(() => '{}'));
  await fs.writeFile(metaPath, JSON.stringify({ ...meta, internalName: internal, fromCodexApp: threadId }), { mode: 0o600 });

  const handoff = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/fork', {
    internalName: internal, target: 'claude'
  });
  assert.equal(handoff.status, 200, JSON.stringify(handoff.data));
  assert.equal(handoff.data.kind, 'handoff');
  const extract = await fs.readFile(handoff.data.extract.path, 'utf8');
  assert.match(extract, /find grant opportunities for the lab/);

  for (const name of [internal, handoff.data.internalName]) {
    await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete',
      { name, internalName: name });
  }
});


// Antigravity (agy) is a full party to Continue-in: its conversation (the
// step log under ~/.gemini/antigravity-cli/brain/<id>/) hands off to claude
// or codex, a claude conversation hands off to a fresh agy (agy -i, hop's
// hooks put in agy's config), and agy's own Fork — it has no native one —
// is a fresh agy that starts from the whole conversation.
test('antigravity conversations continue in any CLI, and any continue in antigravity', async () => {
  const geminiHome = daemonEnv.HOP_GEMINI_HOME;
  const argvFile = path.join(tempDir, 'fake-agy-argv.txt');
  await fs.writeFile(daemonEnv.HOP_AGY_BIN, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nsleep 30\n`, { mode: 0o755 });

  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name: 'agysrc', cwd: tempDir }, agentHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;
  const conv = '0a0b0c0d-1111-2222-3333-444455556666';
  const logs = path.join(geminiHome, 'antigravity-cli', 'brain', conv, '.system_generated', 'logs');
  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(path.join(logs, 'transcript_full.jsonl'), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-11T01:00:00Z', content: '<USER_REQUEST>\nprofile the loader\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-11T01:00:09Z', content: 'Decoding dominates: 70% of the time.' }
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  await fs.mkdir(path.join(hopHome, 'claude-sessions'), { recursive: true });
  await fs.writeFile(path.join(hopHome, 'claude-sessions', `${internal}.agy`), JSON.stringify({
    sessionId: conv, agent: 'antigravity', cwd: tempDir, launchCmd: 'agy --model gemini-x --dangerously-skip-permissions',
    transcriptPath: path.join(logs, 'transcript.jsonl'), updatedAt: new Date().toISOString()
  }), { mode: 0o600 });

  // agy → claude: the step log becomes the document claude reads first.
  const toClaude = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/fork', { internalName: internal, target: 'claude' });
  assert.equal(toClaude.status, 200, JSON.stringify(toClaude.data));
  assert.equal(toClaude.data.kind, 'handoff');
  assert.equal(toClaude.data.target, 'claude');
  assert.match(toClaude.data.name, /^agysrc-claude\d*$/);
  const extract = await fs.readFile(toClaude.data.extract.path, 'utf8');
  assert.match(extract, /# Source tool: antigravity/);
  assert.match(extract, /profile the loader[\s\S]*Decoding dominates/);

  // agy's Fork: a fresh agy from the whole conversation, its launch flags kept.
  const fork = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/fork', { internalName: internal });
  assert.equal(fork.status, 200, JSON.stringify(fork.data));
  assert.equal(fork.data.kind, 'handoff');
  assert.equal(fork.data.target, 'antigravity');
  assert.match(fork.data.name, /^agysrc-fork\d*$/);
  let argv = '';
  for (let i = 0; i < 40 && !argv; i++) { await delay(150); argv = await fs.readFile(argvFile, 'utf8').catch(() => ''); }
  assert.match(argv, /^--model\ngemini-x\n--dangerously-skip-permissions\n-i\nRead the ENTIRE file /, `agy -i with the source's flags, got ${JSON.stringify(argv)}`);
  assert.ok(argv.includes(fork.data.extract.path), 'the prompt names the extract');
  assert.match(argv, /previous Antigravity conversation/);
  // hop's hooks are now in (the test's) agy config, so the fork is restorable.
  const hooks = JSON.parse(await fs.readFile(path.join(geminiHome, 'config', 'hooks.json'), 'utf8'));
  assert.ok(hooks.hop && Array.isArray(hooks.hop.Stop), 'hop hooks installed for agy');

  // claude → agy ("agy" is accepted for antigravity).
  await fs.rm(argvFile, { force: true });
  const claudeSrc = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name: 'claude2agy', cwd: tempDir }, agentHeaders);
  const claudeInternal = claudeSrc.data.sessionName;
  const sessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const configDir = path.join(tempDir, 'claude-cfg-agy');
  const projectDir = path.join(configDir, 'projects', tempDir.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, `${sessionId}.jsonl`), [
    { type: 'user', timestamp: '2026-11-10T10:00:00Z', message: { role: 'user', content: 'shard the eval set' } },
    { type: 'assistant', timestamp: '2026-11-10T10:00:05Z', message: { content: [{ type: 'text', text: 'Eight shards by chromosome.' }] } }
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  await fs.writeFile(path.join(hopHome, 'claude-sessions', `${claudeInternal}.json`), JSON.stringify({
    sessionId, cwd: tempDir, configDir, launchCmd: 'claude', updatedAt: new Date().toISOString()
  }), { mode: 0o600 });
  const toAgy = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/fork', { internalName: claudeInternal, target: 'agy' });
  assert.equal(toAgy.status, 200, JSON.stringify(toAgy.data));
  assert.equal(toAgy.data.target, 'antigravity');
  assert.match(toAgy.data.name, /^claude2agy-antigravity\d*$/);
  argv = '';
  for (let i = 0; i < 40 && !argv; i++) { await delay(150); argv = await fs.readFile(argvFile, 'utf8').catch(() => ''); }
  assert.match(argv, /^-i\nRead the ENTIRE file [\s\S]*previous Claude Code conversation/, `plain agy -i, got ${JSON.stringify(argv)}`);
  assert.match(await fs.readFile(toAgy.data.extract.path, 'utf8'), /shard the eval set/);

  const bad = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/fork', { internalName: internal, target: 'cursor' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /claude, codex, antigravity/);

  for (const name of [internal, toClaude.data.internalName, fork.data.internalName, claudeInternal, toAgy.data.internalName]) {
    await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name, internalName: name });
  }
});


// The briefing generator's coverage signal: the server witnesses who was
// looking at what, and when. Only a HUMAN-viewing attach may stamp it —
// wall tiles are spectators and terminal-api clients are agents.
test('a user attach stamps lastUserSeenAt; a monitor tile does not', async () => {
  const WebSocket = require('ws');
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'seenprobe',
    cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;

  const entryOf = async () => {
    const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
    return list.data.sessions.find(s => s.internalName === internal);
  };

  // The agent-created session: its terminal-api attach must NOT count.
  const before = await entryOf();
  assert.equal(before.userAttached, false, `an agent attach is not the user looking: ${JSON.stringify({u: before.userAttached, l: before.lastUserSeenAt})}`);

  // A monitor tile attaches: still not the user.
  const tile = new WebSocket(`ws://127.0.0.1:${state.port}/ws?room=${internal}&name=wall&source=monitor&replay=0&token=${state.sessionSecret}`);
  await new Promise((r) => tile.on('open', r));
  await delay(300);
  const withTile = await entryOf();
  assert.equal(withTile.userAttached, false, 'a wall tile is a spectator');
  assert.equal(withTile.lastUserSeenAt, null, 'no stamp before any human looks');
  tile.close();

  // The user opens it (a plain web attach): attached now = seen through now.
  const viewer = new WebSocket(`ws://127.0.0.1:${state.port}/ws?room=${internal}&name=jian&replay=0&token=${state.sessionSecret}`);
  await new Promise((r) => viewer.on('open', r));
  await delay(300);
  const watching = await entryOf();
  assert.equal(watching.userAttached, true);
  assert.ok(Math.abs(watching.lastUserSeenAt - Date.now()) < 5000, 'attached reads as seen-through-now');

  // They leave: the detach moment is the high-water mark of what they saw.
  const closedAt = Date.now();
  viewer.close();
  await delay(1600); // past the debounced persist
  const after = await entryOf();
  assert.equal(after.userAttached, false);
  assert.ok(after.lastUserSeenAt >= closedAt - 1000 && after.lastUserSeenAt <= Date.now(),
    `detach stamped the seen time, got ${after.lastUserSeenAt}`);

  // And the stamp is durable, not a process memory.
  const onDisk = JSON.parse(await fs.readFile(path.join(hopHome, '.session-seen.json'), 'utf8'));
  assert.ok(onDisk[internal] >= closedAt - 1000, 'stamp persisted for the hourly generator');

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete',
    { name: 'seenprobe', internalName: internal });
});

// Identity is minted, names are labels. A session's internal id is opaque
// (s_hex), never derived from the display name, so a rename touches only
// the label — and a display name that some renamed-away session was BORN
// with is free for reuse (deriving ids used to make that collide).
test('sessions carry an opaque invariant id; renames touch only the label', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions', {
    name: 'projectx', type: 'terminal', startRuntime: true, cwd: tempDir
  });
  assert.equal(create.status, 200);
  assert.equal(create.data.displayName, 'projectx');
  assert.match(create.data.internalName, /^s_[0-9a-f]{10}$/,
    `id must be minted, got ${create.data.internalName}`);
  const id = create.data.internalName;
  await delay(400);

  // Rename: same id, new label, and the entry the clients render says so.
  const rename = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/rename', {
    oldName: 'projectx', newName: 'projecty'
  });
  assert.equal(rename.status, 200, JSON.stringify(rename.data));
  await delay(400);
  const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const entry = list.data.sessions.find(s => s.internalName === id);
  assert.ok(entry, 'the invariant id survives the rename');
  assert.equal(entry.displayName, 'projecty');
  assert.equal(entry.name, 'projecty', 'every user-facing name field is the display name');

  // The freed display name is genuinely free — the latent collision.
  const reuse = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions', {
    name: 'projectx', type: 'terminal', startRuntime: true, cwd: tempDir
  });
  assert.equal(reuse.status, 200, `freed name must be reusable: ${JSON.stringify(reuse.data)}`);
  assert.notEqual(reuse.data.internalName, id, 'the new session is its own identity');

  for (const s of [id, reuse.data.internalName]) {
    await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete',
      { name: s, internalName: s });
  }
});

// Restore's cwd arbiter must not trust a durable meta whose cwd sits in the
// transcript store. The meta is normally the room's last LIVE directory
// (the arbiter that catches a foreign claude's record) — but a shell left
// standing in ~/.claude/projects/* poisoned it, the arbiter then fired
// against the CORRECT record, and Accessibility-fork restored as a bare zsh
// in the transcript dir with its conversation gone.
test('restore does not let a transcript-store meta cwd override a good record', async () => {
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'metapoison', cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;
  const dir = path.join(hopHome, 'claude-sessions');
  await fs.mkdir(dir, { recursive: true });
  // Good record: a real conversation, in the real workspace.
  await fs.writeFile(path.join(dir, `${internal}.json`), JSON.stringify({
    sessionId: '22222222-3333-4444-5555-666666666666', cwd: tempDir,
    launchCmd: 'claude', updatedAt: new Date().toISOString()
  }), { mode: 0o600 });
  // Poisoned meta: cwd inside a transcript store.
  const meta = JSON.parse(await fs.readFile(path.join(dir, `${internal}.meta`), 'utf8').catch(() => '{}'));
  await fs.writeFile(path.join(dir, `${internal}.meta`), JSON.stringify({
    ...meta, internalName: internal, cwd: path.join(os.homedir(), '.claude', 'projects', '-Users-x')
  }), { mode: 0o600 });
  // Make the transcript "exist" where the record says it lives.
  const tdir = path.join(os.homedir(), '.claude', 'projects', tempDir.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(tdir, { recursive: true });
  const tfile = path.join(tdir, '22222222-3333-4444-5555-666666666666.jsonl');
  await fs.writeFile(tfile, '{"type":"user"}\n');

  const plan = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/restore', { dryRun: true });
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  const mine = (plan.data.planned || plan.data.sessions || []).find(p => p.internalName === internal);
  // It is live, so restore skips it — instead exercise the planner through
  // a stopped copy: delete the runtime, keep the records, plan again.
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: internal, internalName: internal });
  await fs.writeFile(path.join(dir, `${internal}.json`), JSON.stringify({
    sessionId: '22222222-3333-4444-5555-666666666666', cwd: tempDir,
    launchCmd: 'claude', updatedAt: new Date().toISOString()
  }), { mode: 0o600 });
  await fs.writeFile(path.join(dir, `${internal}.meta`), JSON.stringify({
    internalName: internal, displayName: 'metapoison',
    cwd: path.join(os.homedir(), '.claude', 'projects', '-Users-x')
  }), { mode: 0o600 });
  const plan2 = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/restore', { dryRun: true });
  const p2 = (plan2.data.restored || []).find(p => p.name === 'metapoison');
  assert.ok(p2, `planned: ${JSON.stringify(plan2.data).slice(0, 300)}`);
  // The poisoned meta must not have demoted this to a plain shell.
  assert.equal(p2.warning, null, `no wrong-conversation warning, got: ${p2.warning}`);
  assert.match(String(p2.command || ''), /--resume 22222222/, `must resume the conversation, got ${p2.command}`);
  void mine;

  await fs.rm(tfile, { force: true });
  await fs.rm(path.join(dir, `${internal}.json`), { force: true });
  await fs.rm(path.join(dir, `${internal}.meta`), { force: true });
});

// The other way the arbiter misfired (angler, 2026-08-21): the META was
// right and the RECORD's cwd had drifted — a compaction re-recorded the
// conversation's current shell directory. The store is the authority on
// where a conversation was launched: a transcript filed under the room's
// own directory means the record is this room's, whatever its cwd says.
test('restore trusts the transcript store over a drifted record cwd', async () => {
  const sid = '33333333-4444-5555-6666-777777777777';
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'drifted', cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;
  const dir = path.join(hopHome, 'claude-sessions');
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: internal, internalName: internal });
  await fs.mkdir(dir, { recursive: true });
  const wandered = path.join(tempDir, 'wandered-into');
  await fs.mkdir(wandered, { recursive: true });
  // Record: right conversation, cwd drifted to where its shell wandered.
  await fs.writeFile(path.join(dir, `${internal}.json`), JSON.stringify({
    sessionId: sid, cwd: wandered, source: 'compact',
    launchCmd: 'claude --dangerously-skip-permissions', updatedAt: new Date().toISOString()
  }), { mode: 0o600 });
  // Meta: the room's real, live directory — where claude was launched.
  await fs.writeFile(path.join(dir, `${internal}.meta`), JSON.stringify({
    internalName: internal, displayName: 'drifted', cwd: tempDir
  }), { mode: 0o600 });
  // The transcript is filed under the ROOM's directory, as claude does.
  const tdir = path.join(os.homedir(), '.claude', 'projects', tempDir.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(tdir, { recursive: true });
  const tfile = path.join(tdir, `${sid}.jsonl`);
  await fs.writeFile(tfile, '{"type":"user"}\n');

  const plan = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/restore', { dryRun: true });
  const p = (plan.data.restored || []).find(x => x.name === 'drifted');
  assert.ok(p, `planned: ${JSON.stringify(plan.data).slice(0, 300)}`);
  assert.equal(p.warning, null, `the record is this room's, got: ${p.warning}`);
  assert.match(String(p.command || ''), /--resume 33333333/, `must resume, got ${p.command}`);
  assert.match(String(p.command || ''), /--dangerously-skip-permissions/, 'flags survive the heal');
  assert.equal(p.cwd, tempDir, 'resumes from where the conversation truly lives, not where the shell wandered');
  // And the record is healed on disk, so fork/search/the next restore agree.
  const healed = JSON.parse(await fs.readFile(path.join(dir, `${internal}.json`), 'utf8'));
  assert.equal(healed.cwd, tempDir);
  assert.equal(healed.healedFrom, wandered);

  await fs.rm(tfile, { force: true });
  await fs.rm(path.join(dir, `${internal}.json`), { force: true });
  await fs.rm(path.join(dir, `${internal}.meta`), { force: true });
});

// `hop restore <name>`: a failed restore leaves a LIVE room (bare shell or a
// parked dialog), which is exactly what a fleet restore skips. The targeted
// form plans named sessions even when live — but only tears down a room
// that holds nothing.
// After a restore, the reconciler records what each claude session should
// become and exposes anything it can't converge via a health endpoint. A
// real restore of a claude session isn't exercised here (no claude binary),
// but the plumbing — recording, and the health surface — is.
test('restore records reconciler expectations and exposes a health surface', async () => {
  // A restore of purely plain-shell sessions records NOTHING to reconcile
  // (a shell is its own converged state), and health starts clean.
  const health0 = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions/restore/health');
  assert.equal(health0.status, 200, JSON.stringify(health0.data));
  assert.ok(Array.isArray(health0.data.needsAttention), 'health always answers a needsAttention array');

  // Seed the reconcile file directly with a needs-attention entry (what the
  // sweep writes when a session came up then exited N times) and confirm the
  // health endpoint surfaces it with its reason and a redo command.
  const reconcileFile = path.join(hopHome, '.restore-reconcile.json');
  await fs.writeFile(reconcileFile, JSON.stringify({ sessions: {
    ghosty: { internalName: 'ghosty', displayName: 'ghosty', status: 'needs-attention',
      reason: 'came up then exited 3x — likely a self-completing session',
      command: 'claude --resume abcd', recordedAt: Date.now() },
    fine: { internalName: 'fine', displayName: 'fine', status: 'converged', recordedAt: Date.now() },
    settling: { internalName: 'settling', displayName: 'settling', status: 'pending', recordedAt: Date.now() }
  }}), { mode: 0o600 });

  const health = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions/restore/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.needsAttention.length, 1, 'only the needs-attention entry is reported');
  assert.equal(health.data.needsAttention[0].name, 'ghosty');
  assert.match(health.data.needsAttention[0].reason, /self-completing/);
  assert.match(health.data.needsAttention[0].command, /--resume abcd/);
  assert.equal(health.data.converged, 1, 'converged ones are counted, not listed');
  assert.deepEqual(health.data.pending, ['settling'], 'still-settling ones are named');

  await fs.rm(reconcileFile, { force: true });
});

test('targeted restore redoes an idle live shell, refuses a busy one, reports an unknown name', async () => {
  const sid = '55555555-6666-7777-8888-999999999999';
  const dir = path.join(hopHome, 'claude-sessions');
  await fs.mkdir(dir, { recursive: true });
  const tdir = path.join(os.homedir(), '.claude', 'projects', tempDir.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(tdir, { recursive: true });
  const tfile = path.join(tdir, `${sid}.jsonl`);
  await fs.writeFile(tfile, '{"type":"user"}\n');

  const idle = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name: 'redo-idle', cwd: tempDir }, agentHeaders);
  const busy = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name: 'redo-busy', cwd: tempDir }, agentHeaders);
  assert.equal(idle.status, 200); assert.equal(busy.status, 200);
  const idleName = idle.data.sessionName, busyName = busy.data.sessionName;
  for (const n of [idleName, busyName]) {
    await fs.writeFile(path.join(dir, `${n}.json`), JSON.stringify({ sessionId: sid, cwd: tempDir, launchCmd: 'claude', updatedAt: new Date().toISOString() }), { mode: 0o600 });
  }
  // Occupy the busy one with a long-running foreground program.
  await requestJson(state.port, state.sessionSecret, 'POST', `/api/terminals/${busy.data.id}/write`, { data: 'sleep 300\n' }, agentHeaders);

  // The idle shell needs a moment to paint its prompt; the busy one a moment
  // to exec sleep. Poll the dry run until both verdicts are in.
  let plan, p, sk;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    plan = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/restore', { dryRun: true, only: ['redo-idle', 'REDO-BUSY', 'no-such-thing'] });
    assert.equal(plan.status, 200, JSON.stringify(plan.data));
    p = (plan.data.restored || []).find(x => x.name === 'redo-idle');
    sk = (plan.data.skipped || []).find(x => x.name === 'redo-busy');
    if (p && sk) break;
    await delay(500);
  }
  assert.ok(p, `the idle live shell is planned: ${JSON.stringify(plan.data).slice(0, 400)}`);
  assert.match(String(p.command || ''), /--resume 55555555/);
  assert.ok(sk, `the busy one is skipped: ${JSON.stringify(plan.data.skipped)}`);
  assert.match(sk.reason, /busy/);
  const unknown = (plan.data.skipped || []).find(x => x.name === 'no-such-thing');
  assert.ok(unknown && /no such session/.test(unknown.reason), 'an unknown name is reported, never invented');
  // A fleet dry run (no `only`) still skips BOTH — they are live.
  const fleet = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/restore', { dryRun: true });
  assert.ok(!(fleet.data.restored || []).some(x => x.name === 'redo-idle' || x.name === 'redo-busy'), 'fleet restore leaves live rooms alone');
  // Dry run touched nothing: both rooms are still live.
  const after = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const names = (after.data.sessions || []).filter(x => x.live).map(x => x.internalName);
  assert.ok(names.includes(idleName) && names.includes(busyName), 'dry run never tears a room down');

  for (const n of [idleName, busyName]) {
    await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: n, internalName: n });
    await fs.rm(path.join(dir, `${n}.json`), { force: true });
    await fs.rm(path.join(dir, `${n}.meta`), { force: true });
  }
  await fs.rm(tfile, { force: true });
});

// A session can lose its SessionStart record (.json) yet keep the turn
// counter (.turn), which still names its conversation — mybot came back a
// bare shell for exactly this reason. Restore recovers the record from the
// turn when the transcript is real, instead of dropping to a plain shell.
test('restore recovers a resume from the turn counter when the .json record is gone', async () => {
  const sid = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  const dir = path.join(hopHome, 'claude-sessions');
  await fs.mkdir(dir, { recursive: true });
  // A live session with a meta (cwd) and a turn (sessionId) — but NO .json.
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name: 'turnonly', cwd: tempDir }, agentHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: internal, internalName: internal });
  await fs.rm(path.join(dir, `${internal}.json`), { force: true });
  await fs.writeFile(path.join(dir, `${internal}.meta`), JSON.stringify({ internalName: internal, displayName: 'turnonly', cwd: tempDir }), { mode: 0o600 });
  await fs.writeFile(path.join(dir, `${internal}.turn`), JSON.stringify({ sessionId: sid, count: 5, at: new Date().toISOString() }), { mode: 0o600 });
  // The transcript exists under the default root, the cwd's slug.
  const tdir = path.join(os.homedir(), '.claude', 'projects', tempDir.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(tdir, { recursive: true });
  const tfile = path.join(tdir, `${sid}.jsonl`);
  await fs.writeFile(tfile, '{"type":"user"}\n');

  const plan = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/restore', { dryRun: true });
  const p = (plan.data.restored || []).find(x => x.name === 'turnonly');
  assert.ok(p, `planned: ${JSON.stringify(plan.data).slice(0, 300)}`);
  assert.match(String(p.command || ''), /--resume 66666666/, `must resume via the turn's id, not a bare shell (got ${p.command})`);
  assert.equal(p.cwd, tempDir);
  // And the .json is rebuilt so the next restore/fork/search agree.
  const rebuilt = JSON.parse(await fs.readFile(path.join(dir, `${internal}.json`), 'utf8'));
  assert.equal(rebuilt.sessionId, sid);
  assert.equal(rebuilt.recoveredFrom, 'turn-counter');

  await fs.rm(tfile, { force: true });
  await fs.rm(path.join(dir, `${internal}.json`), { force: true });
  await fs.rm(path.join(dir, `${internal}.meta`), { force: true });
  await fs.rm(path.join(dir, `${internal}.turn`), { force: true });
});

// ...and a record that genuinely belongs elsewhere is still refused: the
// transcript lives under the RECORD's directory, not the room's.
test('restore still refuses a record whose transcript lives in another directory', async () => {
  const sid = '44444444-5555-6666-7777-888888888888';
  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'foreign', cwd: tempDir
  }, agentHeaders);
  assert.equal(create.status, 200);
  const internal = create.data.sessionName;
  const dir = path.join(hopHome, 'claude-sessions');
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: internal, internalName: internal });
  const elsewhere = path.join(tempDir, 'agent-workspace');
  await fs.mkdir(elsewhere, { recursive: true });
  await fs.writeFile(path.join(dir, `${internal}.json`), JSON.stringify({
    sessionId: sid, cwd: elsewhere, source: 'startup', launchCmd: 'claude', updatedAt: new Date().toISOString()
  }), { mode: 0o600 });
  await fs.writeFile(path.join(dir, `${internal}.meta`), JSON.stringify({
    internalName: internal, displayName: 'foreign', cwd: tempDir
  }), { mode: 0o600 });
  const tdir = path.join(os.homedir(), '.claude', 'projects', elsewhere.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(tdir, { recursive: true });
  const tfile = path.join(tdir, `${sid}.jsonl`);
  await fs.writeFile(tfile, '{"type":"user"}\n');

  const plan = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/restore', { dryRun: true });
  const p = (plan.data.restored || []).find(x => x.name === 'foreign');
  assert.ok(p, `planned: ${JSON.stringify(plan.data).slice(0, 300)}`);
  assert.match(String(p.warning || ''), /another claude/, 'a genuinely foreign record is still refused');
  assert.equal(p.command, null);
  assert.equal(p.cwd, tempDir, 'and the room reopens in its OWN directory');

  await fs.rm(tfile, { force: true });
  await fs.rm(path.join(dir, `${internal}.json`), { force: true });
  await fs.rm(path.join(dir, `${internal}.meta`), { force: true });
});

test('the desktop pipe is off by default and, once on, carries bytes both ways', async () => {
  const WebSocket = require('ws');
  const net = require('node:net');
  // A stand-in VNC server: greets like one, then echoes upper-cased.
  const vnc = net.createServer((c) => {
    c.write('RFB 003.008\n');
    c.on('data', (d) => c.write(d.toString().toUpperCase()));
  });
  await new Promise((r) => vnc.listen(0, '127.0.0.1', r));
  const vncPort = vnc.address().port;
  const configPath = path.join(hopHome, '.config.json');
  const original = await fs.readFile(configPath, 'utf8').catch(() => null);
  const attach = (headers = {}) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${state.port}/desktop/ws?token=${state.sessionSecret}`, { headers });
    const got = [];
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('error', () => resolve({ status: 'error' }));
    ws.on('message', (d) => {
      got.push(d.toString());
      if (got.length === 1) ws.send('hello');
      else { ws.close(); resolve({ status: 101, got }); }
    });
  });
  try {
    const off = await requestJson(state.port, state.sessionSecret, 'GET', '/api/desktop');
    assert.equal(off.data.enabled, false);
    assert.equal((await attach()).status, 404, 'no desktop until it is turned on');

    const base = original ? JSON.parse(original) : {};
    await fs.writeFile(configPath, JSON.stringify({ ...base, desktop: { enabled: true, port: vncPort } }));
    const on = await requestJson(state.port, state.sessionSecret, 'GET', '/api/desktop');
    assert.equal(on.data.enabled, true);
    assert.equal(on.data.reachable, true);
    assert.equal(on.data.version, '003.008');

    const piped = await attach();
    assert.equal(piped.status, 101);
    assert.deepEqual(piped.got, ['RFB 003.008\n', 'HELLO']);

    const anon = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${state.port}/desktop/ws`);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('open', () => { ws.close(); resolve(101); });
      ws.on('error', () => resolve('error'));
    });
    assert.equal(anon, 401, 'the desktop needs a hop login');
  } finally {
    if (original === null) await fs.rm(configPath, { force: true });
    else await fs.writeFile(configPath, original);
    vnc.close();
  }
});

test('a view image has a small thumbnail; other kinds fall back to the file', async () => {
  const dir = path.join(hopHome, 'views', 'thumbprobe');
  await fs.mkdir(dir, { recursive: true });
  // A 400x300 PNG, written by hand: one solid-colour row repeated.
  const zlib = require('node:zlib');
  const w = 400, h = 300;
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
  await fs.writeFile(path.join(dir, 'plot.png'), png);
  await fs.writeFile(path.join(dir, 'notes.pdf'), Buffer.alloc(64, 1));
  const get = (reqPath) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: state.port, path: reqPath, method: 'GET',
      headers: { Authorization: `Bearer ${state.sessionSecret}` } }, (res) => {
      const parts = []; res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject); req.end();
  });
  try {
    const thumb = await get('/view/thumbprobe/plot.png/thumb');
    if (thumb.status === 200) {
      assert.equal(thumb.headers['content-type'], 'image/jpeg');
      assert.ok(thumb.body.length < png.length, 'smaller than the image itself');
      const again = await get('/view/thumbprobe/plot.png/thumb');
      assert.deepEqual(again.body, thumb.body, 'served from the cache the second time');
    } else {
      // No image tool on this machine: the file itself, as before.
      assert.equal(thumb.status, 302);
      assert.equal(thumb.headers.location, '/view/thumbprobe/plot.png/inline');
    }
    const pdf = await get('/view/thumbprobe/notes.pdf/thumb');
    assert.equal(pdf.status, 302);
    assert.equal((await get('/view/thumbprobe/missing.png/thumb')).status, 404);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// The host runs every terminal and listens on 127.0.0.1 — which every user of
// a shared machine, and a web page that finds the port, can reach. Without
// hop's private key it must not list, read, start, end, or attach to anything.
test('the terminal host turns away every request that lacks hop\'s key', async () => {
  const WebSocket = require('ws');
  const hostState = JSON.parse(await fs.readFile(path.join(hopHome, '.hay-host-state'), 'utf8'));
  const keyFile = path.join(hopHome, '.host-token');
  const key = (await fs.readFile(keyFile, 'utf8')).trim();
  assert.equal((await fs.stat(keyFile)).mode & 0o077, 0, 'the key is readable by this account only');
  const hostCall = (method, p, headers = {}, body = null) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: hostState.port, path: p, method,
      headers: body ? { ...headers, 'Content-Type': 'text/plain' } : headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  const wrong = { 'x-hop-host-token': 'x'.repeat(key.length) };

  assert.equal(await hostCall('GET', '/health'), 200, '/health stays open: it only says "up"');
  assert.equal(await hostCall('GET', '/rooms'), 401);
  assert.equal(await hostCall('GET', '/rooms', wrong), 401);
  assert.equal(await hostCall('GET', '/rooms/anything/output'), 401);
  assert.equal(await hostCall('DELETE', '/rooms/anything'), 401);
  // What a web page could send without asking first: a text/plain POST.
  assert.equal(await hostCall('POST', '/rooms', {}, JSON.stringify({ id: 'keyless', command: 'true' })), 401);
  assert.equal(await hostCall('GET', '/rooms', { 'x-hop-host-token': key }), 200);

  const attach = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hostState.port}/ws?room=keyless&name=probe&cols=80&rows=24`, { headers });
    const done = (v) => { try { ws.terminate(); } catch (e) { /* gone */ } resolve(v); };
    ws.on('open', () => done('opened'));
    ws.on('unexpected-response', (req, res) => done(res.statusCode));
    ws.on('error', () => done('error'));
  });
  assert.equal(await attach({}), 401);
  assert.equal(await attach(wrong), 401);
  // A key in the URL is not the key: URLs end up in logs and command lines.
  const viaQuery = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hostState.port}/ws?room=keyless&name=probe&x-hop-host-token=${encodeURIComponent(key)}`);
    const done = (v) => { try { ws.terminate(); } catch (e) { /* gone */ } resolve(v); };
    ws.on('open', () => done('opened'));
    ws.on('unexpected-response', (req, res) => done(res.statusCode));
    ws.on('error', () => done('error'));
  });
  assert.equal(viaQuery, 401);

  const rooms = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: hostState.port, path: '/rooms', headers: { 'x-hop-host-token': key } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d).rooms || []));
    }).on('error', reject);
  });
  assert.ok(!rooms.some((r) => r && r.id === 'keyless'), 'nothing was started without the key');
});

// ---- Messages for an agent: typed only into an empty box, never left unsent ----
// A fake Claude: a transcript, a ──── rule, `❯ ` and what is typed, a rule,
// a status line ("esc to interrupt" while BUSY exists). Enter submits what is
// in the box (appending it to got.log) unless STUCK exists; Ctrl+U clears the
// line; Backspace deletes. It writes its box to box.txt after every key.
const FAKE_CLAUDE = `
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
let box = ''; const log = []; let lastBusy = null;
const busyNow = () => fs.existsSync(path.join(dir, 'BUSY'));
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
const draw = () => {
  const cols = process.stdout.columns || 80;
  const rule = '\\u2500'.repeat(Math.max(10, cols - 2));
  const busy = busyNow(); lastBusy = busy;
  const lines = box.split('\\n');
  const shown = log.slice(-6);
  let out = '\\x1b[2J\\x1b[H';
  for (const l of shown) out += l + '\\r\\n';
  out += '\\r\\n' + rule + '\\r\\n';
  lines.forEach((l, i) => { out += (i === 0 ? '\\u276f ' : '  ') + l + '\\r\\n'; });
  out += rule + '\\r\\n' + (busy ? '  * Working (esc to interrupt)' : '  >> bypass permissions on');
  out += '\\x1b[' + (shown.length + 2 + lines.length) + ';' + (3 + lines[lines.length - 1].length) + 'H';
  process.stdout.write(out);
  fs.writeFileSync(path.join(dir, 'box.txt'), box);
};
// Key by key, as a terminal app reads them; a chunk of text with no keys
// in it is a paste (Enter inside a paste is part of it, not a submit).
process.stdin.on('data', (d) => {
  const paste = d.length > 1 && !/[\\x00-\\x1f\\x7f]/.test(d.replace(/\\r$/, ''));
  if (paste) { box += d.replace(/\\r/g, ''); draw(); return; }
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (c === '\\x1b') { while (i + 1 < d.length && !/[A-Za-z~u]/.test(d[i + 1])) i++; i++; continue; }
    if (c === '\\r') {
      if (!fs.existsSync(path.join(dir, 'STUCK')) && box.trim()) {
        fs.appendFileSync(path.join(dir, 'got.log'), box + '\\n'); log.push('* got: ' + box); box = '';
      }
    } else if (c === '\\x7f') box = box.slice(0, -1);
    else if (c === '\\x15') { const j = box.lastIndexOf('\\n'); box = j < 0 ? '' : box.slice(0, j + 1); }
    else if (c === '\\x05' || c === '\\t') { /* end / tab: nothing here */ }
    else if (c >= ' ') box += c;
  }
  draw();
});
setInterval(() => { if (busyNow() !== lastBusy) draw(); }, 250);
draw();
`;

test('a message for an agent is typed only into an empty input box, waits out a turn, and is never left there unsent', async () => {
  const dir = path.join(tempDir, 'fake-claude');
  await fs.mkdir(dir, { recursive: true });
  const script = path.join(dir, 'fake-claude.js');
  await fs.writeFile(script, FAKE_CLAUDE);
  const got = async () => { try { return (await fs.readFile(path.join(dir, 'got.log'), 'utf8')).split('\n').filter(Boolean); } catch { return []; } };
  const box = async () => { try { return await fs.readFile(path.join(dir, 'box.txt'), 'utf8'); } catch { return null; } };
  const until = async (fn, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await delay(250); }
    throw new Error(`timed out waiting for ${what}`);
  };

  const term = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', {
    name: 'qfake', cwd: dir, startup: `node ${script} ${dir}`, autoStart: true
  }, userHeaders);
  assert.equal(term.status, 200);
  assert.ok(term.data.id);
  await until(async () => (await box()) === '', 15000, 'the fake agent to draw');
  const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  const internal = list.data.sessions.find((s) => s.displayName === 'qfake').internalName;
  // hop knows a Claude session by its hook's turn record.
  const sessDir = path.join(hopHome, 'claude-sessions');
  await fs.mkdir(sessDir, { recursive: true });
  const stamp = async (kind, at) => fs.writeFile(path.join(sessDir, `${internal}.${kind}`), JSON.stringify({ sessionId: 'fake-conv', agent: 'claude', at: new Date(at).toISOString() }));
  await stamp('turn', Date.now() - 60_000);
  const typeIn = async (data) => {
    const att = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals/attach', { name: 'qfake' }, userHeaders);
    assert.equal(att.status, 200, JSON.stringify(att.data));
    const w = await requestJson(state.port, state.sessionSecret, 'POST', `/api/terminals/${att.data.id}/write`, { data }, userHeaders);
    assert.equal(w.status, 200, JSON.stringify(w.data));
  };
  const send = (text, extra = {}) => requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/send', { internalName: internal, text, from: 'test', ...extra }, userHeaders);
  const queued = async () => (await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions')).data.sessions.find((s) => s.internalName === internal)?.queued || [];

  // 1. Free agent, empty box: typed and submitted, once.
  const first = await send('hello agent');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.status, 'sent');
  assert.deepEqual(await got(), ['hello agent']);
  assert.equal(await box(), '');

  // 2. Someone's draft in the box: the message waits, and never joins it.
  await typeIn('my draft');
  await until(async () => (await box()) === 'my draft', 5000, 'the draft');
  const second = await send('second message');
  assert.equal(second.data.status, 'queued');
  assert.match(second.data.reason, /input box has text/);
  await delay(4000);
  assert.equal(await box(), 'my draft', 'the draft is untouched');
  assert.deepEqual(await got(), ['hello agent'], 'nothing submitted over the draft');
  const q = await queued();
  assert.equal(q.length, 1);
  assert.equal(q[0].from, 'test');
  // The draft goes away: the message follows within seconds.
  await typeIn('\x15');
  await until(async () => (await got()).includes('second message'), 20000, 'the queued message to go');
  assert.deepEqual(await got(), ['hello agent', 'second message']);
  await until(async () => (await queued()).length === 0, 8000, 'the queue to empty');

  // 3. A busy agent: queued, then typed when its turn ends.
  await fs.writeFile(path.join(dir, 'BUSY'), '1');
  await stamp('prompt', Date.now());
  await delay(600);
  const third = await send('after your turn');
  assert.equal(third.data.status, 'queued');
  await delay(5000);
  assert.deepEqual(await got(), ['hello agent', 'second message'], 'not typed mid-turn');
  assert.equal(await box(), '', 'nothing waiting inside the box');
  await fs.rm(path.join(dir, 'BUSY'));
  await stamp('turn', Date.now() + 1000);
  await until(async () => (await got()).includes('after your turn'), 20000, 'delivery after the turn');

  // 4. Enter does nothing (a stuck box): hop takes its text back out — never
  //    left typed and unsent — and tries again.
  await fs.writeFile(path.join(dir, 'STUCK'), '1');
  const fourth = await send('will not submit');
  assert.equal(fourth.data.status, 'queued');
  assert.match(fourth.data.reason, /took it back out/);
  assert.equal(await box(), '', 'the box is empty again');
  await fs.rm(path.join(dir, 'STUCK'));
  await until(async () => (await got()).includes('will not submit'), 25000, 'the retry');
  assert.equal((await got()).filter((l) => l === 'will not submit').length, 1, 'sent once');

  // 5. ⌘⌥⏎ mid-turn: what is typed leaves the box for the queue, and goes
  //    when the turn ends.
  await fs.writeFile(path.join(dir, 'BUSY'), '1');
  await stamp('prompt', Date.now() + 2000);
  await typeIn('later please');
  await until(async () => (await box()) === 'later please', 5000, 'the typed text');
  await delay(2500);
  const moved = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/queue-input', { internalName: internal }, userHeaders);
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.status, 'queued');
  assert.equal(moved.data.text, 'later please');
  assert.equal(await box(), '', 'moved out of the box');
  await fs.rm(path.join(dir, 'BUSY'));
  await stamp('turn', Date.now() + 3000);
  await until(async () => (await got()).includes('later please'), 20000, 'the moved message to go');

  // 6. The message itself already sits in the box, typed and never sent (an
  //    older delivery, an agent's Enter-less send): hop sends that, once,
  //    instead of waiting behind its own copy forever.
  await typeIn('stranded copy');
  await until(async () => (await box()) === 'stranded copy', 5000, 'the stranded copy');
  const sixth = await send('stranded copy');
  assert.equal(sixth.data.status, 'sent', JSON.stringify(sixth.data));
  assert.equal((await got()).filter((l) => l === 'stranded copy').length, 1, 'sent once, not typed twice');
  assert.equal(await box(), '');

  // Agents reach only sessions they may; a shell gets the line as typed.
  const denied = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/send', { internalName: internal, text: 'x' }, agentHeaders);
  assert.equal(denied.status, 403);
  const notAgent = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name: 'qshell', cwd: tempDir }, userHeaders);
  const shellInternal = (await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions')).data.sessions.find((s) => s.displayName === 'qshell').internalName;
  const asAgentOnly = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/send', { internalName: shellInternal, text: 'echo hi', agentOnly: true }, userHeaders);
  assert.equal(asAgentOnly.data.status, 'not-agent');
  assert.ok(notAgent.data.id);
});

// Sessions message each other like people on a messenger: `hop send` from
// one agent's session reaches another's agent marked with who sent it and
// how to answer; the answer comes back the same way, even where agents may
// not otherwise go; two agents can't trade messages without end.
test('hop send: a message from another session says who sent it, and the answer finds its way back', async () => {
  const { execFile } = require('node:child_process');
  const mk = async (name) => {
    const dir = path.join(tempDir, `msg-${name}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'fake.js'), FAKE_CLAUDE);
    const term = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name, cwd: dir, startup: `node ${path.join(dir, 'fake.js')} ${dir}`, autoStart: true }, userHeaders);
    assert.equal(term.status, 200, JSON.stringify(term.data));
    // Wide enough that a sender line plus message is one row of the box.
    await requestJson(state.port, state.sessionSecret, 'POST', `/api/terminals/${term.data.id}/resize`, { cols: 400, rows: 30 }, userHeaders);
    return dir;
  };
  const got = async (dir) => { try { return (await fs.readFile(path.join(dir, 'got.log'), 'utf8')).split('\n').filter(Boolean); } catch { return []; } };
  const until = async (fn, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await delay(250); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const aDir = await mk('msgalpha');
  const bDir = await mk('msgbeta');
  await until(async () => { try { return (await fs.readFile(path.join(bDir, 'box.txt'), 'utf8')) === '' && (await fs.readFile(path.join(aDir, 'box.txt'), 'utf8')) === ''; } catch { return false; } }, 15000, 'both fake agents to draw');
  const sessions = (await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions')).data.sessions;
  const A = sessions.find((s) => s.displayName === 'msgalpha').internalName;
  const B = sessions.find((s) => s.displayName === 'msgbeta').internalName;
  const sessDir = path.join(hopHome, 'claude-sessions');
  await fs.mkdir(sessDir, { recursive: true });
  const stamp = (internal, agent, kind = 'turn', at = Date.now() - 60_000) => fs.writeFile(path.join(sessDir, `${internal}.${kind}`), JSON.stringify({ sessionId: `conv-${internal}`, agent, at: new Date(at).toISOString() }));
  // (Both draw Claude's input box; the sender's kind is named either way.)
  await stamp(A, 'claude');
  await stamp(B, 'claude');

  const cliEnv = (session, asAgent) => {
    const env = { ...daemonEnv, HOP_SESSION: session };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID;
    if (asAgent) env.CLAUDECODE = '1';
    return env;
  };
  const hop = (args, env) => new Promise((resolve) => execFile(process.execPath, [path.join(__dirname, '..', 'hop'), ...args],
    { env, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, '') })));

  // Who is there: both agents, free.
  const who = await hop(['who', '--json'], cliEnv(A, false));
  assert.equal(who.code, 0, who.out);
  const rows = JSON.parse(who.out);
  assert.deepEqual(rows.filter((r) => /^msg(alpha|beta)$/.test(r.name)).map((r) => [r.name, r.presence, r.you]).sort(), [['msgalpha', 'free', true], ['msgbeta', 'free', false]]);

  // 1. alpha messages beta: beta's agent hears who wrote and how to answer.
  const sent = await hop(['send', 'msgbeta', 'Please', 'report', 'the', 'loss'], cliEnv(A, false));
  assert.equal(sent.code, 0, sent.out);
  assert.match(sent.out, /Sent to msgbeta/);
  assert.deepEqual(await got(bDir), ['[hop message from session "msgalpha" (a Claude agent, not your user). To answer, if an answer is needed: hop send msgalpha "<your reply>"] Please report the loss']);

  // 2. beta's agent answers. Agents were never allowed into alpha — but
  //    alpha wrote to beta, so beta may answer it.
  const closed = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/send', { internalName: B, text: 'unasked', agentOnly: true }, agentHeaders);
  assert.equal(closed.status, 403);
  assert.match(closed.data.error, /msgbeta doesn't take messages from agents.*Enable agent access/);
  const answer = await hop(['send', 'msgalpha', 'Loss is 0.31 and falling'], cliEnv(B, true));
  assert.equal(answer.code, 0, answer.out);
  await until(async () => (await got(aDir)).length === 1, 15000, 'the answer to reach alpha');
  assert.deepEqual(await got(aDir), ['[hop message from session "msgbeta" (a Claude agent, not your user). To answer, if an answer is needed: hop send msgbeta "<your reply>"] Loss is 0.31 and falling']);
  const queuedFrom = (await requestJson(state.port, state.sessionSecret, 'GET', '/api/checkbacks')).data.items.filter((c) => c.session === A);
  assert.equal(queuedFrom[0].from, 'msgbeta', 'the queue card says whose it is');
  assert.equal(queuedFrom[0].message, 'Loss is 0.31 and falling', 'stored as written');

  // 3. A sender reading the reply off the turn (the MCP's send-and-wait) says so.
  const waiting = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/send', { internalName: B, text: 'status?', agentOnly: true, fromSession: A, replyHere: true }, userHeaders);
  assert.equal(waiting.data.status, 'sent', JSON.stringify(waiting.data));
  assert.equal((await got(bDir))[1], '[hop message from session "msgalpha" (a Claude agent, not your user). It reads your reply here.] status?');

  // 4. The person's own message (the web, the phone) is typed as written.
  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/send', { internalName: B, text: 'from me', from: 'you' }, userHeaders);
  assert.equal((await got(bDir))[2], 'from me');

  // 5. Two agents can't trade messages without end: held while beta is busy,
  //    the pair's next one past the limit is refused, with what to do.
  await fs.writeFile(path.join(bDir, 'BUSY'), '1');
  await stamp(B, 'claude', 'prompt', Date.now());
  let refused = null;
  for (let i = 0; i < 20 && !refused; i++) {
    const r = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/send', { internalName: B, text: `ping ${i}`, agentOnly: true, fromSession: A, mode: 'queue' }, userHeaders);
    if (r.status === 429) refused = r;
    else assert.equal(r.data.status, 'queued', JSON.stringify(r.data));
  }
  assert.ok(refused, 'refused before 20');
  assert.match(refused.data.error, /msgalpha and msgbeta have sent each other \d+ messages in 10 minutes\. Stop here and tell your user/);
  const cancel = await requestJson(state.port, state.sessionSecret, 'POST', '/api/checkbacks/cancel', { session: B }, userHeaders);
  assert.ok(cancel.data.cancelled >= 1, JSON.stringify(cancel.data));
  await fs.rm(path.join(bDir, 'BUSY'));

  // 6. Nobody to message: a missing session, a plain shell.
  const missing = await hop(['send', 'no-such-session', 'hi'], cliEnv(A, false));
  assert.notEqual(missing.code, 0);
  assert.match(missing.out, /Session not found/);

  // 7. A fork remembers another session's name. The sender is the session
  //    the command RUNS in, by its terminal: a wrong inherited HOP_SESSION
  //    does not change it, and --from cannot claim another.
  await stamp(B, 'claude', 'turn', Date.now() + 2000);
  const forkDir = path.join(tempDir, 'msg-fork');
  await fs.mkdir(forkDir, { recursive: true });
  const shell = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name: 'msgfork', cwd: forkDir, autoStart: true }, userHeaders);
  assert.equal(shell.status, 200, JSON.stringify(shell.data));
  await delay(1500);
  // A stand-in for the agent there: its own process in the session (macOS
  // hides a login shell's environment, an agent's it does not), running hop
  // with the HOP_SESSION of the session it was forked from.
  const agentJs = path.join(forkDir, 'agent.js');
  await fs.writeFile(agentJs, `
const { spawnSync } = require('child_process'); const fs = require('fs');
const [out, stale, hopBin, ...args] = process.argv.slice(2);
const env = { ...process.env, HOP_SESSION: stale }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID;
const r = spawnSync(process.execPath, [hopBin, ...args], { env, encoding: 'utf8' });
fs.writeFileSync(out, r.stdout + r.stderr + '\\nexit=' + r.status + '\\n');
`);
  const inFork = async (args, tag) => {
    const out = path.join(forkDir, `${tag}.out`);
    const line = `${process.execPath} ${agentJs} ${out} ${A} ${path.join(__dirname, '..', 'hop')} ${args}\r`;
    const w = await requestJson(state.port, state.sessionSecret, 'POST', `/api/terminals/${shell.data.id}/write`, { data: line }, userHeaders);
    assert.equal(w.status, 200, JSON.stringify(w.data));
    return until(async () => { try { const t = (await fs.readFile(out, 'utf8')).replace(/\x1b\[[0-9;]*m/g, ''); return /exit=\d+/.test(t) ? t : null; } catch { return null; } }, 40000, `${tag} to finish`);
  };
  const claimed = await inFork(`send msgbeta --from msgalpha 'as someone else'`, 'claimed');
  assert.match(claimed, /This terminal is session "msgfork", not "msgalpha"/);
  assert.match(claimed, /exit=1/);
  const honest = await inFork(`send msgbeta 'from the fork'`, 'honest');
  assert.match(honest, /exit=0/, honest);
  await until(async () => (await got(bDir)).some((l) => l.endsWith('from the fork')), 25000, 'the fork\'s message');
  assert.match((await got(bDir)).find((l) => l.endsWith('from the fork')), /^\[hop message from session "msgfork"\./);
  assert.equal((await got(bDir)).some((l) => l.includes('as someone else')), false);

  // 8. Messages: the person reads what the agents said to each other, and
  //    what became of each — after the queue has forgotten them. The answer
  //    alpha read off beta's turn (3.) is there too.
  await fs.writeFile(path.join(sessDir, `${B}.turn`), JSON.stringify({ sessionId: `conv-${B}`, agent: 'claude', count: 1, at: new Date().toISOString(), lastMessage: 'Loss is 0.29 now.' }));
  const log = (await requestJson(state.port, state.sessionSecret, 'GET', '/api/messages', null, userHeaders)).data.messages;
  const find = (text) => log.find((m) => m.text === text);
  assert.deepEqual(['from', 'to', 'fromName', 'toName', 'status'].map((k) => find('Please report the loss')?.[k]), [A, B, 'msgalpha', 'msgbeta', 'delivered']);
  assert.equal(find('Loss is 0.31 and falling')?.from, B);
  assert.equal(find('Loss is 0.31 and falling')?.status, 'delivered');
  assert.deepEqual([find('unasked')?.from, find('unasked')?.status], [null, 'refused'], 'an agent outside hop, turned away');
  assert.equal(find('status?')?.reply, 'Loss is 0.29 now.', 'read off the turn');
  assert.equal(find('from me'), undefined, 'the person\'s own messages are not agent talk');
  assert.ok(log.some((m) => /^ping \d+$/.test(m.text) && m.status === 'cancelled'), 'cancelled in the queue');
  assert.ok(log.some((m) => /^ping \d+$/.test(m.text) && m.status === 'held' && /stopped the exchange/.test(m.reason)), 'the loop brake');
  assert.equal(log.find((m) => m.text === 'from the fork')?.fromName, 'msgfork');
  assert.equal(log.some((m) => m.text === 'as someone else'), false);
  assert.equal(log.some((m) => 'turnBase' in m), false, 'bookkeeping stays inside');
  const asAgent = await requestJson(state.port, state.sessionSecret, 'GET', '/api/messages', null, agentHeaders);
  assert.equal(asAgent.status, 403, 'not for agents to read across sessions');
  const badge = (await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions')).data.messagesAt;
  assert.ok(badge >= log[log.length - 1].at, 'the list carries the newest message time');
});

// Files from a session — the Views shelf: what its agent wrote or named in
// its replies, from its own record; read in place (a page sandboxed), never
// any path asked for; pinned into Views; opened from a path in its terminal.
test('files from a session: listed from its record, read in place, pinned as a view, opened from its terminal', async () => {
  const proj = path.join(tempDir, 'filesproj');
  await fs.mkdir(path.join(proj, 'results'), { recursive: true });
  await fs.mkdir(path.join(proj, '.hidden'), { recursive: true });
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5b2f0b10000000049454e44ae426082', 'hex');
  await fs.writeFile(path.join(proj, 'results', 'loss.png'), PNG);
  await fs.writeFile(path.join(proj, 'results', 'other.png'), PNG);
  await fs.writeFile(path.join(proj, 'report.html'), '<!doctype html><script>document.title="ran"</script><p>report</p>');
  await fs.writeFile(path.join(proj, 'notes.md'), '# Notes\n\nfine');
  await fs.writeFile(path.join(proj, '.hidden', 'x.md'), 'secret');
  await fs.writeFile(path.join(proj, 'main.py'), 'print(1)');

  const create = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name: 'filesprobe', cwd: proj }, userHeaders);
  assert.equal(create.status, 200, JSON.stringify(create.data));
  const internal = create.data.sessionName;
  const sessionId = '44444444-5555-6666-7777-888888888888';
  const configDir = path.join(tempDir, 'claude-cfg-files');
  const pdir = path.join(configDir, 'projects', proj.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(pdir, { recursive: true });
  const tfile = path.join(pdir, `${sessionId}.jsonl`);
  const said = (text, extra = []) => JSON.stringify({ type: 'assistant', cwd: proj, timestamp: new Date().toISOString(), message: { content: [...extra, { type: 'text', text }] } }) + '\n';
  await fs.writeFile(tfile,
    said('Writing the report.', [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(proj, 'report.html') } }])
    + JSON.stringify({ type: 'user', cwd: proj, message: { content: [{ type: 'tool_result', content: 'ls: results/other.png' }] } }) + '\n'
    + said('The plot is at results/loss.png; notes in notes.md. Not shown: .hidden/x.md, main.py, gone.png.'));
  await fs.writeFile(path.join(hopHome, 'claude-sessions', `${internal}.json`), JSON.stringify({ sessionId, cwd: proj, configDir, launchCmd: 'claude', updatedAt: new Date().toISOString() }), { mode: 0o600 });

  const list = async () => (await requestJson(state.port, state.sessionSecret, 'GET', `/api/sessions/files?name=${internal}`, null, userHeaders)).data.items;
  const raw = (p, actor = 'user') => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: state.port, path: p, headers: { Authorization: `Bearer ${state.sessionSecret}`, 'X-Hop-Actor': actor } }, (res) => {
      let body = ''; res.on('data', (c) => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });

  // 1. What the agent wrote, and named in its replies — not tool output,
  //    not hidden, code or missing files.
  let items = await list();
  assert.deepEqual(items.map((i) => [i.name, i.how]).sort(), [['loss.png', 'mentioned'], ['notes.md', 'mentioned'], ['report.html', 'wrote']]);
  const byName = (n) => items.find((i) => i.name === n);
  assert.equal(byName('loss.png').file, path.join(proj, 'results', 'loss.png'));

  // 2. Read in place: a page sandboxed (it is nobody's vetted file), an
  //    image as itself, Markdown rendered; nothing but listed files.
  const page = await raw(byName('report.html').path);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'] || '', /^sandbox /);
  assert.doesNotMatch(page.headers['content-security-policy'], /allow-same-origin/);
  const img = await raw(byName('loss.png').path);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.headers['content-security-policy'], undefined);
  const md = await raw(byName('notes.md').path);
  assert.match(md.headers['content-type'], /text\/html/);
  assert.match(md.body, /<h1[^>]*>Notes<\/h1>/);
  assert.equal((await raw(`/sessionfile/${internal}/0000000000000000/inline`)).status, 404);
  // An agent reaches only the sessions it may (this one it may not).
  assert.equal((await raw(byName('notes.md').path, 'agent')).status, 404);
  assert.equal((await raw(`/sessionfile/${internal}/${byName('loss.png').id}/download`)).headers['content-disposition'].startsWith('attachment'), true);

  // 3. Pinned: a view of the session, captioned, and off the shelf.
  const pin = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/files/pin', { name: internal, id: byName('loss.png').id, title: 'Loss curve' }, userHeaders);
  assert.equal(pin.status, 200, JSON.stringify(pin.data));
  assert.equal(pin.data.view, 'loss.png');
  const views = (await requestJson(state.port, state.sessionSecret, 'GET', '/api/views')).data.items.filter((v) => v.session === internal);
  assert.deepEqual(views.map((v) => [v.name, v.title]), [['loss.png', 'Loss curve']]);
  items = await list();
  assert.equal(items.some((i) => i.name === 'loss.png'), false);

  // 4. A path clicked in its terminal: found where the agent works; a
  //    published one opens its view; hidden or missing ones are refused.
  const resolve = (p) => requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/files/resolve', { name: internal, path: p }, userHeaders);
  const other = await resolve('results/other.png');
  assert.equal(other.status, 200, JSON.stringify(other.data));
  assert.equal(other.data.item.name, 'other.png');
  assert.ok((await list()).some((i) => i.name === 'other.png'), 'and it joins the shelf');
  assert.equal((await resolve('results/loss.png')).data.view, 'loss.png');
  assert.equal((await resolve('.hidden/x.md')).status, 400);
  assert.equal((await resolve('main.py')).status, 400);
  assert.equal((await resolve('nope.png')).status, 404);

  // 5. A new turn naming a new file: on the next look.
  await fs.writeFile(path.join(proj, 'results', 'new.png'), PNG);
  await fs.appendFile(tfile, said('Added results/new.png.'));
  assert.ok((await list()).some((i) => i.name === 'new.png'));

  await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions/delete', { name: internal, internalName: internal });
});

// A view that links to hop by another of its addresses (an agent's redirect
// to the public https://hop…/s/<server>/) used to open, inside the Mac app's
// 127.0.0.1 frame, on a signed-out sign-in page whose passkey button did
// nothing. hop's own addresses now become paths on the one reading it, and
// a sign-in page inside a frame says so and offers its own tab.
test('a view naming hop by another address stays signed in; a framed sign-in page says so', async () => {
  const sess = 'addrprobe';
  await fs.mkdir(path.join(hopHome, 'views', sess), { recursive: true });
  const self = `127.0.0.1:${state.port}`;
  await fs.writeFile(path.join(hopHome, 'views', sess, 'go.html'),
    `<meta http-equiv="refresh" content="0;url=http://${self}/s/briefing/"><a href="https://elsewhere.example/s/x/">out</a>`);
  const got = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: state.port, path: `/view/${sess}/go.html/inline`, headers: { Authorization: `Bearer ${state.sessionSecret}` } }, (res) => {
      let body = ''; res.on('data', (c) => body += c); res.on('end', () => resolve({ status: res.statusCode, body, length: Number(res.headers['content-length']) }));
    }).on('error', reject);
  });
  assert.equal(got.status, 200);
  assert.match(got.body, /content="0;url=\/s\/briefing\/"/);
  assert.match(got.body, /href="https:\/\/elsewhere\.example\/s\/x\/"/, 'other sites are left alone');
  assert.equal(got.length, Buffer.byteLength(got.body));
  await fs.rm(path.join(hopHome, 'views', sess), { recursive: true, force: true });

  const signin = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: state.port, path: '/', headers: { Accept: 'text/html' } }, (res) => {
      let body = ''; res.on('data', (c) => body += c); res.on('end', () => resolve(body));
    }).on('error', reject);
  });
  assert.match(signin, /window\.top !== window\.self/);
  assert.match(signin, /Open it in its own tab/);
});

// A shared view: a public link the person makes, opened with no sign-in,
// sandboxed, following the view's newest copy, and gone when they stop or
// the view is deleted. An agent publishes; it cannot make the link.
test('a view shared by its person opens for anyone with the link, sandboxed, until they stop', async () => {
  const sess = 'shareprobe';
  const dir = path.join(hopHome, 'views', sess);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'page.html'), '<title>v1</title><script>document.title="ran"</script>v1');
  await fs.writeFile(path.join(dir, '.meta.json'), JSON.stringify({ 'page.html': { title: 'Q3 page' } }));
  const raw = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: state.port, path: p, headers }, (res) => {
      let body = ''; res.on('data', (c) => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
  const share = (on, headers) => requestJson(state.port, state.sessionSecret, 'POST', '/api/views/share', { session: sess, name: 'page.html', share: on }, headers);

  const refused = await share(true, agentHeaders);
  assert.equal(refused.status, 403);
  assert.equal(refused.data.code, 'agent');

  const made = await share(true, userHeaders);
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const token = made.data.token;
  assert.match(token, /^[A-Za-z0-9_-]{24,}$/);
  assert.ok(made.data.url.endsWith(`/shared/${token}`), made.data.url);
  assert.ok(!made.data.url.includes(sess), 'the link names no session');

  const views = await requestJson(state.port, state.sessionSecret, 'GET', '/api/views', null, userHeaders);
  assert.equal(views.data.items.find((i) => i.session === sess && i.name === 'page.html').share, token);
  assert.equal(typeof views.data.shareBase, 'string');

  // No cookie, no token: the page itself, walled off from hop.
  const got = await raw(`/shared/${token}`);
  assert.equal(got.status, 200);
  assert.match(got.body, /v1/);
  assert.match(String(got.headers['content-security-policy']), /^sandbox allow-scripts/);
  assert.equal(got.headers['referrer-policy'], 'no-referrer');
  assert.match(String(got.headers['x-robots-tag']), /noindex/);
  assert.match(String(got.headers['cache-control']), /no-store/);
  const dl = await raw(`/shared/${token}/download`);
  assert.match(String(dl.headers['content-disposition']), /^attachment; filename="page\.html"/);

  // Published again: same link, newest copy.
  await fs.writeFile(path.join(dir, 'page.html'), '<title>v2</title>v2');
  assert.match((await raw(`/shared/${token}`)).body, /v2/);

  // Stopping is allowed to anyone, an agent too: it only takes access away.
  const stopped = await share(false, agentHeaders);
  assert.equal(stopped.status, 200);
  const gone = await raw(`/shared/${token}`);
  assert.equal(gone.status, 404);
  assert.match(gone.body, /This link no longer works/);
  assert.doesNotMatch(gone.body, /shareprobe|page\.html/, 'a dead link says nothing about what it was');

  // Shared again: a new link. Deleting the view ends it.
  const again = await share(true, userHeaders);
  assert.notEqual(again.data.token, token);
  assert.equal((await raw(`/shared/${again.data.token}`)).status, 200);
  // Node sends a DELETE's body without a length unless told one.
  const delBody = { session: sess, name: 'page.html' };
  const del = await requestJson(state.port, state.sessionSecret, 'DELETE', '/api/views', delBody, { ...userHeaders, 'Content-Length': Buffer.byteLength(JSON.stringify(delBody)) });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal((await raw(`/shared/${again.data.token}`)).status, 404);
  assert.equal((await raw('/shared/' + 'A'.repeat(24))).status, 404);
  assert.equal((await share(true, userHeaders)).status, 404, 'nothing left to share');

  // The CLI: the person's links in --list, and --unshare; --share under an
  // agent's process is refused before anything is published.
  await fs.writeFile(path.join(dir, 'fig.png'), 'png');
  const fig = await requestJson(state.port, state.sessionSecret, 'POST', '/api/views/share', { session: sess, name: 'fig.png', share: true }, userHeaders);
  const cliEnv = { ...daemonEnv };
  delete cliEnv.CLAUDECODE; delete cliEnv.CLAUDE_CODE_SESSION_ID; delete cliEnv.HOP_SESSION;
  const cli = (...args) => require('child_process').spawnSync(process.execPath, [HOP_BIN, 'view', ...args], { env: cliEnv, encoding: 'utf8' });
  const listed = cli('--list', '--session', sess);
  assert.match(listed.stdout, new RegExp(`fig\\.png.*shared: \\S+/shared/${fig.data.token}`));
  const wrapDir = path.join(tempDir, 'agentwrap');
  await fs.mkdir(wrapDir, { recursive: true });
  const wrapper = path.join(wrapDir, 'claude');
  await fs.writeFile(wrapper, `const r = require('child_process').spawnSync(process.execPath, ${JSON.stringify([HOP_BIN, 'view', '--session', sess, '--share'])}.concat(process.argv.slice(2)), { encoding: 'utf8' });
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status);`);
  await fs.writeFile(path.join(tempDir, 'new.html'), 'new');
  const byAgent = require('child_process').spawnSync(process.execPath, [wrapper, path.join(tempDir, 'new.html')], { env: cliEnv, encoding: 'utf8' });
  assert.equal(byAgent.status, 1, byAgent.stdout + byAgent.stderr);
  assert.match(byAgent.stdout + byAgent.stderr, /a public link is your person's decision/);
  assert.equal(require('node:fs').existsSync(path.join(dir, 'new.html')), false, 'not published either');
  const unshared = cli('--session', sess, '--unshare', 'fig.png');
  assert.equal(unshared.status, 0, unshared.stdout + unshared.stderr);
  assert.match(unshared.stdout + unshared.stderr, /Stopped sharing fig\.png/);
  assert.equal((await raw(`/shared/${fig.data.token}`)).status, 404);
  await fs.rm(dir, { recursive: true, force: true });
});

// A new session's folder must be there: a mistyped one used to start the
// session in home (and Codex then made itself a folder under ~/Documents).
test('a new session in a missing folder is refused, and the form can create the folder', async () => {
  const missing = path.join(tempDir, 'not-yet', 'deeper');
  const refused = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions', { name: 'FolderGate', type: 'terminal', cwd: missing }, userHeaders);
  assert.equal(refused.status, 400);
  assert.equal(refused.data.code, 'cwd-missing');
  assert.match(refused.data.error, /No folder at/);
  const list = await requestJson(state.port, state.sessionSecret, 'GET', '/api/sessions');
  assert.ok(!list.data.sessions.some((s) => s.displayName === 'FolderGate'), 'nothing was created');

  const asFile = path.join(tempDir, 'plain-file.txt');
  await fs.writeFile(asFile, 'x');
  const fileRefused = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions', { name: 'FolderGate', type: 'terminal', cwd: asFile }, userHeaders);
  assert.equal(fileRefused.data.code, 'cwd-not-dir');

  // The form's check, then its Create folder button.
  const seen = await requestJson(state.port, state.sessionSecret, 'GET', `/api/fs/folder?path=${encodeURIComponent(missing)}`, null, userHeaders);
  assert.equal(seen.data.exists, false);
  const made = await requestJson(state.port, state.sessionSecret, 'POST', '/api/fs/folder', { path: missing }, userHeaders);
  assert.equal(made.status, 200);
  assert.equal(made.data.isDirectory, true);
  const created = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions', { name: 'FolderGate', type: 'terminal', cwd: missing }, userHeaders);
  assert.equal(created.status, 200, JSON.stringify(created.data));

  // Or in one step, when asked to.
  const other = path.join(tempDir, 'made-on-create');
  const both = await requestJson(state.port, state.sessionSecret, 'POST', '/api/sessions', { name: 'FolderGate2', type: 'terminal', cwd: other, createCwd: true }, userHeaders);
  assert.equal(both.status, 200, JSON.stringify(both.data));
  assert.ok((await fs.stat(other)).isDirectory());

  // An agent's terminal in a missing folder is refused too.
  const agentRefused = await requestJson(state.port, state.sessionSecret, 'POST', '/api/terminals', { name: 'FolderGateAgent', cwd: path.join(tempDir, 'nope') }, agentHeaders);
  assert.equal(agentRefused.status, 400);
  assert.equal(agentRefused.data.code, 'cwd-missing');
});
