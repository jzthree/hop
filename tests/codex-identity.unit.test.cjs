// Every codex hop launches carries its hop session id in the thread's own
// config, so commands run through Codex's shared daemon still know which
// session they belong to.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withCodexIdentity, codexIdentityFlags, NO_UPDATE_CHECK } = require('../lib/codex-identity');

test('a bare codex launch gets both overrides, and the startup update check off', () => {
  const out = withCodexIdentity('codex', 's_82da12887f');
  assert.equal(out, `codex --no-daemon -c 'shell_environment_policy.set.HOP_SESSION="s_82da12887f"' -c 'mcp_servers.hop.env.HOP_SESSION="s_82da12887f"' -c check_for_update_on_startup=false`);
  assert.equal(NO_UPDATE_CHECK, '-c check_for_update_on_startup=false');
});

test('a command that decides the update check itself keeps its own choice — no duplicate -c', () => {
  const on = withCodexIdentity('codex -c check_for_update_on_startup=true', 's_1');
  assert.equal(on, `codex ${codexIdentityFlags('s_1', { keepUpdateCheck: true })} -c check_for_update_on_startup=true`);
  assert.equal((on.match(/check_for_update_on_startup/g) || []).length, 1);
});

test('a resume keeps its arguments after the flags; command/exec prefixes survive', () => {
  assert.equal(withCodexIdentity("codex resume '01a0e0dc-314d'", 'surf'),
    `codex ${codexIdentityFlags('surf')} resume '01a0e0dc-314d'`);
  assert.equal(withCodexIdentity('command codex --full-auto -c check_for_update_on_startup=false', 's_1'),
    `command codex ${codexIdentityFlags('s_1', { keepUpdateCheck: true })} --full-auto -c check_for_update_on_startup=false`);
});

test('anything else is untouched: shells, claude, a codex somewhere later in the line, an already pinned launch', () => {
  assert.equal(withCodexIdentity('claude --resume abc', 's_1'), 'claude --resume abc');
  assert.equal(withCodexIdentity('cd x && codex', 's_1'), 'cd x && codex');
  assert.equal(withCodexIdentity('codexify --help', 's_1'), 'codexify --help');
  const pinned = withCodexIdentity('codex', 's_1');
  assert.equal(withCodexIdentity(pinned, 's_2'), pinned);
  assert.equal(withCodexIdentity('', 's_1'), '');
  assert.equal(withCodexIdentity('codex', ''), 'codex');
});

test('the id is sanitised — it lands inside a quoted config value', () => {
  assert.equal(codexIdentityFlags('bad"id;rm -rf', { keepUpdateCheck: true }), `--no-daemon -c 'shell_environment_policy.set.HOP_SESSION="badidrm-rf"' -c 'mcp_servers.hop.env.HOP_SESSION="badidrm-rf"'`);
});
