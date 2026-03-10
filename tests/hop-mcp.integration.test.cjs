const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const MCP_BIN = path.join(__dirname, '..', 'mcp', 'hop-mcp.js');

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function startMockHopServer() {
  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.url.startsWith('/api/sessions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [{ displayName: 'demo' }], active: [] }));
      return;
    }
    if (req.url.startsWith('/api/terminals')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ terminals: [] }));
      return;
    }
    if (req.url.startsWith('/api/workspaces')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workspaces: ['default'], current: 'default' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function startMockHopSessionsFailureServer(statusCode = 503) {
  const status = Number.isFinite(statusCode) ? Math.floor(statusCode) : 503;
  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.url.startsWith('/api/sessions')) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `sessions failed (${status})` }));
      return;
    }
    if (req.url.startsWith('/api/terminals')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ terminals: [] }));
      return;
    }
    if (req.url.startsWith('/api/workspaces')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workspaces: [], current: null }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function startMockHopStreamServer(options = {}) {
  const eventDelimiter = typeof options.eventDelimiter === 'string' ? options.eventDelimiter : '\n\n';
  const startupOutput = options.startupOutput === undefined ? 'PROMPT> ' : String(options.startupOutput);
  const outputChunker = typeof options.outputChunker === 'function' ? options.outputChunker : null;
  const streamReadyDelayMs = Number.isFinite(options.streamReadyDelayMs) && options.streamReadyDelayMs > 0
    ? Math.floor(options.streamReadyDelayMs)
    : 0;
  const closeFirstStreamAfterMs = Number.isFinite(options.closeFirstStreamAfterMs) && options.closeFirstStreamAfterMs > 0
    ? Math.floor(options.closeFirstStreamAfterMs)
    : 0;
  const terminals = new Map();
  let nextTerminalId = 1;

  function getTerminal(id) {
    if (!terminals.has(id)) {
      terminals.set(id, { listeners: new Set(), streamOpens: 0 });
    }
    return terminals.get(id);
  }

  function emitOutput(terminal, output, fallbackChunks) {
    if (terminal.listeners.size === 0) return;
    const chunked = outputChunker ? outputChunker(output) : null;
    const chunks = Array.isArray(chunked) && chunked.length > 0 ? chunked : fallbackChunks;
    const writePayload = (payload) => {
      for (const listener of terminal.listeners) {
        if (listener.destroyed || listener.writableEnded) continue;
        listener.write(`data: ${JSON.stringify(payload)}${eventDelimiter}`);
      }
    };
    for (const chunk of chunks) {
      let payload;
      let delayMs = 0;
      if (chunk && typeof chunk === 'object' && !Array.isArray(chunk)) {
        payload = {
          type: 'output',
          data: typeof chunk.data === 'string' ? chunk.data : '',
          timestamp: Number.isFinite(chunk.timestamp) ? Math.floor(chunk.timestamp) : Date.now()
        };
        if (typeof chunk.alternateScreen === 'boolean') payload.alternateScreen = chunk.alternateScreen;
        if (typeof chunk.cursorHidden === 'boolean') payload.cursorHidden = chunk.cursorHidden;
        delayMs = Number.isFinite(chunk.delayMs) ? Math.max(0, Math.floor(chunk.delayMs)) : 0;
      } else {
        payload = { type: 'output', data: String(chunk), timestamp: Date.now() };
      }
      if (delayMs > 0) {
        setTimeout(() => writePayload(payload), delayMs);
      } else {
        writePayload(payload);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404);
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/terminals') {
      const id = `t-${nextTerminalId++}`;
      getTerminal(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id, sessionName: `session-${id}`, displayName: id }));
      return;
    }

    const streamMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)\/stream$/);
    if (req.method === 'GET' && streamMatch) {
      const id = decodeURIComponent(streamMatch[1]);
      const terminal = getTerminal(id);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      const writeStartupEvents = () => {
        if (res.destroyed || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ type: 'ready', timestamp: Date.now() })}${eventDelimiter}`);
        if (startupOutput.length > 0) {
          res.write(`data: ${JSON.stringify({ type: 'output', data: startupOutput, timestamp: Date.now() })}${eventDelimiter}`);
        }
      };
      let startupTimer = null;
      if (streamReadyDelayMs > 0) {
        startupTimer = setTimeout(writeStartupEvents, streamReadyDelayMs);
      } else {
        writeStartupEvents();
      }
      terminal.listeners.add(res);
      terminal.streamOpens += 1;
      let closeTimer = null;
      if (closeFirstStreamAfterMs > 0 && terminal.streamOpens === 1) {
        closeTimer = setTimeout(() => {
          try {
            res.end();
          } catch {
            // no-op
          }
        }, closeFirstStreamAfterMs);
      }

      const cleanup = () => {
        terminal.listeners.delete(res);
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }

    const writeMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)\/write$/);
    if (req.method === 'POST' && writeMatch) {
      const id = decodeURIComponent(writeMatch[1]);
      const terminal = getTerminal(id);
      const body = await readJsonBody(req);
      const output = String(body.data || '');

      emitOutput(terminal, output, [output]);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname.startsWith('/api/terminals')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ terminals: [] }));
      return;
    }

    if (url.pathname.startsWith('/api/sessions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [], active: [] }));
      return;
    }

    if (url.pathname.startsWith('/api/workspaces')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workspaces: [], current: null }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function startMockHopRecoveryServer(options = {}) {
  const startupOutput = options.startupOutput === undefined ? 'PROMPT> ' : String(options.startupOutput);
  const sessions = new Map(); // sessionName -> { sessionName, displayName, currentTerminalId, listeners:Set<ServerResponse> }
  let nextSessionId = 1;
  let nextTerminalId = 1;
  let attachCalls = 0;

  const makeTerminalId = () => `t-recover-${nextTerminalId++}`;

  function createSession(displayName) {
    const sessionName = `session-recover-${nextSessionId++}`;
    const session = {
      sessionName,
      displayName,
      currentTerminalId: makeTerminalId(),
      listeners: new Set()
    };
    sessions.set(sessionName, session);
    return session;
  }

  function findSessionByTerminalId(terminalId) {
    for (const session of sessions.values()) {
      if (session.currentTerminalId === terminalId) return session;
    }
    return null;
  }

  function findSessionByDisplayName(displayName) {
    for (const session of sessions.values()) {
      if (session.displayName === displayName) return session;
    }
    return null;
  }

  function writeSse(listener, payload) {
    listener.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function emitOutput(session, data) {
    for (const listener of Array.from(session.listeners)) {
      if (listener.destroyed || listener.writableEnded) {
        session.listeners.delete(listener);
        continue;
      }
      writeSse(listener, { type: 'output', data, timestamp: Date.now() });
    }
  }

  function disconnectSessionListeners(session) {
    for (const listener of Array.from(session.listeners)) {
      try {
        listener.end();
      } catch {
        // no-op
      }
    }
    session.listeners.clear();
  }

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'POST' && reqUrl.pathname === '/api/terminals') {
      const body = await readJsonBody(req);
      const displayName = typeof body.name === 'string' && body.name.trim().length > 0
        ? body.name.trim()
        : `recover-${nextSessionId}`;
      const session = createSession(displayName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        id: session.currentTerminalId,
        sessionName: session.sessionName,
        displayName: session.displayName
      }));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/terminals/attach') {
      attachCalls += 1;
      const body = await readJsonBody(req);
      let session = null;

      if (typeof body.internalName === 'string' && body.internalName.trim().length > 0) {
        session = sessions.get(body.internalName.trim()) || null;
      }
      if (!session && typeof body.name === 'string' && body.name.trim().length > 0) {
        session = findSessionByDisplayName(body.name.trim());
      }

      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      disconnectSessionListeners(session);
      session.currentTerminalId = makeTerminalId();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        id: session.currentTerminalId,
        sessionName: session.sessionName,
        displayName: session.displayName
      }));
      return;
    }

    const streamMatch = reqUrl.pathname.match(/^\/api\/terminals\/([^/]+)\/stream$/);
    if (req.method === 'GET' && streamMatch) {
      const terminalId = decodeURIComponent(streamMatch[1]);
      const session = findSessionByTerminalId(terminalId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Terminal not found' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      writeSse(res, { type: 'ready', timestamp: Date.now() });
      if (startupOutput.length > 0) {
        writeSse(res, { type: 'output', data: startupOutput, timestamp: Date.now() });
      }
      session.listeners.add(res);

      const cleanup = () => {
        session.listeners.delete(res);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }

    const writeMatch = reqUrl.pathname.match(/^\/api\/terminals\/([^/]+)\/write$/);
    if (req.method === 'POST' && writeMatch) {
      const terminalId = decodeURIComponent(writeMatch[1]);
      const session = findSessionByTerminalId(terminalId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Terminal not found' }));
        return;
      }
      const body = await readJsonBody(req);
      const data = typeof body.data === 'string' ? body.data : '';
      emitOutput(session, data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const resizeMatch = reqUrl.pathname.match(/^\/api\/terminals\/([^/]+)\/resize$/);
    if (req.method === 'POST' && resizeMatch) {
      const terminalId = decodeURIComponent(resizeMatch[1]);
      const session = findSessionByTerminalId(terminalId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Terminal not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const closeMatch = reqUrl.pathname.match(/^\/api\/terminals\/([^/]+)$/);
    if (req.method === 'DELETE' && closeMatch) {
      const terminalId = decodeURIComponent(closeMatch[1]);
      const session = findSessionByTerminalId(terminalId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Terminal not found' }));
        return;
      }
      disconnectSessionListeners(session);
      session.currentTerminalId = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/terminals') {
      const terminals = [];
      for (const session of sessions.values()) {
        if (!session.currentTerminalId) continue;
        terminals.push({
          id: session.currentTerminalId,
          sessionName: session.sessionName,
          displayName: session.displayName,
          actor: 'agent',
          createdAt: new Date().toISOString()
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ terminals }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/sessions') {
      const listed = Array.from(sessions.values()).map((session) => ({
        internalName: session.sessionName,
        displayName: session.displayName,
        type: 'terminal'
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: listed, active: listed }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname.startsWith('/api/workspaces')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workspaces: [], current: null }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const restartDaemon = () => {
    for (const session of sessions.values()) {
      disconnectSessionListeners(session);
      session.currentTerminalId = null;
    }
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        restartDaemon,
        getAttachCalls: () => attachCalls
      });
    });
  });
}

function startMcp(env) {
  const child = spawn(process.execPath, [MCP_BIN], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();

  rl.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message && message.id !== undefined && pending.has(message.id)) {
      const { resolve } = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });

  let nextId = 1;
  function call(method, params) {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    child.stdin.write(payload);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timed out waiting for response to ${method}`));
        }
      }, 3000);
    });
  }

  return { child, call };
}

