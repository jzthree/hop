// The SessionStart hook writes the record `hop restore` and fork trust for
// "where does this conversation live". These tests pin its guards — above
// all: the transcript store is not a workspace.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'claude-session-hook.js');

const runHook = (home, session, payload, env = {}) => {
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      HOP_HOME: home,
      HOP_SESSION: session,
      CLAUDE_CODE_SESSION_ID: '',
      ...env
    }
  });
};

const readRecord = (home, session) => {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'claude-sessions', `${session}.json`), 'utf8')); }
  catch (e) { return null; }
};

const freshHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-hook-'));
  fs.mkdirSync(path.join(home, 'claude-sessions'), { recursive: true });
  return home;
};

test('a normal SessionStart records the conversation and its cwd', () => {
  const home = freshHome();
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart',
    session_id: 'sess-1',
    cwd: '/Users/someone/Code/project',
    source: 'startup'
  });
  const rec = readRecord(home, 'alpha');
  assert.equal(rec.sessionId, 'sess-1');
  assert.equal(rec.cwd, '/Users/someone/Code/project');
});

test('a transcript-store cwd never replaces a good one', () => {
  // The Accessibility-fork incident: something resumed the conversation from
  // ~/.claude/projects/<encoded>, the hook recorded it, and fork + restore
  // both inherited a session living among the transcripts.
  const home = freshHome();
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart',
    session_id: 'sess-1',
    cwd: '/Users/someone/Code/project',
    source: 'startup'
  });
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart',
    session_id: 'sess-1',
    cwd: '/Users/someone/.claude/projects/-Users-someone-Code-project',
    source: 'compact'
  });
  const rec = readRecord(home, 'alpha');
  assert.equal(rec.cwd, '/Users/someone/Code/project', 'the incumbent cwd survives');
  assert.equal(rec.source, 'compact', 'the event itself still records');

  // Alternate config dirs count too (~/.claude_fable/projects/...).
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart',
    session_id: 'sess-1',
    cwd: '/Users/someone/.claude_fable/projects/-Users-someone',
    source: 'resume'
  });
  assert.equal(readRecord(home, 'alpha').cwd, '/Users/someone/Code/project');
});

test('a legitimate cwd change for the same conversation still updates', () => {
  // claude --resume from a different real directory is allowed — only the
  // transcript store is off-limits.
  const home = freshHome();
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart', session_id: 'sess-1',
    cwd: '/Users/someone/Code/project', source: 'startup'
  });
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart', session_id: 'sess-1',
    cwd: '/Users/someone/Code/other', source: 'resume'
  });
  assert.equal(readRecord(home, 'alpha').cwd, '/Users/someone/Code/other');
});

test('a compaction never moves the conversation — its current shell directory is not its home', () => {
  // angler, 2026-08-21: launched in ~, the conversation's Bash tool cd'd
  // into a project, then it compacted. The compact SessionStart reports
  // claude's CURRENT directory, the hook recorded it, and restore compared
  // that against the room's real directory (~), concluded the record was a
  // foreign claude's, and threw a 975-turn conversation away.
  const home = freshHome();
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart', session_id: 'sess-1',
    cwd: '/Users/someone', source: 'startup'
  });
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart', session_id: 'sess-1',
    cwd: '/Users/someone/Code/wandered-into', source: 'compact'
  });
  const rec = readRecord(home, 'alpha');
  assert.equal(rec.cwd, '/Users/someone', 'compact keeps the launch directory');
  assert.equal(rec.source, 'compact', 'the event itself is still recorded');
  assert.equal(rec.sessionId, 'sess-1');
});

test('a compaction with no incumbent still records — something is better than nothing', () => {
  const home = freshHome();
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart', session_id: 'sess-1',
    cwd: '/Users/someone/Code/project', source: 'compact'
  });
  assert.equal(readRecord(home, 'alpha').cwd, '/Users/someone/Code/project');
});

