'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const HOP = path.join(ROOT, 'hop');
const SKILL_NAMES = ['hop-manager', 'hop-session', 'hopa'];

function createAgentHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-agent-skill-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

function runSkillCommand(home, command) {
  return spawnSync(process.execPath, [HOP, command, 'install'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CODEX_HOME: path.join(home, '.codex')
    }
  });
}

test('agent-skill installs current bundled instructions for Claude and Codex', () => {
  const home = createAgentHome();
  try {
    const result = runSkillCommand(home, 'agent-skill');
    assert.equal(result.status, 0, result.stderr || result.stdout);

    for (const name of SKILL_NAMES) {
      const source = fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
      assert.equal(fs.readFileSync(path.join(home, '.claude', 'skills', name, 'SKILL.md'), 'utf8'), source);
      assert.equal(fs.readFileSync(path.join(home, '.codex', 'skills', name, 'SKILL.md'), 'utf8'), source);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('claude-skill remains a Claude-only compatibility command', () => {
  const home = createAgentHome();
  try {
    const result = runSkillCommand(home, 'claude-skill');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'hopa', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(home, '.codex', 'skills', 'hopa', 'SKILL.md')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