test('hop-mcp tools/resources basic flow', async () => {
  const { server, port } = await startMockHopServer();
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    const init = await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });
    assert.equal(init.result.protocolVersion, '2024-11-05');

    const tools = await call('tools/list');
    const toolNames = tools.result.tools.map(t => t.name);
    const hopxSendAndWaitTool = tools.result.tools.find((t) => t.name === 'hopx_send_and_wait');
    const hopxAgentTurnTool = tools.result.tools.find((t) => t.name === 'hopx_agent_turn');
    assert.ok(toolNames.includes('hop_create_terminal'));
    assert.ok(toolNames.includes('hopx_send_and_wait'));
    assert.ok(toolNames.includes('hop_wait_terminal'));
    assert.ok(toolNames.includes('hop_wait_start'));
    assert.ok(toolNames.includes('hop_wait_poll'));
    assert.ok(toolNames.includes('hopx_agent_turn'));
    assert.ok(!toolNames.includes('hop_exec_terminal'));
    assert.ok(toolNames.includes('hop_server_info'));
    assert.equal(hopxSendAndWaitTool.inputSchema.properties.text_only.type, 'boolean');
    assert.equal(hopxAgentTurnTool.inputSchema.properties.text_only.type, 'boolean');
    assert.equal(hopxAgentTurnTool.inputSchema.properties.async.type, 'boolean');
    assert.equal(hopxAgentTurnTool.inputSchema.properties.wait_id.type, 'string');
    assert.deepEqual(hopxAgentTurnTool.inputSchema.properties.control.enum, ['send', 'wait', 'interrupt', 'terminate']);

    const resources = await call('resources/list');
    const resourceUris = resources.result.resources.map(r => r.uri);
    assert.ok(resourceUris.includes('hop://sessions'));

    const sessions = await call('resources/read', { uri: 'hop://sessions' });
    const sessionText = sessions.result.contents[0].text;
    const parsedSessions = JSON.parse(sessionText);
    assert.equal(parsedSessions.sessions[0].displayName, 'demo');

    const listSessions = await call('tools/call', { name: 'hop_list_sessions', arguments: {} });
    const listText = listSessions.result.content[0].text;
    const parsedList = JSON.parse(listText);
    assert.equal(parsedList.sessions[0].displayName, 'demo');

    const serverInfo = await call('tools/call', { name: 'hop_server_info', arguments: {} });
    const serverInfoText = serverInfo.result.content[0].text;
    const parsedServerInfo = JSON.parse(serverInfoText);
    assert.equal(parsedServerInfo.name, 'hop-mcp');
    assert.ok(Array.isArray(parsedServerInfo.readTerminal.modes));
    assert.ok(parsedServerInfo.readTerminal.modes.includes('ui'));
    assert.equal(parsedServerInfo.readTerminal.defaultTerminalSize.cols, 140);
    assert.equal(parsedServerInfo.readTerminal.defaultTerminalSize.rows, 40);
    assert.equal(parsedServerInfo.hopx.waitCaptureMaxEventsDefault, 60);
    assert.equal(parsedServerInfo.hopx.uiWaitCaptureMaxEventsDefault, 0);
    assert.equal(parsedServerInfo.hopx.textOnlyReadableDefault, true);
    assert.equal(parsedServerInfo.hopx.uiBusyGuardMaxWaitMsDefault, 12000);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_write_terminal preserves output before first read', async () => {
  const { server, port } = await startMockHopStreamServer();
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'prewarm-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const marker = 'PRE_READ_MARKER';
    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: `echo ${marker}\r\n` }
    });

    const read = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: { terminal_id: createdPayload.id, maxEvents: 20 }
    });
    const readPayload = JSON.parse(read.result.content[0].text);
    const output = readPayload.events
      .filter((event) => event.type === 'output')
      .map((event) => event.data)
      .join('');

    assert.match(output, new RegExp(marker));
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_write_terminal reconnects stream after previous stream ended', async () => {
  const { server, port } = await startMockHopStreamServer({ closeFirstStreamAfterMs: 50 });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'reconnect-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await delay(120);

    const marker = 'RECONNECT_MARKER';
    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: `echo ${marker}\r\n` }
    });

    let cursor = null;
    let output = '';
    for (let i = 0; i < 5; i++) {
      const read = await call('tools/call', {
        name: 'hop_read_terminal',
        arguments: { terminal_id: createdPayload.id, cursor, maxEvents: 20 }
      });
      const payload = JSON.parse(read.result.content[0].text);
      cursor = payload.cursor;
      output += payload.events
        .filter((event) => event.type === 'output')
        .map((event) => event.data)
        .join('');
      if (output.includes(marker)) break;
      await delay(40);
    }

    assert.match(output, /RECONNECT_MARKER/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_send_key maps named keys to terminal input', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'send-key-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_send_key',
      arguments: { terminal_id: createdPayload.id, key: 'up', repeat: 2 }
    });

    let output = '';
    let cursor = null;
    for (let i = 0; i < 5; i += 1) {
      const read = await call('tools/call', {
        name: 'hop_read_terminal',
        arguments: { terminal_id: createdPayload.id, cursor, maxEvents: 40 }
      });
      const parsed = JSON.parse(read.result.content[0].text);
      cursor = parsed.cursor;
      output += parsed.events
        .filter((event) => event && event.type === 'output' && typeof event.data === 'string')
        .map((event) => event.data)
        .join('');
      if (output.includes('\u001b[A\u001b[A')) break;
    }

    assert.match(output, /\u001b\[A\u001b\[A/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_wait_terminal matches regex condition with readable_raw capture', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'wait-regex-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: 'build complete\r\n' }
    });

    const waited = await call('tools/call', {
      name: 'hop_wait_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        cursor: 0,
        until_regex: 'complete',
        capture: 'readable_raw',
        control_level: 'none',
        coalesce_ms: 250,
        max_wait_ms: 1000
      }
    });
    const parsed = JSON.parse(waited.result.content[0].text);

    assert.equal(parsed.status, 'matched');
    assert.equal(parsed.matched, 'regex');
    assert.match(parsed.matchedText || '', /complete/);
    assert.equal(parsed.captureMode, 'readable_raw');
    assert.ok(Array.isArray(parsed.events));
    assert.ok(parsed.events.every((event) => !event || !Object.prototype.hasOwnProperty.call(event, 'controls')));
    assert.ok(parsed.events.every((event) => (
      !event
      || event.type !== 'output'
      || typeof event.text !== 'string'
      || event.text.length > 0
    )));
    const allText = parsed.events.map((event) => (event && typeof event.text === 'string' ? event.text : '')).join('');
    assert.match(allText, /build complete/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_wait_terminal matches idle condition when terminal is quiet', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'wait-idle-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const waited = await call('tools/call', {
      name: 'hop_wait_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        idle_ms: 120,
        max_wait_ms: 1200,
        capture: 'raw'
      }
    });
    const parsed = JSON.parse(waited.result.content[0].text);

    assert.equal(parsed.status, 'matched');
    assert.equal(parsed.matched, 'idle');
    assert.equal(parsed.captureMode, 'raw');
    assert.equal(typeof parsed.waitedMs, 'number');
    assert.ok(parsed.waitedMs >= 100);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_wait_terminal defaults to until_agent_done when no condition is provided', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'wait-agent-done-default-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: 'TASK_COMPLETE\n' }
    });

    const waited = await call('tools/call', {
      name: 'hop_wait_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        start_from: 'beginning',
        max_wait_ms: 2500,
        capture: 'readable_raw'
      }
    });
    const parsed = JSON.parse(waited.result.content[0].text);
    const text = (parsed.events || [])
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');

    assert.equal(parsed.status, 'matched');
    assert.equal(parsed.matched, 'agent_done');
    assert.equal(parsed.untilAgentDone, true);
    assert.equal(parsed.startFrom, 'beginning');
    assert.equal(parsed.next_cursor, parsed.cursorEnd);
    assert.match(text, /TASK_COMPLETE/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_wait_start and hop_wait_poll support async regex waits', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'wait-async-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const started = await call('tools/call', {
      name: 'hop_wait_start',
      arguments: {
        terminal_id: createdPayload.id,
        start_from: 'latest',
        until_regex: 'ASYNC_READY',
        capture: 'readable_raw',
        max_wait_ms: 2500
      }
    });
    const startedPayload = JSON.parse(started.result.content[0].text);
    assert.equal(startedPayload.done, false);
    assert.equal(startedPayload.status, 'pending');
    assert.equal(typeof startedPayload.wait_id, 'string');
    assert.ok(startedPayload.wait_id.length > 0);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: 'ASYNC_READY\n' }
    });

    const polled = await call('tools/call', {
      name: 'hop_wait_poll',
      arguments: {
        wait_id: startedPayload.wait_id,
        wait: true,
        max_wait_ms: 2500
      }
    });
    const polledPayload = JSON.parse(polled.result.content[0].text);
    const waitResult = polledPayload.result || {};
    const text = (waitResult.events || [])
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');

    assert.equal(polledPayload.done, true);
    assert.equal(polledPayload.status, 'matched');
    assert.equal(waitResult.matched, 'regex');
    assert.match(text, /ASYNC_READY/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn supports wait-only mode without input actions', async () => {
  const { server, port } = await startMockHopStreamServer({
    startupOutput: 'READY_WAIT_ONLY\n'
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-wait-only-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        control: 'wait',
        start_from: 'beginning',
        until_regex: 'READY_WAIT_ONLY'
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);

    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.selected_mode, 'readable_raw');
    assert.equal(turnPayload.waited, true);
    assert.match(turnPayload.wait.text || '', /READY_WAIT_ONLY/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn supports async send and poll with wait_id', async () => {
  const marker = 'ASYNC_TURN_MARKER';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return [{ data: 'ASYNC_TURN_DONE\n', delayMs: 100 }];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-async-turn-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const started = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        data: marker,
        async: true,
        until_regex: 'ASYNC_TURN_DONE',
        max_wait_ms: 2000
      }
    });
    const startedPayload = JSON.parse(started.result.content[0].text);

    assert.equal(startedPayload.helper, 'hopx_agent_turn');
    assert.equal(startedPayload.async, true);
    assert.equal(startedPayload.done, false);
    assert.equal(startedPayload.status, 'pending');
    assert.equal(typeof startedPayload.wait_id, 'string');
    assert.ok(startedPayload.wait_id.length > 0);

    const polled = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        wait_id: startedPayload.wait_id,
        wait: true,
        max_wait_ms: 2000
      }
    });
    const polledPayload = JSON.parse(polled.result.content[0].text);

    assert.equal(polledPayload.helper, 'hopx_agent_turn');
    assert.equal(polledPayload.async, true);
    assert.equal(polledPayload.done, true);
    assert.equal(polledPayload.status, 'matched');
    assert.match((polledPayload.wait && polledPayload.wait.text) || '', /ASYNC_TURN_DONE/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn interrupt control sends default interrupt key without waiting', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-interrupt-control-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        control: 'interrupt',
        wait: false
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);

    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.waited, false);
    assert.deepEqual(turnPayload.sent.map((entry) => entry.source), ['key:esc']);

    const read = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: { terminal_id: createdPayload.id, start_from: 'beginning', maxEvents: 20 }
    });
    const readPayload = JSON.parse(read.result.content[0].text);
    const output = (readPayload.events || [])
      .filter((event) => event && event.type === 'output' && typeof event.data === 'string')
      .map((event) => event.data)
      .join('');
    assert.match(output, /\u001b/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_send_and_wait defaults to condensed readable wait text', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'send-and-wait-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const sent = await call('tools/call', {
      name: 'hopx_send_and_wait',
      arguments: {
        terminal_id: createdPayload.id,
        data: 'SENT_AND_WAIT_MARKER\n',
        max_wait_ms: 2500,
        capture: 'readable_raw'
      }
    });
    const parsed = JSON.parse(sent.result.content[0].text);
    const waitPayload = parsed.wait || {};

    assert.equal(parsed.ok, true);
    assert.equal(parsed.waited, true);
    assert.equal(waitPayload.status, 'matched');
    assert.equal(waitPayload.matched, 'agent_done');
    assert.equal(waitPayload.next_cursor, waitPayload.cursorEnd);
    assert.equal(waitPayload.eventCount, 0);
    assert.deepEqual(waitPayload.events, []);
    assert.equal(typeof waitPayload.originalEventCount, 'number');
    assert.ok(waitPayload.originalEventCount > 0);
    assert.equal(typeof waitPayload.text, 'string');
    assert.match(waitPayload.text, /SENT_AND_WAIT_MARKER/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_send_and_wait text_only=true returns condensed readable wait payload', async () => {
  const marker = 'HOPX_SEND_TEXT_ONLY';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return ['TEXT_ONLY_RESULT_1\n', 'TEXT_ONLY_RESULT_2\n'];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'send-and-wait-text-only-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const sent = await call('tools/call', {
      name: 'hopx_send_and_wait',
      arguments: {
        terminal_id: createdPayload.id,
        data: marker,
        text_only: true,
        max_wait_ms: 2500,
        capture: 'readable_raw'
      }
    });
    const parsed = JSON.parse(sent.result.content[0].text);
    const waitPayload = parsed.wait || {};

    assert.equal(parsed.ok, true);
    assert.equal(waitPayload.captureMode, 'readable_raw');
    assert.equal(waitPayload.eventCount, 0);
    assert.deepEqual(waitPayload.events, []);
    assert.equal(typeof waitPayload.originalEventCount, 'number');
    assert.ok(waitPayload.originalEventCount > 0);
    assert.equal(typeof waitPayload.text, 'string');
    assert.match(waitPayload.text, /TEXT_ONLY_RESULT_1/);
    assert.match(waitPayload.text, /TEXT_ONLY_RESULT_2/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_send_and_wait keeps readable wait events when text_only=false', async () => {
  const marker = 'HOPX_SEND_DEFAULT_BEHAVIOR';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return ['DEFAULT_BEHAVIOR_RESULT\n'];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'send-and-wait-default-behavior-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const sent = await call('tools/call', {
      name: 'hopx_send_and_wait',
      arguments: {
        terminal_id: createdPayload.id,
        data: marker,
        text_only: false,
        max_wait_ms: 2500,
        capture: 'readable_raw'
      }
    });
    const parsed = JSON.parse(sent.result.content[0].text);
    const waitPayload = parsed.wait || {};
    const text = (waitPayload.events || [])
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');

    assert.equal(waitPayload.captureMode, 'readable_raw');
    assert.ok(Array.isArray(waitPayload.events));
    assert.ok(waitPayload.events.length > 0);
    assert.equal(waitPayload.eventCount, waitPayload.events.length);
    assert.equal(Object.prototype.hasOwnProperty.call(waitPayload, 'text'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(waitPayload, 'originalEventCount'), false);
    assert.match(text, /DEFAULT_BEHAVIOR_RESULT/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn auto mode defaults to readable_raw for non-TUI terminal', async () => {
  const { server, port } = await startMockHopStreamServer();
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-auto-mode-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        data: 'echo HOPX_AUTO_MODE'
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);
    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.helper, 'hopx_agent_turn');
    assert.equal(turnPayload.selected_mode, 'readable_raw');
    assert.equal(turnPayload.waited, true);
    assert.ok(turnPayload.wait && typeof turnPayload.wait === 'object');
    assert.equal(turnPayload.wait.captureMode, 'readable_raw');
    assert.equal(turnPayload.wait.eventCount, 0);
    assert.deepEqual(turnPayload.wait.events, []);
    assert.equal(typeof turnPayload.wait.originalEventCount, 'number');
    assert.ok(turnPayload.wait.originalEventCount > 0);
    assert.equal(typeof turnPayload.wait.text, 'string');
    assert.match(turnPayload.wait.text, /HOPX_AUTO_MODE/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn readable path supports text_only=true condensed wait payload', async () => {
  const marker = 'HOPX_TURN_TEXT_ONLY';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return ['TURN_TEXT_ONLY_RESULT\n', 'TURN_TEXT_ONLY_DONE\n'];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-turn-readable-text-only-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        data: marker,
        text_only: true
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);
    const waitPayload = turnPayload.wait || {};

    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.selected_mode, 'readable_raw');
    assert.equal(waitPayload.captureMode, 'readable_raw');
    assert.equal(waitPayload.eventCount, 0);
    assert.deepEqual(waitPayload.events, []);
    assert.equal(typeof waitPayload.originalEventCount, 'number');
    assert.ok(waitPayload.originalEventCount > 0);
    assert.equal(typeof waitPayload.text, 'string');
    assert.match(waitPayload.text, /TURN_TEXT_ONLY_RESULT/);
    assert.match(waitPayload.text, /TURN_TEXT_ONLY_DONE/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn readable path keeps wait events when text_only=false', async () => {
  const marker = 'HOPX_TURN_TEXT_ONLY_FALSE';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return ['TURN_TEXT_ONLY_FALSE_RESULT\n'];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-turn-readable-text-only-false-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        data: marker,
        text_only: false
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);
    const waitPayload = turnPayload.wait || {};
    const text = (waitPayload.events || [])
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');

    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.selected_mode, 'readable_raw');
    assert.equal(waitPayload.captureMode, 'readable_raw');
    assert.ok(Array.isArray(waitPayload.events));
    assert.ok(waitPayload.events.length > 0);
    assert.equal(waitPayload.eventCount, waitPayload.events.length);
    assert.equal(Object.prototype.hasOwnProperty.call(waitPayload, 'text'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(waitPayload, 'originalEventCount'), false);
    assert.match(text, /TURN_TEXT_ONLY_FALSE_RESULT/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn auto mode promotes to ui when alternate screen appears during the same turn', async () => {
  const marker = 'LAUNCH_TUI';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return [
          { data: '', alternateScreen: true, cursorHidden: true },
          { data: 'TUI_FRAME_1\n', alternateScreen: true, cursorHidden: true }
        ];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-auto-promote-ui-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        data: marker,
        until_regex: 'TUI_FRAME_1',
        max_wait_ms: 2500
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);
    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.selected_mode, 'ui');
    assert.equal(turnPayload.auto_switched_to_ui, true);
    assert.ok(turnPayload.output && typeof turnPayload.output === 'object');
    assert.equal(turnPayload.output.mode, 'ui');
    assert.ok(!Object.prototype.hasOwnProperty.call(turnPayload.output, 'rawTail'));
    assert.equal(turnPayload.wait.eventCount, 0);
    assert.deepEqual(turnPayload.wait.events, []);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn mode=ui respects capture_max_events override', async () => {
  const marker = 'UI_OVERRIDE_CAPTURE';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return ['RESULT_UI\n'];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-ui-capture-override-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'ui',
        data: marker,
        until_regex: 'RESULT_UI',
        capture_max_events: 5,
        max_wait_ms: 2500
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);
    const waitEvents = (turnPayload.wait && Array.isArray(turnPayload.wait.events)) ? turnPayload.wait.events : [];
    const waitText = waitEvents
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');

    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.selected_mode, 'ui');
    assert.equal(turnPayload.wait.captureMode, 'readable_raw');
    assert.ok(waitEvents.length > 0);
    assert.ok(waitEvents.length <= 5);
    assert.match(waitText, /RESULT_UI/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn mode=ui applies busy guard for default agent_done waits', async () => {
  const marker = 'UI_BUSY_GUARD';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return [
          { data: '• Working (1s • esc to interrupt)' },
          { data: '\rDONE_UI_BUSY_GUARD\n', delayMs: 1700 }
        ];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-ui-busy-guard-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'ui',
        data: marker,
        max_wait_ms: 6000
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);
    const waitPayload = turnPayload.wait || {};
    const guardPayload = waitPayload.uiBusyGuard || {};
    const uiText = (((turnPayload.output || {}).ui || {}).lines || [])
      .map((line) => (line && typeof line.text === 'string' ? line.text : ''))
      .join('\n');

    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.selected_mode, 'ui');
    assert.equal(guardPayload.applied, true);
    assert.equal(guardPayload.busy, false);
    assert.equal(typeof guardPayload.waitedMs, 'number');
    assert.ok(guardPayload.waitedMs >= 300);
    assert.match(uiText, /DONE_UI_BUSY_GUARD/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn default readable path keeps shell result and suppresses prompt echo', async () => {
  const marker = 'SHOW_STATUS';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return [`PROMPT> ${marker}\n`, 'status:ok\nnext:idle\n'];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-shell-default-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        data: marker
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);
    const text = (turnPayload.wait && typeof turnPayload.wait.text === 'string')
      ? turnPayload.wait.text
      : '';

    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.selected_mode, 'readable_raw');
    assert.equal(turnPayload.wait.eventCount, 0);
    assert.deepEqual(turnPayload.wait.events, []);
    assert.equal(typeof turnPayload.wait.originalEventCount, 'number');
    assert.ok(turnPayload.wait.originalEventCount > 0);
    assert.match(text, /status:ok/);
    assert.match(text, /next:idle/);
    assert.ok(!text.includes(`PROMPT> ${marker}`), `expected prompt echo to be suppressed, got: ${text}`);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn default readable path collapses rewrite progress noise', async () => {
  const marker = 'BUILD_PROGRESS';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return [
          '\rBuilding 10%',
          '\rBuilding 30%',
          '\rBuilding 60%',
          '\rBuilding 100%\n',
          'Build complete\n'
        ];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-progress-default-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        data: marker
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);
    const text = (turnPayload.wait && typeof turnPayload.wait.text === 'string')
      ? turnPayload.wait.text
      : '';

    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.selected_mode, 'readable_raw');
    assert.equal(turnPayload.wait.eventCount, 0);
    assert.deepEqual(turnPayload.wait.events, []);
    assert.equal(typeof turnPayload.wait.originalEventCount, 'number');
    assert.ok(turnPayload.wait.originalEventCount > 0);
    assert.match(text, /Build complete/);
    assert.ok(!text.includes('Building 10%'), `expected early progress rewrite to be compacted, got: ${text}`);
    assert.ok(!text.includes('Building 30%'), `expected early progress rewrite to be compacted, got: ${text}`);
    assert.ok(!text.includes('Building 60%'), `expected early progress rewrite to be compacted, got: ${text}`);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_agent_turn helper default keeps only recent tail for large outputs', async () => {
  const marker = 'BURST_LINES';
  const baseTs = Date.now();
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output !== marker) return null;
      const chunks = [];
      for (let i = 1; i <= 90; i += 1) {
        chunks.push({ data: `L${i}\n`, timestamp: baseTs + (i * 500) });
      }
      chunks.push({ data: 'DONE\n', timestamp: baseTs + (91 * 500) });
      return chunks;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'hopx-tail-default-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const turn = await call('tools/call', {
      name: 'hopx_agent_turn',
      arguments: {
        terminal_id: createdPayload.id,
        data: marker,
        max_wait_ms: 3000
      }
    });
    const turnPayload = JSON.parse(turn.result.content[0].text);
    const text = (turnPayload.wait && typeof turnPayload.wait.text === 'string')
      ? turnPayload.wait.text
      : '';

    assert.equal(turnPayload.ok, true);
    assert.equal(turnPayload.selected_mode, 'readable_raw');
    assert.equal(turnPayload.wait.eventCount, 0);
    assert.deepEqual(turnPayload.wait.events, []);
    assert.equal(typeof turnPayload.wait.originalEventCount, 'number');
    assert.ok(turnPayload.wait.originalEventCount <= 60, `expected helper tail cap of 60 events, got ${turnPayload.wait.originalEventCount}`);
    assert.match(text, /^L90$/m);
    assert.match(text, /^DONE$/m);
    assert.doesNotMatch(text, /^L1$/m);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal ui mode returns screen snapshot and raw tail', async () => {
  const { server, port } = await startMockHopStreamServer();
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'ui-mode-test', cols: 90, rows: 20 } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const marker = 'UI_MODE_MARKER';
    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: `echo ${marker}\r\n` }
    });

    let cursor = null;
    let payload = null;
    let foundMarker = false;
    for (let i = 0; i < 5; i++) {
      const read = await call('tools/call', {
        name: 'hop_read_terminal',
        arguments: {
          terminal_id: createdPayload.id,
          mode: 'ui',
          cursor,
          maxEvents: 100,
          includeRawTail: true,
          rawTailMaxEvents: 25
        }
      });
      payload = JSON.parse(read.result.content[0].text);
      cursor = payload.cursor;
      const rawTail = Array.isArray(payload.rawTail) ? payload.rawTail : [];
      const rawText = rawTail
        .filter((event) => event && typeof event.data === 'string')
        .map((event) => event.data)
        .join('');
      if (rawText.includes(marker)) {
        foundMarker = true;
        break;
      }
    }

    assert.ok(payload);
    assert.equal(payload.mode, 'ui');
    assert.ok(Array.isArray(payload.rawTail));
    assert.ok(foundMarker, 'rawTail should contain recent output');
    assert.equal(typeof payload.eventCount, 'number');
    assert.equal(typeof payload.ui, 'object');

    if (payload.ui.available) {
      assert.ok(Array.isArray(payload.ui.lines));
      const visibleText = payload.ui.lines.map((line) => line.text).join('\n');
      assert.match(visibleText, /UI_MODE_MARKER/);
      assert.equal(typeof payload.ui.cursor.x, 'number');
      assert.equal(typeof payload.ui.cursor.y, 'number');
    } else {
      assert.equal(typeof payload.ui.reason, 'string');
    }
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw preserves text with compact controls', async () => {
  const { server, port } = await startMockHopStreamServer();
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-raw-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const payloadWithAnsi = `READ_A\u001b[?25lREAD_B\u001b[?25h\rREAD_C\n`;
    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: payloadWithAnsi }
    });

    let cursor = null;
    const collected = [];
    for (let i = 0; i < 5; i++) {
      const read = await call('tools/call', {
        name: 'hop_read_terminal',
        arguments: {
          terminal_id: createdPayload.id,
          mode: 'readable_raw',
          control_level: 'full',
          cursor,
          maxEvents: 100
        }
      });
      const parsed = JSON.parse(read.result.content[0].text);
      assert.equal(parsed.mode, 'readable_raw');
      cursor = parsed.cursor;
      if (Array.isArray(parsed.events)) {
        collected.push(...parsed.events);
      }
      const text = collected
        .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
        .join('');
      if (text.includes('READ_C')) {
        break;
      }
    }

    const allText = collected
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');
    assert.match(allText, /READ_A/);
    assert.match(allText, /READ_B/);
    assert.match(allText, /READ_C/);

    const controls = collected
      .flatMap((event) => (event && Array.isArray(event.controls) ? event.controls : []));

    assert.ok(controls.some((control) => control.kind === 'cursor_visibility' && control.visible === false));
    assert.ok(controls.some((control) => control.kind === 'cursor_visibility' && control.visible === true));
    assert.ok(controls.some((control) => control.kind === 'carriage_return'));
    assert.ok(controls.some((control) => control.kind === 'line_feed'));
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw excludes meta events by default', async () => {
  const { server, port } = await startMockHopStreamServer();
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-meta-default-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const read = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        maxEvents: 40
      }
    });

    const parsed = JSON.parse(read.result.content[0].text);
    assert.ok(Array.isArray(parsed.events));
    assert.ok(parsed.events.every((event) => (
      event
      && typeof event === 'object'
      && (event.type === 'output' || event.type === 'snapshot')
    )));
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw supports structural control filtering', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-structural-controls-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: `A\u001b[31mB\u001b[0m\rC\n` }
    });

    const read = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        control_level: 'structural',
        maxEvents: 40
      }
    });

    const parsed = JSON.parse(read.result.content[0].text);
    const controls = parsed.events
      .flatMap((event) => (event && Array.isArray(event.controls) ? event.controls : []));
    const allowedKinds = new Set([
      'backspace',
      'cursor',
      'erase_line',
      'erase_display',
      'insert_chars',
      'delete_chars',
      'alternate_screen'
    ]);

    assert.ok(!controls.some((control) => control.kind === 'sgr'));
    assert.ok(!controls.some((control) => control.kind === 'carriage_return'));
    assert.ok(!controls.some((control) => control.kind === 'line_feed'));
    assert.ok(controls.every((control) => allowedKinds.has(control.kind)));
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw coalesces adjacent output frames', async () => {
  const marker = 'COALESCE_ABC';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => (output === marker ? ['COA', 'LES', 'CE_', 'ABC'] : null)
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-coalesce-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: marker }
    });

    const read = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        control_level: 'none',
        coalesce_ms: 500,
        maxEvents: 80
      }
    });

    const parsed = JSON.parse(read.result.content[0].text);
    const outputEvents = parsed.events
      .filter((event) => event && event.type === 'output' && typeof event.text === 'string' && event.text.length > 0);
    const allText = outputEvents.map((event) => event.text).join('');

    assert.match(allText, /COALESCE_ABC/);
    assert.equal(outputEvents.length, 1);
    assert.ok(outputEvents.every((event) => !Object.prototype.hasOwnProperty.call(event, 'controls')));
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw default balanced noise filter suppresses rewrite bursts', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-noise-balanced-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const spinnerFrames = ['\rSpinning...', '\rSpinning...', '\rSpinning...'];
    for (const frame of spinnerFrames) {
      await call('tools/call', {
        name: 'hop_write_terminal',
        arguments: { terminal_id: createdPayload.id, data: frame }
      });
    }
    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: 'DONE\n' }
    });

    const read = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        maxEvents: 120
      }
    });
    const parsed = JSON.parse(read.result.content[0].text);
    const text = (parsed.events || [])
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');

    assert.match(text, /DONE/);
    assert.ok(!/Spinning/.test(text), `expected spinner/status burst to be suppressed, got: ${text}`);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw noise_filter=off preserves rewrite burst text', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-noise-off-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const spinnerFrames = ['\rSpinning...', '\rSpinning...', '\rSpinning...'];
    for (const frame of spinnerFrames) {
      await call('tools/call', {
        name: 'hop_write_terminal',
        arguments: { terminal_id: createdPayload.id, data: frame }
      });
    }

    const read = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        noise_filter: 'off',
        maxEvents: 120
      }
    });
    const parsed = JSON.parse(read.result.content[0].text);
    const text = (parsed.events || [])
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');

    assert.match(text, /Spinning/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_send_and_wait readable_raw balanced suppresses prompt command echo for recent input', async () => {
  const marker = 'LIST_TASKS';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return [`PROMPT> ${marker}\n`, 'RESULT_OK\n'];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-echo-balanced-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const sent = await call('tools/call', {
      name: 'hopx_send_and_wait',
      arguments: {
        terminal_id: createdPayload.id,
        data: marker,
        max_wait_ms: 2500,
        capture: 'readable_raw'
      }
    });
    const parsed = JSON.parse(sent.result.content[0].text);
    const text = (parsed.wait && typeof parsed.wait.text === 'string')
      ? parsed.wait.text
      : (((parsed.wait && parsed.wait.events) || [])
        .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
        .join(''));

    assert.match(text, /RESULT_OK/);
    assert.ok(!text.includes(`PROMPT> ${marker}`), `expected prompt command echo to be suppressed, got: ${text}`);
  } finally {
    child.kill();
    server.close();
  }
});

