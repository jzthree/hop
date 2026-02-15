#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = process.env.AGENT_TEAM_ROOT
  ? path.resolve(process.env.AGENT_TEAM_ROOT)
  : path.resolve(__dirname, '..');
function resolveDefaultRunDir() {
  const gitDir = spawnSync('git', ['rev-parse', '--git-dir'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (gitDir.status === 0) {
    const raw = (gitDir.stdout || '').trim();
    if (raw) {
      return path.resolve(ROOT, raw, 'agent-runs');
    }
  }
  return path.join(ROOT, '.agent-runs');
}
const DEFAULT_RUN_DIR = resolveDefaultRunDir();
const RUN_DIR = process.env.AGENT_TEAM_RUN_DIR
  ? path.resolve(process.env.AGENT_TEAM_RUN_DIR)
  : DEFAULT_RUN_DIR;
const CURRENT_FILE = path.join(RUN_DIR, 'current.json');

function usage(exitCode = 0) {
  const text = [
    'Usage:',
    '  node scripts/agent-team-ctl.js start [name] [--allow-dirty]',
    '  node scripts/agent-team-ctl.js status',
    '  node scripts/agent-team-ctl.js rollback [run-id] [--allow-dirty] [--drop-branch]',
    '  node scripts/agent-team-ctl.js interrupt <terminal-id> [terminal-id ...]',
    '',
    'Examples:',
    '  node scripts/agent-team-ctl.js start lease-failover',
    '  node scripts/agent-team-ctl.js interrupt t_abc123 t_def456',
    '  node scripts/agent-team-ctl.js rollback --drop-branch'
  ].join('\n');
  process.stderr.write(`${text}\n`);
  process.exit(exitCode);
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...options
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').trim() || `git ${args.join(' ')} failed`;
    throw new Error(err);
  }
  return (result.stdout || '').trim();
}

function ensureRunDir() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function slugify(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 40);
}

function parseFlag(argv, name) {
  return argv.includes(name);
}

function getPositional(argv) {
  return argv.filter((arg) => !arg.startsWith('--'));
}

function assertCleanWorktree(allowDirty) {
  if (allowDirty) return;
  const status = runGit(['status', '--porcelain']);
  if (status) {
    throw new Error('Working tree is not clean. Commit/stash first or pass --allow-dirty.');
  }
}

function saveRunMeta(meta) {
  ensureRunDir();
  const runFile = path.join(RUN_DIR, `${meta.runId}.json`);
  writeJsonFile(runFile, meta);
  writeJsonFile(CURRENT_FILE, meta);
}

function loadRunMeta(runId) {
  ensureRunDir();
  if (runId) {
    const runFile = path.join(RUN_DIR, `${runId}.json`);
    const meta = readJsonFile(runFile);
    if (!meta) throw new Error(`Run metadata not found: ${runId}`);
    return meta;
  }
  const current = readJsonFile(CURRENT_FILE);
  if (!current) throw new Error('No current run metadata found.');
  return current;
}

function clearCurrentMetaIfMatch(runId) {
  const current = readJsonFile(CURRENT_FILE);
  if (current && current.runId === runId) {
    fs.unlinkSync(CURRENT_FILE);
  }
}

function cmdStart(argv) {
  const allowDirty = parseFlag(argv, '--allow-dirty');
  const positional = getPositional(argv);
  const name = positional[0] || 'agent-run';

  assertCleanWorktree(allowDirty);

  const baseBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!baseBranch || baseBranch === 'HEAD') {
    throw new Error('Detached HEAD is not supported. Switch to a branch first.');
  }
  const baseCommit = runGit(['rev-parse', 'HEAD']);

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const slug = slugify(name) || 'agent-run';
  const runId = `${stamp}-${slug}`;
  const workBranch = `agent-run/${runId}`;
  const checkpointTag = `agent-checkpoint/${runId}`;

  runGit(['tag', '-a', checkpointTag, baseCommit, '-m', `agent team checkpoint ${runId}`]);
  runGit(['switch', '-c', workBranch]);

  const meta = {
    runId,
    createdAt: new Date().toISOString(),
    baseBranch,
    baseCommit,
    workBranch,
    checkpointTag
  };
  saveRunMeta(meta);

  process.stdout.write([
    `Started agent run: ${runId}`,
    `Base branch: ${baseBranch}`,
    `Work branch: ${workBranch}`,
    `Checkpoint tag: ${checkpointTag}`,
    `Rollback: node scripts/agent-team-ctl.js rollback ${runId}`,
    `Interrupt terminals: node scripts/agent-team-ctl.js interrupt <terminal-id> ...`
  ].join('\n') + '\n');
}

