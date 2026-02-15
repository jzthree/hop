const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'agent-team-ctl.js');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...options
  });
  return {
    ...result,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function initGitRepo(root) {
  const init = run('git', ['init'], { cwd: root });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(run('git', ['checkout', '-b', 'main'], { cwd: root }).status, 0);
  assert.equal(run('git', ['config', 'user.email', 'agent-team@test.local'], { cwd: root }).status, 0);
  assert.equal(run('git', ['config', 'user.name', 'Agent Team Test'], { cwd: root }).status, 0);
  fs.writeFileSync(path.join(root, 'README.md'), '# test\n');
  assert.equal(run('git', ['add', 'README.md'], { cwd: root }).status, 0);
  const commit = run('git', ['commit', '-m', 'init'], { cwd: root });
  assert.equal(commit.status, 0, commit.stderr);
}

function runCtl(root, args, extraEnv = {}) {
  const env = {
    ...process.env,
    AGENT_TEAM_ROOT: root,
    ...extraEnv
  };
  return run(process.execPath, [SCRIPT, ...args], { cwd: root, env });
}

function runCtlAsync(root, args, extraEnv = {}) {
  const env = {
    ...process.env,
    AGENT_TEAM_ROOT: root,
    ...extraEnv
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code, signal) => {
      resolve({
        status: typeof code === 'number' ? code : 1,
        signal: signal || null,
        stdout,
        stderr
      });
    });
  });
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-ctl-test-'));
  initGitRepo(dir);
  return dir;
}

test('status reports no active run by default', () => {
  const repo = makeTempRepo();
  try {
    const res = runCtl(repo, ['status']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Branch:\s+main/);
    assert.match(res.stdout, /Agent run:\s+none/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('start creates branch+tag metadata and rollback returns to base branch', () => {
  const repo = makeTempRepo();
  try {
    const start = runCtl(repo, ['start', 'smoke']);
    assert.equal(start.status, 0, start.stderr);
    const runIdMatch = start.stdout.match(/Started agent run:\s+([^\s]+)/);
    assert.ok(runIdMatch, start.stdout);
    const runId = runIdMatch[1];
    const workBranch = `agent-run/${runId}`;
    const checkpointTag = `agent-checkpoint/${runId}`;

    const branchNow = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
    assert.equal(branchNow.status, 0, branchNow.stderr);
    assert.equal(branchNow.stdout.trim(), workBranch);

    assert.equal(run('git', ['show-ref', '--verify', `refs/tags/${checkpointTag}`], { cwd: repo }).status, 0);
    const currentMetaPath = path.join(repo, '.git', 'agent-runs', 'current.json');
    assert.equal(fs.existsSync(currentMetaPath), true);
    const currentMeta = JSON.parse(fs.readFileSync(currentMetaPath, 'utf8'));
    assert.equal(currentMeta.runId, runId);
    assert.equal(currentMeta.baseBranch, 'main');
    assert.equal(currentMeta.workBranch, workBranch);

    const rollback = runCtl(repo, ['rollback', '--drop-branch']);
    assert.equal(rollback.status, 0, rollback.stderr);
    const afterBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
    assert.equal(afterBranch.stdout.trim(), 'main');
    assert.notEqual(run('git', ['show-ref', '--verify', `refs/heads/${workBranch}`], { cwd: repo }).status, 0);
    assert.equal(run('git', ['show-ref', '--verify', `refs/tags/${checkpointTag}`], { cwd: repo }).status, 0);
    assert.equal(fs.existsSync(currentMetaPath), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('start rejects dirty tree unless --allow-dirty is passed', () => {
  const repo = makeTempRepo();
  try {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x\n');
    const denied = runCtl(repo, ['start', 'dirty-run']);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /Working tree is not clean/);

    const allowed = runCtl(repo, ['start', 'dirty-run', '--allow-dirty']);
    assert.equal(allowed.status, 0, allowed.stderr);

    const rollback = runCtl(repo, ['rollback', '--allow-dirty', '--drop-branch']);
    assert.equal(rollback.status, 0, rollback.stderr);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('interrupt sends ctrl-c payload to each terminal id', async () => {
  const repo = makeTempRepo();
  const requests = [];
  const token = 'token-test';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      requests.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        body
      });
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const statePath = path.join(repo, 'tunnel-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ port, sessionSecret: token }));

    const res = await runCtlAsync(repo, ['interrupt', 't_alpha', 't_beta'], {
      AGENT_TEAM_TUNNEL_STATE: statePath
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Interrupted t_alpha/);
    assert.match(res.stdout, /Interrupted t_beta/);
    assert.equal(requests.length, 2);
    for (const req of requests) {
      assert.equal(req.method, 'POST');
      assert.match(req.path, /^\/api\/terminals\/t_(alpha|beta)\/write$/);
      assert.equal(req.authorization, `Bearer ${token}`);
      const parsed = JSON.parse(req.body);
      assert.equal(parsed.data, '\u0003');
    }
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('interrupt returns non-zero when one terminal write fails', async () => {
  const repo = makeTempRepo();
  const token = 'token-test';
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url && req.url.includes('/t_bad/')) {
        res.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const statePath = path.join(repo, 'tunnel-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ port, sessionSecret: token }));

    const res = await runCtlAsync(repo, ['interrupt', 't_ok', 't_bad'], {
      AGENT_TEAM_TUNNEL_STATE: statePath
    });
    assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
    assert.match(res.stdout, /Interrupted t_ok/);
    assert.match(res.stderr, /Failed t_bad/);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