test('hopx_send_and_wait readable_raw balanced suppresses rewrite echo without prompt prefix', async () => {
  const marker = 'NO_PROMPT_ECHO_CMD';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return [`\r${marker}\nRESULT_OK\n`];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-echo-rewrite-balanced-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const sent = await call('tools/call', {
      name: 'hopx_send_and_wait',
      arguments: {
        terminal_id: createdPayload.id,
        data: marker,
        max_wait_ms: 2500,
        capture: 'readable_raw'
      }
    });
    const parsed = JSON.parse(sent.result.content[0].text);
    const text = (parsed.wait && typeof parsed.wait.text === 'string')
      ? parsed.wait.text
      : (((parsed.wait && parsed.wait.events) || [])
        .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
        .join(''));

    assert.match(text, /RESULT_OK/);
    assert.ok(!text.includes(marker), `expected rewrite command echo to be suppressed, got: ${text}`);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw balanced suppresses prompt-padding artifact lines', async () => {
  const marker = 'PROMPT_PADDING_CASE';
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    outputChunker: (output) => {
      if (output === marker) {
        return ['        (base) user@host project % \nACTUAL_OUTPUT\n'];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-prompt-padding-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        data: marker
      }
    });

    const read = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        maxEvents: 80
      }
    });
    const parsed = JSON.parse(read.result.content[0].text);
    const text = (parsed.events || [])
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');

    assert.match(text, /ACTUAL_OUTPUT/);
    assert.ok(!/\(base\) user@host project %/.test(text), `expected prompt-padding artifact to be suppressed, got: ${text}`);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw balanced commits a single stable rewrite line', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-noise-stable-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: '\rPROMPT> ' }
    });

    const firstRead = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        maxEvents: 60
      }
    });
    const firstPayload = JSON.parse(firstRead.result.content[0].text);
    const firstText = (firstPayload.events || [])
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');
    assert.ok(!/PROMPT>/.test(firstText), `expected rewrite line to be pending initially, got: ${firstText}`);

    await delay(900);

    const secondRead = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        cursor: firstPayload.cursor,
        maxEvents: 60
      }
    });
    const secondPayload = JSON.parse(secondRead.result.content[0].text);
    const secondText = (secondPayload.events || [])
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');
    assert.match(secondText, /PROMPT>/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw preserves spacing from cursor-right moves', async () => {
  const { server, port } = await startMockHopStreamServer();
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-spacing-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: `A\x1b[5CB` }
    });

    const read = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'readable_raw',
        maxEvents: 20
      }
    });
    const parsed = JSON.parse(read.result.content[0].text);
    const allText = parsed.events
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');

    assert.match(allText, /A {5}B/);
    assert.ok(parsed.events.every((event) => !event || !Object.prototype.hasOwnProperty.call(event, 'controls')));
    assert.ok(parsed.events.every((event) => (
      !event
      || event.type !== 'output'
      || typeof event.text !== 'string'
      || event.text.length > 0
    )));
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw handles ANSI sequences split across output events', async () => {
  const { server, port } = await startMockHopStreamServer({
    outputChunker: (output) => {
      if (output === 'A\x1b[31mB\x1b[0mC') {
        return ['A\x1b[', '31mB\x1b[', '0mC'];
      }
      return null;
    }
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'readable-split-ansi-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: 'A\x1b[31mB\x1b[0mC' }
    });

    let cursor = null;
    const collected = [];
    for (let i = 0; i < 5; i++) {
      const read = await call('tools/call', {
        name: 'hop_read_terminal',
        arguments: {
          terminal_id: createdPayload.id,
          mode: 'readable_raw',
          control_level: 'full',
          cursor,
          maxEvents: 50
        }
      });
      const parsed = JSON.parse(read.result.content[0].text);
      cursor = parsed.cursor;
      if (Array.isArray(parsed.events)) {
        collected.push(...parsed.events);
      }
      const text = collected
        .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
        .join('');
      if (text.includes('ABC')) {
        break;
      }
    }

    const allText = collected
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');
    const allControls = collected
      .flatMap((event) => (event && Array.isArray(event.controls) ? event.controls : []));

    assert.match(allText, /ABC/);
    assert.ok(!allText.includes('[31m'));
    assert.ok(allControls.some((control) => control.kind === 'sgr' && Array.isArray(control.params) && control.params[0] === 31));
    assert.ok(allControls.some((control) => control.kind === 'sgr' && Array.isArray(control.params) && control.params[0] === 0));
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal readable_raw rewrites backspace-edited text without duplicate prefix', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'readable-backspace-rewrite-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: 'c\x08claude' }
    });

    let cursor = null;
    let allText = '';
    for (let i = 0; i < 5; i += 1) {
      const read = await call('tools/call', {
        name: 'hop_read_terminal',
        arguments: {
          terminal_id: createdPayload.id,
          mode: 'readable_raw',
          cursor,
          maxEvents: 50
        }
      });
      const parsed = JSON.parse(read.result.content[0].text);
      cursor = parsed.cursor;
      allText += (parsed.events || [])
        .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
        .join('');
      if (allText.includes('claude')) break;
    }

    assert.match(allText, /claude/);
    assert.ok(!allText.includes('cclaude'));
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal parses CRLF-delimited SSE event blocks', async () => {
  const { server, port } = await startMockHopStreamServer({ eventDelimiter: '\r\n\r\n' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'crlf-stream-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const marker = 'CRLF_MARKER';
    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: `echo ${marker}\r\n` }
    });

    let payload = null;
    let output = '';
    for (let i = 0; i < 5; i++) {
      const read = await call('tools/call', {
        name: 'hop_read_terminal',
        arguments: { terminal_id: createdPayload.id, maxEvents: 20 }
      });
      payload = JSON.parse(read.result.content[0].text);
      output += payload.events
        .filter((event) => event.type === 'output')
        .map((event) => event.data)
        .join('');
      if (output.includes(marker)) break;
    }

    assert.ok(payload);
    assert.match(output, /CRLF_MARKER/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal ui mode with small uiMaxLines tracks cursor region', async () => {
  const { server, port } = await startMockHopStreamServer();
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'ui-window-test', cols: 100, rows: 20 }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const output = ['ROW_1', 'ROW_2', 'ROW_3', 'ROW_4', 'ROW_5', 'ROW_6', 'ROW_7', 'ROW_8'].join('\r\n');
    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: output }
    });

    let payload = null;
    for (let i = 0; i < 5; i++) {
      const read = await call('tools/call', {
        name: 'hop_read_terminal',
        arguments: {
          terminal_id: createdPayload.id,
          mode: 'ui',
          uiMaxLines: 5,
          includeRawTail: false,
          maxEvents: 50
        }
      });
      payload = JSON.parse(read.result.content[0].text);
      if (payload.ui && payload.ui.available) {
        const visible = payload.ui.lines.map((line) => line.text).join('\n');
        if (visible.includes('ROW_8')) break;
      }
    }

    assert.ok(payload && payload.ui && payload.ui.available);
    const visible = payload.ui.lines.map((line) => line.text).join('\n');
    assert.match(visible, /ROW_8/);
    assert.equal(typeof payload.ui.window.cursorRow, 'number');
  } finally {
    child.kill();
    server.close();
  }
});