function cmdStatus() {
  const currentBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentCommit = runGit(['rev-parse', '--short', 'HEAD']);
  const meta = readJsonFile(CURRENT_FILE);

  process.stdout.write(`Branch: ${currentBranch}\nCommit: ${currentCommit}\n`);
  if (!meta) {
    process.stdout.write('Agent run: none\n');
    return;
  }
  process.stdout.write([
    `Agent run: ${meta.runId}`,
    `Created: ${meta.createdAt}`,
    `Base branch: ${meta.baseBranch}`,
    `Work branch: ${meta.workBranch}`,
    `Checkpoint tag: ${meta.checkpointTag}`
  ].join('\n') + '\n');
}

function cmdRollback(argv) {
  const allowDirty = parseFlag(argv, '--allow-dirty');
  const dropBranch = parseFlag(argv, '--drop-branch');
  const positional = getPositional(argv);
  const runId = positional[0];

  assertCleanWorktree(allowDirty);

  const meta = loadRunMeta(runId);
  const currentBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);

  if (currentBranch !== meta.baseBranch) {
    runGit(['switch', meta.baseBranch]);
  }
  if (dropBranch) {
    const branchExists = spawnSync('git', ['show-ref', '--verify', `refs/heads/${meta.workBranch}`], {
      cwd: ROOT,
      stdio: 'ignore'
    }).status === 0;
    if (branchExists) {
      runGit(['branch', '-D', meta.workBranch]);
    }
  }

  clearCurrentMetaIfMatch(meta.runId);

  process.stdout.write([
    `Rolled back run context: ${meta.runId}`,
    `Active branch: ${meta.baseBranch}`,
    `Work branch kept: ${dropBranch ? 'no' : 'yes'}`,
    `Checkpoint tag kept: ${meta.checkpointTag}`
  ].join('\n') + '\n');
}

function readTunnelState() {
  const explicitStatePath = process.env.AGENT_TEAM_TUNNEL_STATE;
  const hopHome = process.env.HOP_HOME
    ? path.resolve(process.env.HOP_HOME)
    : path.join(os.homedir(), '.hop2');
  const statePath = explicitStatePath
    ? path.resolve(explicitStatePath)
    : path.join(hopHome, '.tunnel-state');
  if (!fs.existsSync(statePath)) {
    throw new Error(`Tunnel state not found: ${statePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!parsed || !parsed.port || !parsed.sessionSecret) {
    throw new Error(`Invalid tunnel state in ${statePath}`);
  }
  return {
    port: parsed.port,
    token: parsed.sessionSecret
  };
}

function postWrite(port, token, terminalId, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ data });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/terminals/${terminalId}/write`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`terminal ${terminalId}: HTTP ${res.statusCode || 'unknown'} ${raw}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function cmdInterrupt(argv) {
  const terminalIds = getPositional(argv);
  if (terminalIds.length === 0) {
    throw new Error('interrupt requires at least one terminal id');
  }
  const { port, token } = readTunnelState();
  const failures = [];
  for (const id of terminalIds) {
    try {
      await postWrite(port, token, id, '\u0003');
      process.stdout.write(`Interrupted ${id}\n`);
    } catch (err) {
      failures.push({ id, error: err.message });
      process.stderr.write(`Failed ${id}: ${err.message}\n`);
    }
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

async function main() {
  const [, , command, ...argv] = process.argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    usage(0);
    return;
  }

  if (command === 'start') {
    cmdStart(argv);
    return;
  }
  if (command === 'status') {
    cmdStatus();
    return;
  }
  if (command === 'rollback') {
    cmdRollback(argv);
    return;
  }
  if (command === 'interrupt') {
    await cmdInterrupt(argv);
    return;
  }

  usage(2);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
