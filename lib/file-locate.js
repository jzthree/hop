'use strict';
// A file dropped on a terminal, found where it already is — instead of
// copying its bytes up to the host and pasting the copy's path.
//
// A web page is never told a dropped file's path, only its name, size and
// modified time. When hop runs on the machine the file is on (the Mac app,
// a browser on the same Mac), that is enough to find it: one file with that
// exact name, size and mtime. The Mac app does better still and passes the
// real path, which only needs checking. Anything not found exactly once —
// or a drop from another machine (a phone, a remote browser) — is uploaded
// as before.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MTIME_SLACK_MS = 1500; // File.lastModified is whole ms; filesystems round

/** Does this stat describe the dropped file? */
function sameFile(stat, want) {
    if (!stat || !stat.isFile()) return false;
    if (Number(stat.size) !== Number(want.size)) return false;
    const lm = Number(want.lastModified);
    return !Number.isFinite(lm) || lm <= 0 || Math.abs(stat.mtimeMs - lm) <= MTIME_SLACK_MS;
}

function statOrNull(p) { try { return fs.statSync(p); } catch (e) { return null; } }

/** Files named `name` under `dir`, a few levels down, skipping the heavy trees. */
function shallowFind(dir, name, depth = 2, budget = { left: 4000 }) {
    const out = [];
    const walk = (d, level) => {
        if (budget.left <= 0) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
            if (--budget.left <= 0) return;
            if (e.name === name && e.isFile()) out.push(path.join(d, e.name));
            else if (e.isDirectory() && level < depth && !/^(\.|node_modules$|__pycache__$|Library$)/.test(e.name)) walk(path.join(d, e.name), level + 1);
        }
    };
    walk(dir, 0);
    return out;
}

/** Spotlight's files with this exact name (macOS). [] when unavailable. */
function spotlight(name, timeoutMs = 2000) {
    return new Promise((resolve) => {
        if (process.platform !== 'darwin' || !name) { resolve([]); return; }
        execFile('/usr/bin/mdfind', ['-name', name], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            if (err && !stdout) { resolve([]); return; }
            resolve(String(stdout || '').split('\n').filter((p) => p && path.basename(p) === name).slice(0, 500));
        });
    });
}

/**
 * Where the dropped file `want` ({ name, size, lastModified, path? }) is on
 * this machine, or null. A given path is only checked. Otherwise the
 * session's folder and the usual drop-from folders are searched, then
 * Spotlight if they have nothing, and the answer must be unique (two copies
 * with the same name, size and mtime in one search: no guess — it uploads).
 */
async function locateDropped(want, opts = {}) {
    const name = String(want && want.name || '');
    if (!name || name.includes('/') || name === '.' || name === '..') return null;
    if (want.path && path.isAbsolute(String(want.path))) {
        const p = String(want.path);
        return path.basename(p) === name && sameFile(statOrNull(p), want) ? p : null;
    }
    const home = opts.home || require('os').homedir();
    const places = [opts.cwd, path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents')].filter(Boolean);
    const hits = new Map(); // realpath → path as found
    const consider = (paths) => {
        for (const p of paths) {
            if (!sameFile(statOrNull(p), want)) continue;
            let real = p;
            try { real = fs.realpathSync(p); } catch (e) { /* keep p */ }
            if (!hits.has(real)) hits.set(real, p);
        }
    };
    // Near at hand first — the session's folder, the usual drop-from folders.
    // One match there is the answer (a copy elsewhere with the same name,
    // size and time would be the same file): no need to wait for Spotlight.
    for (const dir of places) consider(shallowFind(dir, name, dir === opts.cwd ? 2 : 1));
    if (hits.size === 0) consider(await (opts.spotlight || spotlight)(name));
    return hits.size === 1 ? [...hits.values()][0] : null;
}

module.exports = { locateDropped, sameFile, shallowFind, spotlight, MTIME_SLACK_MS };