test('connect_server rejects non-http(s) base_url', async () => {
  const { child, call } = startMcp({});

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const result = await call('tools/call', { name: 'connect_server', arguments: { base_url: 'ftp://example.com' } });
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /http\(s\)/);
  } finally {
    child.kill();
  }
});

test('hop tools return MCP isError on API failure payloads', async () => {
  const { server, port } = await startMockHopSessionsFailureServer(503);
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const result = await call('tools/call', { name: 'hop_list_sessions', arguments: {} });
    assert.equal(result.result.isError, true);
    const payload = JSON.parse(result.result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, 503);
    assert.equal(payload.endpoint, '/api/sessions');
    assert.equal(typeof payload.error, 'object');
  } finally {
    child.kill();
    server.close();
  }
});

test('connect_server verify checks endpoint before saving connection', async () => {
  const { server, port } = await startMockHopServer();
  const { child, call } = startMcp({
    HOP_API_URL: '',
    HOP_TOKEN: '',
    HOP_STATE_FILE: path.join(__dirname, '.missing-hop-state')
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const connect = await call('tools/call', {
      name: 'connect_server',
      arguments: {
        base_url: `http://127.0.0.1:${port}`,
        verify: true
      }
    });
    assert.equal(connect.result.isError, undefined);
    assert.match(connect.result.content[0].text, /Connected to/);

    const info = await call('tools/call', { name: 'hop_server_info', arguments: {} });
    const parsed = JSON.parse(info.result.content[0].text);
    assert.equal(parsed.connection.configured, true);
    assert.equal(parsed.connection.baseUrl, `http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    server.close();
  }
});

test('connect_server verify failure returns error and does not persist connection', async () => {
  const { server, port } = await startMockHopSessionsFailureServer(401);
  const { child, call } = startMcp({
    HOP_API_URL: '',
    HOP_TOKEN: '',
    HOP_STATE_FILE: path.join(__dirname, '.missing-hop-state')
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const connect = await call('tools/call', {
      name: 'connect_server',
      arguments: {
        base_url: `http://127.0.0.1:${port}`,
        verify: true
      }
    });
    assert.equal(connect.result.isError, true);
    const payload = JSON.parse(connect.result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, 401);
    assert.equal(payload.endpoint, '/api/sessions');

    const info = await call('tools/call', { name: 'hop_server_info', arguments: {} });
    const parsed = JSON.parse(info.result.content[0].text);
    assert.equal(parsed.connection.configured, false);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_wait_terminal supports start_from beginning for buffered output', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: 'BOOT_READY\n' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });
    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'wait-start-from-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const latest = await call('tools/call', {
      name: 'hop_wait_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        start_from: 'latest',
        until_regex: 'BOOT_READY',
        max_wait_ms: 250,
        capture: 'readable_raw'
      }
    });
    const latestPayload = JSON.parse(latest.result.content[0].text);
    assert.equal(latestPayload.status, 'timed_out');

    const beginning = await call('tools/call', {
      name: 'hop_wait_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        start_from: 'beginning',
        until_regex: 'BOOT_READY',
        max_wait_ms: 1000,
        capture: 'readable_raw'
      }
    });
    const beginningPayload = JSON.parse(beginning.result.content[0].text);
    assert.equal(beginningPayload.status, 'matched');
    assert.equal(beginningPayload.matched, 'regex');
    assert.equal(beginningPayload.startFrom, 'beginning');
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_wait_terminal start_from cursor requires cursor argument', async () => {
  const { server, port } = await startMockHopStreamServer();
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });
    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'wait-start-cursor-error' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const waited = await call('tools/call', {
      name: 'hop_wait_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        start_from: 'cursor',
        until_prompt: true
      }
    });
    assert.equal(waited.result.isError, true);
    assert.match(waited.result.content[0].text, /requires cursor/);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal supports start_from cursor for deterministic deltas', async () => {
  const { server, port } = await startMockHopStreamServer({ startupOutput: 'BOOT_READY\n' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });
    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'read-start-delta-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const firstRead = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'raw',
        start_from: 'beginning',
        maxEvents: 60
      }
    });
    const firstPayload = JSON.parse(firstRead.result.content[0].text);
    const firstText = (firstPayload.events || [])
      .filter((event) => event && event.type === 'output' && typeof event.data === 'string')
      .map((event) => event.data)
      .join('');
    assert.match(firstText, /BOOT_READY/);
    assert.equal(firstPayload.startFrom, 'beginning');
    assert.equal(firstPayload.next_cursor, firstPayload.cursorEnd);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: 'DELTA_ONLY\n' }
    });

    const secondRead = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'raw',
        start_from: 'cursor',
        cursor: firstPayload.cursorEnd,
        maxEvents: 60
      }
    });
    const secondPayload = JSON.parse(secondRead.result.content[0].text);
    const secondText = (secondPayload.events || [])
      .filter((event) => event && event.type === 'output' && typeof event.data === 'string')
      .map((event) => event.data)
      .join('');
    assert.equal(secondPayload.startFrom, 'cursor');
    assert.equal(secondPayload.cursorStart, firstPayload.cursorEnd);
    assert.equal(secondPayload.next_cursor, secondPayload.cursorEnd);
    assert.match(secondText, /DELTA_ONLY/);
    assert.ok(!/BOOT_READY/.test(secondText));
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal keeps cursor=0 on empty reads before first stream event', async () => {
  const { server, port } = await startMockHopStreamServer({
    startupOutput: '',
    streamReadyDelayMs: 5000
  });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });
    const created = await call('tools/call', { name: 'hop_create_terminal', arguments: { name: 'read-empty-cursor-zero-test' } });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    const firstRead = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'raw',
        start_from: 'beginning',
        maxEvents: 20
      }
    });
    const firstPayload = JSON.parse(firstRead.result.content[0].text);
    assert.deepEqual(firstPayload.events, []);
    assert.equal(firstPayload.cursorStart, 0);
    assert.equal(firstPayload.cursorEnd, 0);
    assert.equal(firstPayload.cursor, 0);
    assert.equal(firstPayload.next_cursor, 0);

    const secondRead = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'raw',
        start_from: 'cursor',
        cursor: firstPayload.cursorEnd,
        maxEvents: 20
      }
    });
    const secondPayload = JSON.parse(secondRead.result.content[0].text);
    assert.deepEqual(secondPayload.events, []);
    assert.equal(secondPayload.cursorStart, 0);
    assert.equal(secondPayload.cursorEnd, 0);
    assert.equal(secondPayload.cursor, 0);
    assert.equal(secondPayload.next_cursor, 0);
  } finally {
    child.kill();
    server.close();
  }
});

