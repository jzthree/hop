// Shared views: a public link per view, kept in the view's own entry, found
// by its token, and gone the moment the view or the share is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TOKEN_RE, newShareToken, shareUrl, createShareIndex, setShared } = require('../lib/view-shares');
const { isAgentCommand, agentInAncestry } = require('../lib/session-identity');

const tmpViews = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hop-shares-'));
const readMetaIn = (dir) => (s) => { try { return JSON.parse(fs.readFileSync(path.join(dir, s, '.meta.json'), 'utf8')); } catch { return {}; } };
const writeMeta = (dir, s, meta) => fs.writeFileSync(path.join(dir, s, '.meta.json'), JSON.stringify(meta));

test('a token is long, random and URL-safe; the link names nothing else', () => {
  const a = newShareToken(), b = newShareToken();
  assert.match(a, TOKEN_RE);
  assert.notEqual(a, b);
  assert.ok(a.length >= 24);
  assert.equal(shareUrl('https://hop.example.io/', a), `https://hop.example.io/shared/${a}`);
});

test('sharing again keeps the link; stopping removes it and keeps the rest of the entry', () => {
  const meta = { 'roc.png': { title: 'ROC', source: '/x/roc.png' } };
  setShared(meta, 'roc.png', true, 1000);
  const token = meta['roc.png'].share.token;
  assert.match(token, TOKEN_RE);
  setShared(meta, 'roc.png', true, 2000);
  assert.equal(meta['roc.png'].share.token, token, 'same link');
  assert.equal(meta['roc.png'].share.at, 1000);
  setShared(meta, 'roc.png', false);
  assert.deepEqual(meta['roc.png'], { title: 'ROC', source: '/x/roc.png' });
});

test('a token opens its view, and stops when the share, the view or its kind says so', () => {
  const dir = tmpViews();
  fs.mkdirSync(path.join(dir, 's_a'));
  fs.writeFileSync(path.join(dir, 's_a', 'report.html'), '<p>hi</p>');
  const meta = setShared({ 'report.html': { title: 'Q3' } }, 'report.html', true);
  writeMeta(dir, 's_a', meta);
  const token = meta['report.html'].share.token;
  let t = 0;
  const index = createShareIndex({ viewsDir: dir, readMeta: readMetaIn(dir), rescanMs: 2000, now: () => t });

  const hit = index.find(token);
  assert.equal(hit.session, 's_a');
  assert.equal(hit.name, 'report.html');
  assert.equal(hit.title, 'Q3');
  assert.equal(hit.file, path.join(dir, 's_a', 'report.html'));
  assert.equal(index.find('not-a-token'), null, 'malformed');
  assert.equal(index.find('x'.repeat(24)), null, 'unknown');

  // Stopped: the entry is the truth, whatever the index remembers.
  writeMeta(dir, 's_a', setShared(readMetaIn(dir)('s_a'), 'report.html', false));
  assert.equal(index.find(token), null);

  // Shared again: a new link; found once the index reads again.
  const again = setShared(readMetaIn(dir)('s_a'), 'report.html', true);
  writeMeta(dir, 's_a', again);
  const token2 = again['report.html'].share.token;
  assert.notEqual(token2, token);
  t += 500;
  assert.equal(index.find(token2), null, 'a miss reads again at most every rescanMs');
  index.invalidate();
  assert.equal(index.find(token2).name, 'report.html', 'made here: read at once');

  // The view's file is gone: so is the link.
  fs.rmSync(path.join(dir, 's_a', 'report.html'));
  assert.equal(index.find(token2), null);

  // A live server or a link is never served by token.
  fs.writeFileSync(path.join(dir, 's_a', 'app.html'), 'x');
  const srv = setShared({ 'app.html': { kind: 'server', target: 'x' } }, 'app.html', true);
  writeMeta(dir, 's_a', srv);
  index.invalidate();
  assert.equal(index.find(srv['app.html'].share.token), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an agent is known by its own process, not by text in a command line', () => {
  for (const c of ['claude --resume abc', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/Users/x/.local/share/claude/versions/2.1.3 --resume', '/opt/homebrew/bin/codex --no-daemon',
    '/x/vendor/aarch64-apple-darwin/bin/codex-code-mode-host', 'node /tmp/bin/agy', 'gemini']) {
    assert.equal(isAgentCommand(c), true, c);
  }
  for (const c of ['-zsh', '/bin/zsh -l', 'node scripts/pty-keeper.js', 'vim claude.md', 'python claude_eval.py', 'grep codex log.txt']) {
    assert.equal(isAgentCommand(c), false, c);
  }
});

test('an agent above a command is found; the session terminal is where the search stops', () => {
  const procs = {
    100: { ppid: 90, command: 'node /repo/hop view --share x.png' },
    90: { ppid: 80, command: '/bin/zsh -c hop view --share x.png' },
    80: { ppid: 70, command: 'claude --dangerously-skip-permissions' },
    70: { ppid: 60, command: '-zsh' },
    60: { ppid: 1, command: 'node /repo/scripts/pty-keeper.js' }
  };
  const readProc = (pid) => procs[pid] || null;
  assert.equal(agentInAncestry({ pid: 100, readProc }), 'claude --dangerously-skip-permissions');
  // The person's own prompt in the same session: the shell, then the keeper.
  const typed = { ...procs, 100: { ppid: 70, command: 'node /repo/hop view --share x.png' } };
  assert.equal(agentInAncestry({ pid: 100, readProc: (pid) => typed[pid] || null }), null);
  // An agent beyond the session's terminal is not this command's.
  const outside = { 100: { ppid: 60, command: 'node hop' }, 60: { ppid: 50, command: 'node /r/scripts/pty-keeper.js' }, 50: { ppid: 1, command: 'claude' } };
  assert.equal(agentInAncestry({ pid: 100, readProc: (pid) => outside[pid] || null }), null);
});
