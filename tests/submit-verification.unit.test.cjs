const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HopMCPServer,
  detectAgentStartupBlocker,
  extractCodexFinalReply
} = require('../mcp/hop-mcp.js');

test('startup blocker detection rejects auth and workspace trust gates', () => {
  assert.deepEqual(
    detectAgentStartupBlocker('Please run /login · API Error: 401 Invalid authentication credentials'),
    {
      kind: 'authentication_required',
      message: 'The agent CLI is not authenticated.'
    }
  );
  assert.deepEqual(
    detectAgentStartupBlocker('Do you trust the contents of this directory?\nPress enter to continue'),
    {
      kind: 'workspace_trust_required',
      message: 'The agent CLI is waiting for workspace trust confirmation.'
    }
  );
  assert.deepEqual(
    detectAgentStartupBlocker('Update available! 0.1 -> 0.2\n1. Update now\n2. Skip\n3. Skip until next version'),
    {
      kind: 'update_prompt',
      message: 'The agent CLI is waiting at a self-update prompt.'
    }
  );
  assert.deepEqual(
    detectAgentStartupBlocker("error: the argument '--flag' cannot be used multiple times\nUsage: codex [OPTIONS]"),
    {
      kind: 'agent_launch_failed',
      message: 'The agent CLI exited during launch.'
    }
  );
  assert.equal(detectAgentStartupBlocker('› Implement {feature}'), null);
});

test('Codex rollout extraction returns the final answer for the dispatched task', () => {
  const task = '<!-- agent-session: launcher=hop origin=orchestrated --> Read package.json.';
  const events = [
    { payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier task' }] } },
    { payload: { type: 'agent_message', phase: 'final_answer', message: 'Earlier answer' } },
    { payload: { type: 'user_message', message: task } },
    { payload: { type: 'agent_message', phase: 'commentary', message: 'Working' } },
    {
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Useful result.\nHOP_TASK_COMPLETE_ABC' }]
      }
    }
  ];

  assert.equal(extractCodexFinalReply(events, task), 'Useful result.\nHOP_TASK_COMPLETE_ABC');
  assert.equal(extractCodexFinalReply(events, 'Different task'), null);
});

test('submit verification waits through a missing composer and resubmits a parked task', async () => {
  const server = new HopMCPServer();
  const states = [
    { found: false, isEmpty: true, text: '' },
    { found: true, isEmpty: false, text: 'Only after the requested task has succeeded' },
    { found: true, isEmpty: true, text: '' }
  ];
  let enters = 0;

  server.streamManager = {
    flushVirtualScreen: async () => {},
    getComposerState: () => states.shift() || { found: true, isEmpty: true, text: '' }
  };
  server.handleSendAndWait = async (args) => {
    assert.equal(args.press_enter, true);
    assert.equal(args.wait, false);
    enters += 1;
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  };

  const result = await server.verifyHopxSubmitCleared(
    'terminal-1',
    'terminal-1',
    'Task body\n\nOnly after the requested task has succeeded',
    { retries: 3, delayMs: 0 }
  );

  assert.equal(result.verified, true);
  assert.equal(result.reason, 'cleared_after_resend');
  assert.equal(result.resends, 1);
  assert.equal(enters, 1);
});

test('submit verification waits long enough for a delayed multi-line prompt render', async () => {
  const server = new HopMCPServer();
  const states = [
    { found: true, isEmpty: true, text: '' },
    { found: true, isEmpty: true, text: '' },
    { found: true, isEmpty: false, text: 'Prefix:HOP_TASK_COMPLETE_Suffix:ABCDEF0123456789' },
    { found: true, isEmpty: true, text: '' }
  ];
  let enters = 0;

  server.streamManager = {
    flushVirtualScreen: async () => {},
    getComposerState: () => states.shift() || { found: true, isEmpty: true, text: '' }
  };
  server.handleSendAndWait = async () => {
    enters += 1;
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  };

  const result = await server.verifyHopxSubmitCleared(
    'terminal-1',
    'terminal-1',
    'Task body\n\nPrefix: HOP_TASK_COMPLETE_\nSuffix: ABCDEF0123456789',
    { retries: 4, delayMs: 0 }
  );

  assert.equal(result.verified, true);
  assert.equal(result.reason, 'cleared_after_resend');
  assert.equal(result.resends, 1);
  assert.equal(enters, 1);
});

test('composer load verification observes the task before Enter is sent', async () => {
  const server = new HopMCPServer();
  server.streamManager = {
    flushVirtualScreen: async () => {},
    getComposerState: () => ({
      found: true,
      isEmpty: false,
      text: 'Run the delegated audit now'
    })
  };

  const result = await server.waitForHopxComposerLoaded(
    'terminal-1',
    'Run the delegated audit now',
    { timeoutMs: 0, pollMs: 0 }
  );

  assert.equal(result.verified, true);
  assert.equal(result.reason, 'task_rendered');
  assert.equal(result.checks, 1);
});

test('pre-verified task treats a cleared composer as accepted without resending Enter', async () => {
  const server = new HopMCPServer();
  let enters = 0;
  server.streamManager = {
    flushVirtualScreen: async () => {},
    getComposerState: () => ({ found: true, isEmpty: true, text: '' })
  };
  server.handleSendAndWait = async () => {
    enters += 1;
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  };

  const result = await server.verifyHopxSubmitCleared(
    'terminal-1',
    'terminal-1',
    'Run the task',
    { retries: 3, delayMs: 0, preSubmitVerified: true }
  );

  assert.equal(result.verified, true);
  assert.equal(result.reason, 'cleared');
  assert.equal(result.resends, 0);
  assert.equal(enters, 0);
});

