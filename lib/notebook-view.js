'use strict';
// Notebooks in Views, read-only.
//
// A notebook is drawn by Nebula's own viewer — the cells, syntax colours and
// saved outputs the app shows, with no kernel, no editing and no network
// (vendored into the web build: /assets/nebula-viewer/). Running it stays one
// click away in Nebula.
//
// A Nebula notebook filed with `hop view --nebula` is a LINK to the live one;
// Views reads it from a saved copy, refreshed from Nebula whenever Nebula
// answers, so it still reads when Nebula (or its tunnel) is down. The copy
// lives under a dot-directory (views/<session>/.nebula/), which the manifest
// scan skips: it is not a result of its own.

const fs = require('fs');
const path = require('path');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// JSON inside a <script>: `<` escaped so a cell holding "</script>" cannot
// end the script, and the two line separators JS strings choke on.
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** The page for a notebook: Nebula's viewer mounted on it, with an optional note above (how fresh the copy is). */
function renderNotebook(nb, title, filename, note) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>html,body{margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.hop-nb-note{margin:0;padding:8px 16px;font-size:12px;line-height:1.4;color:#475569;background:#f1f5f9;border-bottom:1px solid #e2e8f0}
.hop-nb-err{padding:24px;color:#b91c1c;font-size:14px}</style></head><body>
${note ? `<p class="hop-nb-note">${esc(note)}</p>` : ''}<div id="nb"></div>
<script src="/assets/nebula-viewer/viewer.global.js"></script>
<script>(function () {
  var el = document.getElementById('nb');
  try { NebulaNotebookViewer.mountNotebook(el, ${js(nb)}, { title: ${js(title)}, filename: ${js(filename)}, showCode: true }); }
  catch (e) { el.className = 'hop-nb-err'; el.textContent = 'This notebook could not be shown: ' + (e && e.message || e); }
})();</script></body></html>`;
}

/** In place of a notebook that cannot be shown yet (a Nebula link never read): what happened, and the way to the live one. */
function renderNotebookMissing(title, why, target) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;padding:32px 24px;background:#f8fafc;color:#1e293b;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}h1{font-size:18px;margin:0 0 8px}p{margin:0 0 10px;color:#475569}a{color:#2563eb}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(why)}</p><p><a href="${esc(target)}" target="_blank" rel="noopener">Open it in Nebula ↗</a></p></body></html>`;
}

/** Where a Nebula link's saved copy lives. */
function snapshotPath(viewsDir, session, artifact) {
    return path.join(viewsDir, session, '.nebula', artifact.replace(/\.html$/, '') + '.ipynb');
}

/**
 * Read the linked notebook from Nebula and save it as the link's copy.
 * A rejected token is retried without one, which Nebula accepts from a
 * loopback caller (a tunnel to its own host) while someone is signed in.
 * Resolves { ok } or { ok: false, why } — never throws for Nebula's sake.
 */
async function refreshSnapshot({ viewsDir, session, artifact, target, token = '', timeoutMs = 4000, fetchImpl = fetch }) {
    let origin, file;
    try { const u = new URL(target); origin = u.origin; file = u.searchParams.get('file'); } catch (e) { }
    if (!origin || !file) return { ok: false, why: 'The link does not name a notebook.' };
    const read = async (withToken) => {
        const r = await fetchImpl(`${origin}/api/fs/read?path=${encodeURIComponent(file)}`, {
            headers: withToken ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeoutMs)
        });
        return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
    };
    let res;
    try {
        res = await read(!!token);
        if ((res.status === 401 || res.status === 403) && token) res = await read(false);
    } catch (e) {
        return { ok: false, why: `Nebula at ${origin} is not answering.` };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, why: 'Nebula wants a sign-in: sign in to Nebula in a browser, or set hop config nebula-token.' };
    if (res.status === 404) return { ok: false, why: `Nebula has no notebook at ${file}.` };
    if (!res.body || res.body.type !== 'notebook' || !res.body.content) return { ok: false, why: `Nebula did not return a notebook (HTTP ${res.status}).` };
    const dest = snapshotPath(viewsDir, session, artifact);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.tmp', JSON.stringify(res.body.content));
    fs.renameSync(dest + '.tmp', dest);
    return { ok: true };
}

module.exports = { renderNotebook, renderNotebookMissing, snapshotPath, refreshSnapshot };