test('a different conversation in a different cwd is parked, not recorded', () => {
  // The pre-existing nested-claude guard, pinned so the new guard cannot
  // have loosened it.
  const home = freshHome();
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart', session_id: 'sess-1',
    cwd: '/Users/someone/Code/project', source: 'startup'
  });
  runHook(home, 'alpha', {
    hook_event_name: 'SessionStart', session_id: 'sess-2',
    cwd: '/Users/someone/scratch', source: 'startup'
  });
  const rec = readRecord(home, 'alpha');
  assert.equal(rec.sessionId, 'sess-1', 'incumbent keeps the record');
  const parked = JSON.parse(fs.readFileSync(path.join(home, 'claude-sessions', 'alpha.other.json'), 'utf8'));
  assert.equal(parked.sessionId, 'sess-2', 'the stranger is parked alongside');
});

// Run the hook the way claude runs it: as a child of the claude process, so
// the argv walk (ps on the parent) sees a real command line. A script named
// `claude` under node is what the walk recognises ("node .../claude ...").
const runHookUnderFakeClaude = (home, session, payload, claudeArgs) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-fake-claude-'));
  const fake = path.join(bin, 'claude');
  fs.writeFileSync(fake, [
    'const { execFileSync } = require("node:child_process");',
    `execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(HOOK)}], { input: process.env.HOOK_PAYLOAD, stdio: ["pipe", "inherit", "inherit"] });`
  ].join('\n'));
  execFileSync(process.execPath, [fake, ...claudeArgs], {
    env: { ...process.env, HOP_HOME: home, HOP_SESSION: session, CLAUDE_CODE_SESSION_ID: '', HOOK_PAYLOAD: JSON.stringify(payload) }
  });
};

test('a headless claude in the room\'s own directory never takes over the record', () => {
  // room, 2026-08-19: a furniture-classifier `claude -p ... --no-session-
  // persistence` spawned by the room's own conversation, in the room's own
  // cwd, overwrote the record. Same cwd, so the parked-rival rule did not
  // apply; no transcript, so restore reopened a plain shell two days later.
  const home = freshHome();
  runHookUnderFakeClaude(home, 'alpha', {
    hook_event_name: 'SessionStart', session_id: 'real-1',
    cwd: '/Users/someone/Code/project', source: 'startup'
  }, ['--dangerously-skip-permissions']);
  const before = readRecord(home, 'alpha');
  assert.equal(before.sessionId, 'real-1');
  assert.match(before.launchCmd, /--dangerously-skip-permissions/, 'the argv walk works for the real claude');

  runHookUnderFakeClaude(home, 'alpha', {
    hook_event_name: 'SessionStart', session_id: 'helper-1',
    cwd: '/Users/someone/Code/project', source: 'startup'
  }, ['--dangerously-skip-permissions', '-p', '--output-format', 'stream-json', '--no-session-persistence']);
  assert.equal(readRecord(home, 'alpha').sessionId, 'real-1', 'the helper did not clobber the record');
  assert.equal(fs.existsSync(path.join(home, 'claude-sessions', 'alpha.other.json')), false, 'nor was it parked as a rival');

  // Its Stops are not the user's turns either.
  runHookUnderFakeClaude(home, 'alpha', { hook_event_name: 'Stop', session_id: 'helper-1' }, ['-p']);
  assert.equal(fs.existsSync(path.join(home, 'claude-sessions', 'alpha.turn')), false, 'no turn counted for a headless run');
  runHookUnderFakeClaude(home, 'alpha', { hook_event_name: 'Stop', session_id: 'real-1' }, ['--dangerously-skip-permissions']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'claude-sessions', 'alpha.turn'), 'utf8')).sessionId, 'real-1');
});

test('outside hop the hook is a no-op', () => {
  const home = freshHome();
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', cwd: '/x' }),
    env: { ...process.env, HOP_HOME: home, HOP_SESSION: '' }
  });
  assert.equal(fs.readdirSync(path.join(home, 'claude-sessions')).length, 0);
});
