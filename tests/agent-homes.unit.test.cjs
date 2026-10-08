// Accounts = config roots: which one a session runs as, how it is labelled,
// and how a conversation moves between them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { agentHomeLabel, describeAgentHome, discoverAgentHomes, envForAgentHome, stripConfigPrefix, transcriptTarget } = require('../lib/agent-homes');

const HOME = '/Users/j';

test('labels: the agent\'s own root is "default", a sibling install is its suffix', () => {
  assert.equal(agentHomeLabel('/Users/j/.claude', 'claude', HOME), 'default');
  assert.equal(agentHomeLabel(null, 'claude', HOME), 'default');
  assert.equal(agentHomeLabel('/Users/j/.claude_fable', 'claude', HOME), 'fable');
  assert.equal(agentHomeLabel('/Users/j/.codex-work', 'codex', HOME), 'work');
  assert.equal(agentHomeLabel('/opt/claude-cfg', 'claude', HOME), 'cfg');
  assert.equal(agentHomeLabel('/opt/lab-accounts', 'claude', HOME), 'lab-accounts');
  assert.deepEqual(describeAgentHome(undefined, 'codex', HOME), { dir: '/Users/j/.codex', label: 'default', isDefault: true });
});

test('discovery: default first, account-bearing sibling installs sorted, the environment\'s root last', () => {
  const paths = new Set([
    '/Users/j/.claude',
    '/Users/j/.claude_fable', '/Users/j/.claude_fable/.claude.json',
    '/Users/j/.claude2', '/Users/j/.claude2/projects',
    '/Users/j/.claude-science', '/Users/j/.claude-science/settings.json', // no login footprint
    '/tmp/other', '/tmp/other/projects'
  ]);
  const homes = discoverAgentHomes('claude', { homeDir: HOME, entries: ['.claude_fable', '.claude2', '.claude-science', '.claude.json', '.claude', 'notes'], exists: (d) => paths.has(d), envDir: '/tmp/other' });
  assert.deepEqual(homes.map((h) => [h.label, h.isDefault]), [['default', true], ['claude2', false], ['fable', false], ['other', false]]);
  // .codexbar is another app: no codex footprint, not an account.
  const codex = discoverAgentHomes('codex', { homeDir: HOME, entries: ['.codex', '.codexbar'], exists: (d) => d === '/Users/j/.codex' || d === '/Users/j/.codexbar', envDir: null });
  assert.deepEqual(codex.map((h) => h.label), ['default']);
  assert.deepEqual(discoverAgentHomes('codex', { homeDir: HOME, entries: [], exists: () => false, envDir: null }), []);
});

test('the launch pin is an environment variable per agent', () => {
  assert.deepEqual(envForAgentHome('claude', '/Users/j/.claude_fable'), { CLAUDE_CONFIG_DIR: '/Users/j/.claude_fable' });
  assert.deepEqual(envForAgentHome('codex', '/Users/j/.codex'), { CODEX_HOME: '/Users/j/.codex' });
});

test('a recorded launch loses its old pin so restore can re-pin it', () => {
  assert.equal(stripConfigPrefix("CLAUDE_CONFIG_DIR='/Users/j/.claude_fable' claude --resume abc"), 'claude --resume abc');
  assert.equal(stripConfigPrefix('env -u CLAUDE_CONFIG_DIR claude --permission-mode auto --resume abc'), 'claude --permission-mode auto --resume abc');
  assert.equal(stripConfigPrefix('claude-fable --dangerously-skip-permissions --resume abc'), 'claude --dangerously-skip-permissions --resume abc');
  assert.equal(stripConfigPrefix('/usr/local/bin/claude_lab --resume abc'), 'claude --resume abc');
  assert.equal(stripConfigPrefix('claude --resume abc'), 'claude --resume abc');
  assert.equal(stripConfigPrefix('claude-code-x'), 'claude');
});

test('a transcript keeps its relative place under the new root', () => {
  assert.equal(transcriptTarget('/Users/j/.claude/projects/-Users-j-Code/abc.jsonl', '/Users/j/.claude', '/Users/j/.claude_fable'), '/Users/j/.claude_fable/projects/-Users-j-Code/abc.jsonl');
  assert.equal(transcriptTarget('/Users/j/.codex/sessions/2026/10/08/rollout-x.jsonl', '/Users/j/.codex', '/Users/j/.codex-work'), '/Users/j/.codex-work/sessions/2026/10/08/rollout-x.jsonl');
  assert.equal(transcriptTarget('/elsewhere/abc.jsonl', '/Users/j/.claude', '/Users/j/.claude_fable'), null);
});
