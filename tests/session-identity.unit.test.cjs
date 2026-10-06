// Which session a process is in: by its shell's place under the host, never
// by an inherited variable when a multiplexer sits in between.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCallerSession, sessionFromEnvLine, isMultiplexer } = require('../lib/session-identity');

const HOST = 1428;
const table = (rows) => (pid) => rows[pid] || null;

test('a command under claude under the session shell resolves by ancestry', () => {
  const readProc = table({
    900: { ppid: 800, command: 'hop view report.html' },
    800: { ppid: 700, command: 'claude --resume abc' },
    700: { ppid: HOST, command: '/bin/zsh -lc env -u CLAUDE_CONFIG_DIR claude --resume abc', session: 's_room1' }
  });
  const r = resolveCallerSession({ pid: 900, hostPid: HOST, envSession: 's_room1', readProc });
  assert.equal(r.ok, true); assert.equal(r.session, 's_room1'); assert.equal(r.via, 'ancestry'); assert.equal(r.note, undefined);
});

test('the shell wins over a lying environment, and says so', () => {
  const readProc = table({
    900: { ppid: 700, command: 'hop checkback --in 5m x' },
    700: { ppid: HOST, command: '/bin/zsh', session: 's_room1' }
  });
  const r = resolveCallerSession({ pid: 900, hostPid: HOST, envSession: 's_other', readProc });
  assert.equal(r.session, 's_room1'); assert.equal(r.via, 'ancestry'); assert.match(r.note, /HOP_SESSION says "s_other"/);
});

test("the session shell's environment is unreadable on macOS: the nearest readable ancestor below it speaks for it", () => {
  const readProc = table({
    900: { ppid: 850, command: 'hop whoami', session: 's_lie' },        // the caller's own variable is not evidence
    850: { ppid: 800, command: '/bin/zsh -c snapshot', session: 's_room1' },
    800: { ppid: 700, command: 'claude --resume abc', session: 's_room1' },
    700: { ppid: HOST, command: '/bin/zsh -lc env -u CLAUDE_CONFIG_DIR claude', session: null }
  });
  const r = resolveCallerSession({ pid: 900, hostPid: HOST, envSession: 's_lie', readProc });
  assert.equal(r.session, 's_room1'); assert.equal(r.via, 'ancestry'); assert.match(r.note, /says "s_lie"/);
});

test("under Codex's shared app-server daemon the answer is AMBIGUOUS, not the daemon owner's", () => {
  const readProc = table({
    950: { ppid: 940, command: 'node /x/hop-mcp.js' },
    940: { ppid: 930, command: '/x/bin/codex app-server --listen unix:// --managed-daemon' },
    930: { ppid: 920, command: '/x/bin/codex app-server daemon pid-update-loop' },
    920: { ppid: 910, command: '/x/bin/codex resume 01a0' },
    910: { ppid: HOST, command: '/bin/zsh', session: 'Accessibility-fork-codex' }
  });
  const r = resolveCallerSession({ pid: 950, hostPid: HOST, envSession: 'Accessibility-fork-codex', readProc });
  assert.equal(r.ok, false); assert.equal(r.session, null); assert.equal(r.reason, 'shared-daemon');
  assert.match(r.note, /shared agent daemon/); assert.match(r.note, /Pass the session explicitly/);
});

test('no session shell above and no variable: not inside hop; with the variable: trusted as inherited', () => {
  const readProc = table({ 300: { ppid: 200, command: 'bash' }, 200: { ppid: 1, command: 'login' } });
  const none = resolveCallerSession({ pid: 300, hostPid: HOST, envSession: null, readProc });
  assert.equal(none.ok, false); assert.equal(none.reason, 'no-session');
  const env = resolveCallerSession({ pid: 300, hostPid: HOST, envSession: 's_cron', readProc });
  assert.equal(env.ok, true); assert.equal(env.session, 's_cron'); assert.equal(env.via, 'env');
});

test('a process the table cannot read stops the walk gracefully', () => {
  const r = resolveCallerSession({ pid: 5, hostPid: HOST, envSession: 's_x', readProc: () => null });
  assert.equal(r.session, 's_x'); assert.equal(r.via, 'env');
});

test('HOP_SESSION is read out of the ENVIRONMENT part of a ps -E line, never out of the arguments', () => {
  assert.equal(sessionFromEnvLine('/bin/zsh -lc claude HOP_SESSION=s_abc PATH=/usr/bin TERM=xterm', '/bin/zsh -lc claude'), 's_abc');
  assert.equal(sessionFromEnvLine('/bin/zsh PATH=/usr/bin', '/bin/zsh'), null);
  // The shell's own command text mentions a session; its environment says another.
  assert.equal(sessionFromEnvLine('/bin/zsh -c HOP_SESSION=s_lie ./hop whoami HOME=/u HOP_SESSION=s_true', '/bin/zsh -c HOP_SESSION=s_lie ./hop whoami'), 's_true');
  assert.equal(sessionFromEnvLine('/bin/zsh -c HOP_SESSION=s_lie ./hop whoami HOME=/u', '/bin/zsh -c HOP_SESSION=s_lie ./hop whoami'), null);
});

test('a multiplexer is the program that runs, not a mention in some argument list', () => {
  assert.equal(isMultiplexer('/x/releases/0.159/bin/codex app-server --listen unix:// --managed-daemon'), true);
  assert.equal(isMultiplexer('/x/bin/codex-code-mode-host'), true);
  assert.equal(isMultiplexer('/opt/homebrew/bin/codex --no-daemon resume 01a0'), false);
  assert.equal(isMultiplexer('/bin/zsh -c "echo codex app-server is a string"'), false);
});
