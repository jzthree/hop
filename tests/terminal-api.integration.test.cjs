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
