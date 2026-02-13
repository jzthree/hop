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
    for (const chunk of chunks) {
      const payload = { type: 'output', data: String(chunk), timestamp: Date.now() };
      for (const listener of terminal.listeners) {
        listener.write(`data: ${JSON.stringify(payload)}${eventDelimiter}`);
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
      res.write(`data: ${JSON.stringify({ type: 'ready', timestamp: Date.now() })}${eventDelimiter}`);
      if (startupOutput.length > 0) {
        res.write(`data: ${JSON.stringify({ type: 'output', data: startupOutput, timestamp: Date.now() })}${eventDelimiter}`);
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
    assert.ok(toolNames.includes('hop_create_terminal'));
    assert.ok(toolNames.includes('hop_wait_terminal'));
    assert.ok(!toolNames.includes('hop_exec_terminal'));
    assert.ok(toolNames.includes('hop_server_info'));

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
