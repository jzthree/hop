// Notebooks in Views: the read-only page, and a Nebula link's saved copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderNotebook, renderNotebookMissing, snapshotPath, refreshSnapshot } = require('../lib/notebook-view');

const nb = { nbformat: 4, cells: [{ cell_type: 'code', source: 'print("</script><script>alert(1)</script>")', outputs: [] }] };

test('the page mounts Nebula\'s viewer on the notebook, and a cell cannot end the script', () => {
    const html = renderNotebook(nb, 'Fit <v2>', 'fit.ipynb', 'Saved copy from Nov 1.');
    assert.match(html, /<script src="\/assets\/nebula-viewer\/viewer\.global\.js"><\/script>/);
    assert.match(html, /NebulaNotebookViewer\.mountNotebook/);
    assert.equal(html.match(/<\/script>/g).length, 2, 'only the page\'s own two scripts close');
    assert.match(html, /\\u003c\/script>/);
    assert.match(html, /<title>Fit &lt;v2&gt;<\/title>/);
    assert.match(html, /class="hop-nb-note">Saved copy from Nov 1\.</);
    assert.doesNotMatch(renderNotebook(nb, 't', 'f', null), /class="hop-nb-note"/);
});

test('a link never read says why, and links to the live one', () => {
    const html = renderNotebookMissing('Fit', 'Not read yet. Nebula is not answering.', 'http://localhost:3000/?file=%2Fa.ipynb');
    assert.match(html, /Nebula is not answering/);
    assert.match(html, /href="http:\/\/localhost:3000\/\?file=%2Fa\.ipynb" target="_blank"/);
});

test('refresh saves the notebook Nebula returns; a stale token is retried without one', async () => {
    const viewsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbview-'));
    const calls = [];
    const fetchImpl = async (url, opts) => {
        calls.push({ url, auth: opts.headers.Authorization || null });
        if (opts.headers.Authorization) return { status: 401, ok: false, json: async () => ({}) };
        return { status: 200, ok: true, json: async () => ({ type: 'notebook', content: nb }) };
    };
    const target = 'http://localhost:3000/?file=%2Fdata%2Ffit.ipynb';
    const r = await refreshSnapshot({ viewsDir, session: 's1', artifact: 'fit.ipynb.nebula.html', target, token: 'stale', fetchImpl });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://localhost:3000/api/fs/read?path=%2Fdata%2Ffit.ipynb');
    assert.equal(calls[1].auth, null);
    const saved = snapshotPath(viewsDir, 's1', 'fit.ipynb.nebula.html');
    assert.equal(path.basename(path.dirname(saved)), '.nebula', 'kept out of the Views list');
    assert.deepEqual(JSON.parse(fs.readFileSync(saved, 'utf8')), nb);
    fs.rmSync(viewsDir, { recursive: true, force: true });
});

test('refresh says why when it cannot read, and leaves the old copy alone', async () => {
    const viewsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbview-'));
    const target = 'http://localhost:3000/?file=%2Fa.ipynb';
    const at = (status) => async () => ({ status, ok: false, json: async () => ({}) });
    const args = { viewsDir, session: 's1', artifact: 'a.ipynb.nebula.html', target };
    assert.match((await refreshSnapshot({ ...args, fetchImpl: at(401) })).why, /sign-in/);
    assert.match((await refreshSnapshot({ ...args, fetchImpl: at(404) })).why, /no notebook at \/a\.ipynb/);
    assert.match((await refreshSnapshot({ ...args, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).why, /not answering/);
    assert.match((await refreshSnapshot({ ...args, target: 'http://localhost:3000/' })).why, /does not name a notebook/);
    assert.equal(fs.existsSync(snapshotPath(viewsDir, 's1', 'a.ipynb.nebula.html')), false);
    fs.rmSync(viewsDir, { recursive: true, force: true });
});