test('short-lived MCP processes hydrate terminal session handles for Stop-hook waits', async () => {
  const server = new HopMCPServer();
  server.prewarmTerminalStream = async () => {};
  server.streamManager = {
    getLatestCursor: () => 0,
    readEvents: () => ({ records: [], cursor: 0, error: null })
  };
  server.callApi = async (method, endpoint) => {
    assert.equal(method, 'GET');
    assert.equal(endpoint, '/api/terminals');
    return {
      terminals: [{
        id: 'terminal-1',
        sessionName: 'worker-session',
        displayName: 'Worker'
      }]
    };
  };

  const terminalId = await server.ensureTerminalReadyWithRecovery('terminal-1');

  assert.equal(terminalId, 'terminal-1');
  assert.deepEqual(server.getTerminalHandle('terminal-1'), {
    internalName: 'worker-session',
    sessionName: 'worker-session',
    displayName: 'Worker',
    cols: undefined,
    rows: undefined
  });
});

test('synchronous agent turn stages data, Enter, and wait in that order', async () => {
  const server = new HopMCPServer();
  const calls = [];
  server.ensureTerminalReadyWithRecovery = async () => 'terminal-1';
  server.getTerminalHandle = () => ({ internalName: 'worker-session' });
  server.readTurnCount = () => null;
  server.streamManager = {
    flushVirtualScreen: async () => {},
    getComposerState: () => ({ found: true, isEmpty: true, text: '' }),
    getLatestCursor: () => 12,
    getTerminalFlags: () => ({ exists: true, alternateScreen: false })
  };
  server.waitForHopxComposerLoaded = async () => ({
    applied: true,
    verified: true,
    reason: 'task_rendered',
    checks: 1
  });
  server.verifyHopxSubmitCleared = async () => ({
    applied: true,
    verified: true,
    reason: 'cleared',
    resends: 0
  });
  server.handleSendAndWait = async (args) => {
    calls.push({ ...args });
    if (args.data) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, cursorStart: 12 }) }] };
    }
    if (args.press_enter) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, cursorStart: 13 }) }] };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: true, wait: { status: 'matched', matched: 'agent_done' } })
      }]
    };
  };

  const response = await server.handleHopxAgentTurn({
    terminal_id: 'terminal-1',
    data: 'Do the work',
    verify_submit_delay_ms: 0
  });
  const payload = JSON.parse(response.content[0].text);

  assert.equal(response.isError, undefined);
  assert.equal(payload.ok, true);
  assert.equal(payload.pre_submit.reason, 'task_rendered');
  assert.equal(payload.submit.reason, 'cleared');
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => ({ data: call.data || '', enter: call.press_enter === true, wait: call.wait !== false })),
    [
      { data: 'Do the work', enter: false, wait: false },
      { data: '', enter: true, wait: false },
      { data: '', enter: false, wait: true }
    ]
  );
  assert.equal(calls[2].cursor, 12);
  assert.equal(calls[2].start_from, 'cursor');
});

test('contracted wait results include the transcript assistant reply', async () => {
  const server = new HopMCPServer();
  server.runWaitTerminal = async () => ({
    payload: {
      status: 'matched',
      captureMode: 'readable_raw',
      text: 'terminal redraw noise'
    }
  });
  server.getTerminalHandle = () => ({ internalName: 'worker-session' });
  server.readLastAssistantReplyText = async () => 'Useful worker result.\nDONE-WORKER';

  const job = server.startWaitJob(
    { terminal_id: 'terminal-1', max_wait_ms: 1000 },
    { terminal_id: 'terminal-1', until_reply_regex: 'DONE-WORKER', _sent_data: 'Do work' }
  );
  await job.promise;
  const response = await server.formatHopxAsyncWaitResponse(job, { terminal_id: 'terminal-1' });
  const payload = JSON.parse(response.content[0].text);

  assert.equal(payload.ok, true);
  assert.equal(payload.reply_matched, true);
  assert.equal(payload.assistant_reply, 'Useful worker result.\nDONE-WORKER');
});

test('automatic contracts wait briefly for the useful transcript reply after screen completion', async () => {
  const server = new HopMCPServer();
  const token = 'HOP_TASK_COMPLETE_DELAYED';
  let reads = 0;
  server.runWaitTerminal = async () => ({
    payload: {
      status: 'matched',
      matched: 'regex',
      matchVia: 'screen'
    }
  });
  server.getTerminalHandle = () => ({ internalName: 'worker-session' });
  server.readLastAssistantReplyText = async () => {
    reads += 1;
    return reads === 1
      ? 'Previous worker result.'
      : `Useful delayed result.\n${token}`;
  };

  const job = server.startWaitJob(
    { terminal_id: 'terminal-1', max_wait_ms: 1000 },
    {
      terminal_id: 'terminal-1',
      until_reply_regex: token,
      _sent_data: 'Do work',
      _transcript_settle_ms: 250
    }
  );
  await job.promise;
  const response = await server.formatHopxAsyncWaitResponse(job, { terminal_id: 'terminal-1' });
  const payload = JSON.parse(response.content[0].text);

  assert.ok(reads >= 2);
  assert.equal(payload.ok, true);
  assert.equal(payload.reply_matched, true);
  assert.equal(payload.assistant_reply, `Useful delayed result.\n${token}`);
});
