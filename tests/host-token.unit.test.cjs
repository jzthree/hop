const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HOST_TOKEN_HEADER, hostToken, readHostToken, hostTokenPath, requestHasHostToken } = require('../lib/host-token');

const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hop-host-token-'));

test('the host key is made once, private to this account, and kept', () => {
  const home = freshHome();
  try {
    const a = hostToken(home);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fs.statSync(hostTokenPath(home)).mode & 0o777, 0o600);
    assert.equal(hostToken(home), a, 'the same key on every later call');
    assert.equal(readHostToken(home), a);
    assert.deepEqual(fs.readdirSync(home), ['.host-token'], 'no temp files left behind');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a home with no folder yet gets a private one', () => {
  const parent = freshHome();
  const home = path.join(parent, 'hop-home');
  try {
    hostToken(home);
    assert.equal(fs.statSync(home).mode & 0o077, 0);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a key file that is not a key is replaced', () => {
  const home = freshHome();
  try {
    fs.writeFileSync(hostTokenPath(home), '', { mode: 0o600 });
    assert.equal(readHostToken(home), null);
    const t = hostToken(home);
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(readHostToken(home), t);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('processes racing to make the key all end up with the same one', async () => {
  const home = freshHome();
  try {
    const { execFile } = require('node:child_process');
    const lib = path.join(__dirname, '..', 'lib', 'host-token');
    const run = () => new Promise((resolve, reject) => execFile(process.execPath,
      ['-e', `process.stdout.write(require(${JSON.stringify(lib)}).hostToken(process.argv[1]))`, home],
      (err, out) => (err ? reject(err) : resolve(out))));
    const keys = await Promise.all(Array.from({ length: 8 }, run));
    assert.equal(new Set(keys).size, 1);
    assert.equal(keys[0], readHostToken(home));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('only the exact key in the header passes', () => {
  const key = 'k'.repeat(43);
  assert.equal(requestHasHostToken({ [HOST_TOKEN_HEADER]: key }, key), true);
  assert.equal(requestHasHostToken({}, key), false);
  assert.equal(requestHasHostToken({ [HOST_TOKEN_HEADER]: key.slice(1) }, key), false);
  assert.equal(requestHasHostToken({ [HOST_TOKEN_HEADER]: 'j' + key.slice(1) }, key), false);
  assert.equal(requestHasHostToken({ [HOST_TOKEN_HEADER]: [key, key] }, key), false);
  assert.equal(requestHasHostToken({ [HOST_TOKEN_HEADER]: '' }, ''), false, 'no key configured never matches');
  assert.equal(requestHasHostToken(null, key), false);
});