test('hop_read_terminal ui mode falls back to densest non-empty window when cursor area is blank', async () => {
  const { server, port } = await startMockHopStreamServer();
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'ui-densest-fallback-test', cols: 100, rows: 20 }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        data: `TOP_A\r\nTOP_B\r\n\x1b[20;1H`
      }
    });

    let payload = null;
    for (let i = 0; i < 5; i++) {
      const read = await call('tools/call', {
        name: 'hop_read_terminal',
        arguments: {
          terminal_id: createdPayload.id,
          mode: 'ui',
          uiMaxLines: 5,
          includeRawTail: false,
          maxEvents: 50
        }
      });
      payload = JSON.parse(read.result.content[0].text);
      if (payload.ui && payload.ui.available) {
        const visible = payload.ui.lines.map((line) => line.text).join('\n');
        if (visible.includes('TOP_A') || visible.includes('TOP_B')) break;
      }
    }

    assert.ok(payload && payload.ui && payload.ui.available);
    const visible = payload.ui.lines.map((line) => line.text).join('\n');
    assert.match(visible, /TOP_[AB]/);
    assert.equal(payload.ui.window.strategy, 'densest_nonempty');
    assert.ok(payload.ui.window.nonEmptyLineCount > 0);
  } finally {
    child.kill();
    server.close();
  }
});

