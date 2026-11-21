'use strict';
// Signing in from the Accounts page: what each CLI's sign-in prints must
// yield its link, whether it wants a code, and (agy) its first-screen choice.
const test = require('node:test');
const assert = require('node:assert/strict');
const si = require('../lib/agent-signin');

const GOOGLE = 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=fake-client.apps.googleusercontent.com&code_challenge=abc&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=s1';

test('agy: its first screen asks how to sign in, then shows the link and a code box', () => {
  const menu = '\x1b[?25l\x1b[2J Welcome to the Antigravity CLI. You are currently not signed in.\r\n Select login method:\r\n \x1b[1m> 1. Google OAuth\x1b[0m\r\n2. Use a Google Cloud project\r\n';
  const first = si.readSignIn('antigravity', menu);
  assert.equal(first.chooseMethod, true);
  assert.equal(first.url, null);
  const after = menu + `\x1b[H M ⣷  Signing in...Your browser should open automatically. If not:\r\n ${GOOGLE}\r\n Copy and paste the URL or click on the link below:\r\n ${'─'.repeat(200)}\r\n \x1b]8;;${GOOGLE}\x07→ Click here to authenticate\x1b]8;;\x07\r\n If you aren't automatically redirected, paste the authorization code below:\r\n authorization code...`;
  const r = si.readSignIn('antigravity', after);
  assert.equal(r.url, GOOGLE);
  assert.equal(r.chooseMethod, false, 'once the link is out, the choice was made');
  assert.equal(r.wantsCode, true);
  assert.ok(!r.lines.some((l) => /^\s*─+\s*$/.test(l)), 'rules drawn with box characters are dropped');
  assert.ok(r.lines.every((l) => l.length <= 200));
  assert.equal(si.readSignIn('antigravity', after + '\nOAuth: authenticated successfully as a@example.org').succeeded, true);
});

test('claude and codex: the link on their own host, a code for claude, success words', () => {
  const claude = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.ai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=x\nPaste code here if prompted > ';
  const c = si.readSignIn('claude', claude);
  assert.match(c.url, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
  assert.equal(c.wantsCode, true);
  assert.equal(si.readSignIn('claude', claude + '\nLogin successful.').succeeded, true);
  const codex = 'Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&state=y\n';
  const x = si.readSignIn('codex', codex);
  assert.match(x.url, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  assert.equal(x.wantsCode, false);
  assert.equal(si.readSignIn('codex', codex + 'Successfully logged in\n').succeeded, true);
  // Another agent's link is not taken for this one's.
  assert.equal(si.readSignIn('codex', claude).url, null);
});

test('what the person types for a CLI is one printable line', () => {
  assert.equal(si.cleanInput('  4/0AbCd-xyz\n'), '4/0AbCd-xyz');
  assert.equal(si.cleanInput('a\x1b[2Jb'), 'a[2Jb');
  assert.equal(si.cleanInput(''), null);
  assert.equal(si.cleanInput('x'.repeat(2001)), null);
});
