const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { locateDropped, sameFile } = require('../lib/file-locate');

// A dropped file is found where it already is (name, size, modified time),
// so its own path is pasted instead of a copy; anything not found exactly
// once is uploaded as before.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hop-locate-'));
const noSpotlight = async () => [];
const make = (dir, name, body, mtime) => {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
  return p;
};

test('a file in the session folder is found by name, size and modified time', async () => {
  const dir = tmp();
  try {
    const mt = Date.UTC(2026, 10, 1, 12);
    const p = make(dir, 'sub/figure 1.png', 'pngbytes', mt);
    const home = tmp();
    assert.equal(await locateDropped({ name: 'figure 1.png', size: 8, lastModified: mt }, { cwd: dir, home, spotlight: noSpotlight }), p);
    // Same name, other size or other time: not it.
    assert.equal(await locateDropped({ name: 'figure 1.png', size: 9, lastModified: mt }, { cwd: dir, home, spotlight: noSpotlight }), null);
    assert.equal(await locateDropped({ name: 'figure 1.png', size: 8, lastModified: mt + 60_000 }, { cwd: dir, home, spotlight: noSpotlight }), null);
    fs.rmSync(home, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two copies alike are not guessed between; a link to the same file is one file', async () => {
  const dir = tmp();
  try {
    const mt = Date.UTC(2026, 10, 2);
    const a = make(dir, 'a/data.csv', 'x,y\n', mt);
    make(dir, 'b/data.csv', 'x,y\n', mt);
    assert.equal(await locateDropped({ name: 'data.csv', size: 4, lastModified: mt }, { cwd: dir, home: tmp(), spotlight: noSpotlight }), null);
    fs.rmSync(path.join(dir, 'b'), { recursive: true });
    fs.symlinkSync(a, path.join(dir, 'link.csv'));
    // Spotlight reporting the same file twice (a link, a second index entry).
    assert.equal(await locateDropped({ name: 'data.csv', size: 4, lastModified: mt }, { cwd: dir, home: tmp(), spotlight: async () => [a, a] }), a);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a path the Mac app hands over is only checked, never searched around', async () => {
  const dir = tmp();
  try {
    const mt = Date.UTC(2026, 10, 3);
    const p = make(dir, 'report.pdf', 'pdf!', mt);
    assert.equal(await locateDropped({ name: 'report.pdf', size: 4, lastModified: mt, path: p }, { spotlight: noSpotlight }), p);
    assert.equal(await locateDropped({ name: 'report.pdf', size: 5, lastModified: mt, path: p }, { spotlight: noSpotlight }), null, 'size differs');
    assert.equal(await locateDropped({ name: 'other.pdf', size: 4, lastModified: mt, path: p }, { spotlight: noSpotlight }), null, 'name differs');
    assert.equal(await locateDropped({ name: 'report.pdf', size: 4, path: 'relative/report.pdf' }, { cwd: dir, home: tmp(), spotlight: noSpotlight }), p, 'a relative path is ignored; the search finds it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('names that are paths are refused', async () => {
  assert.equal(await locateDropped({ name: '../etc/passwd', size: 1 }, { spotlight: noSpotlight }), null);
  assert.equal(await locateDropped({ name: '', size: 1 }, { spotlight: noSpotlight }), null);
  assert.equal(sameFile(null, { size: 1 }), false);
});