test('terminal-scoped tools auto-recover stale terminal_id after daemon restart', async () => {
  const { server, port, restartDaemon, getAttachCalls } = await startMockHopRecoveryServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'recover-once-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);
    assert.equal(typeof createdPayload.sessionName, 'string');

    restartDaemon();

    const marker = 'RECOVER_ONCE_MARKER';
    const write = await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: `echo ${marker}\n` }
    });
    const writePayload = JSON.parse(write.result.content[0].text);
    assert.equal(writePayload.ok, true);

    const waited = await call('tools/call', {
      name: 'hop_wait_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        start_from: 'beginning',
        until_regex: marker,
        max_wait_ms: 1500,
        capture: 'readable_raw'
      }
    });
    const waitedPayload = JSON.parse(waited.result.content[0].text);
    const text = (waitedPayload.events || [])
      .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
      .join('');

    assert.equal(waitedPayload.status, 'matched');
    assert.equal(waitedPayload.matched, 'regex');
    assert.match(text, new RegExp(marker));
    assert.equal(getAttachCalls(), 1);
  } finally {
    child.kill();
    server.close();
  }
});

test('recovered terminal alias keeps old terminal_id usable without repeated reattach', async () => {
  const { server, port, restartDaemon, getAttachCalls } = await startMockHopRecoveryServer({ startupOutput: '' });
  const { child, call } = startMcp({
    HOP_API_URL: `http://127.0.0.1:${port}`,
    HOP_TOKEN: 'test-token'
  });

  try {
    await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' } });

    const created = await call('tools/call', {
      name: 'hop_create_terminal',
      arguments: { name: 'recover-alias-test' }
    });
    const createdPayload = JSON.parse(created.result.content[0].text);
    assert.ok(createdPayload.id);

    restartDaemon();

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: 'ALIAS_RECOVER_ONE\n' }
    });
    assert.equal(getAttachCalls(), 1);

    await call('tools/call', {
      name: 'hop_write_terminal',
      arguments: { terminal_id: createdPayload.id, data: 'ALIAS_RECOVER_TWO\n' }
    });
    assert.equal(getAttachCalls(), 1);

    const read = await call('tools/call', {
      name: 'hop_read_terminal',
      arguments: {
        terminal_id: createdPayload.id,
        mode: 'raw',
        start_from: 'beginning',
        maxEvents: 100
      }
    });
    const readPayload = JSON.parse(read.result.content[0].text);
    const output = (readPayload.events || [])
      .filter((event) => event && event.type === 'output' && typeof event.data === 'string')
      .map((event) => event.data)
      .join('');

    assert.match(output, /ALIAS_RECOVER_ONE/);
    assert.match(output, /ALIAS_RECOVER_TWO/);
  } finally {
    child.kill();
    server.close();
  }
});
