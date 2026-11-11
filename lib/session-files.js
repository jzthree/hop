'use strict';
// Files from a session: what its agent made, or pointed at, that a person
// would open — collected from the agent's own conversation record, for the
// Views shelf "Files from this session".
//
// Agents forget `hop view`, and on a phone a path printed in a terminal is
// a dead end. The record knows better than the screen: it has the exact
// paths of the files the agent wrote (Claude's Write/Edit, Codex's patches,
// Antigravity's write_to_file …) and the paths it named in its replies,
// unwrapped and whole. Tool OUTPUT is not read — that is where every path
// a `find` or `ls` prints would come from.
//
// Kept to what a person looks at — figures, PDFs, pages, write-ups, tables,
// notebooks, videos — and away from the places nobody means to show:
// hidden folders (keys, configs, caches), dependency trees, the system.
//
// Pure except for path resolution: the daemon reads the transcript, checks
// what still exists, and serves it.

const path = require('path');

const SHOWABLE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'html', 'htm', 'md', 'markdown', 'csv', 'tsv', 'ipynb', 'mp4', 'mov', 'webm'];
const SHOWABLE = new Set(SHOWABLE_EXTS);
const EXT_ALT = [...SHOWABLE_EXTS].sort((a, b) => b.length - a.length).join('|');

// A path in prose: absolute, ~/, ./ or ../, or bare, ending in a showable
// extension. Starts after a space or an opening mark; ends before a space,
// closing mark or sentence punctuation. No spaces inside (quoted paths with
// spaces are rare in replies and costly to guess at).
const SEG = '[\\w@%+=.\\-]+';
const PATH_IN_TEXT = new RegExp(
    `(?:^|(?<=[\\s(\\[{<"'\`=:*]))((?:~/|/|\\.{1,2}/)?(?:${SEG}/)*${SEG}\\.(?:${EXT_ALT}))(?=$|[\\s)\\]}>"'\`,;:!?*]|\\.(?:\\s|$))`,
    'gim'
);
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]>"'`]+/gi;

/** The showable file paths named in a piece of prose, as written. */
function pathsInText(text) {
    const s = String(text || '');
    if (!s) return [];
    // file:// URLs are paths; every other URL is not a file here.
    const plain = s.replace(URL_RE, (u) => (/^file:\/\//i.test(u) ? ` ${decodeURIComponentSafe(u.replace(/^file:\/\//i, ''))} ` : ' '));
    const out = [];
    for (const m of plain.matchAll(PATH_IN_TEXT)) {
        const p = m[1];
        // "e.g." / version-ish tokens can't end in a showable extension, but
        // a bare ".md" or "..png" can — not a file.
        if (/^\.+[^/]*$/.test(p) && !p.includes('/')) continue;
        out.push(p);
    }
    return out;
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

/** Files a patch adds, updates or moves to (Codex's apply_patch, inside a tool call). */
function patchedFiles(body) {
    const s = String(body || '');
    if (!s.includes('*** ')) return [];
    const out = [];
    const re = /\*\*\* (?:Add File|Update File|Move to): ([^\n\r]+?)(?=\\n|\\r|\n|\r|$)/g;
    for (const m of s.matchAll(re)) out.push(m[1].trim().replace(/\\(["\\])/g, '$1'));
    return out;
}

const WROTE_CLAUDE = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const WROTE_AGY = /write|create|edit|replace/i;

/**
 * The file references in one transcript record: [{ raw, how, at, cwd }],
 * `how` 'wrote' (the agent created or changed it) or 'mentioned' (named in
 * a reply). `state.cwd` carries the working directory between records
 * (Codex states it once per turn; Claude on every line).
 */
function refsFromRecord(j, tool, state) {
    const out = [];
    if (!j || typeof j !== 'object') return out;
    const atOf = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : null; };
    if (tool === 'claude') {
        if (typeof j.cwd === 'string' && j.cwd) state.cwd = j.cwd;
        if (j.type !== 'assistant') return out;
        const at = atOf(j.timestamp);
        const c = j.message && j.message.content;
        const said = (t) => { for (const raw of pathsInText(t)) out.push({ raw, how: 'mentioned', at, cwd: state.cwd }); };
        if (typeof c === 'string') said(c);
        else if (Array.isArray(c)) {
            for (const part of c) {
                if (!part) continue;
                if (part.type === 'text') said(part.text);
                else if (part.type === 'tool_use' && WROTE_CLAUDE.test(part.name || '')) {
                    const f = part.input && (part.input.file_path || part.input.notebook_path);
                    if (f) out.push({ raw: String(f), how: 'wrote', at, cwd: state.cwd });
                }
            }
        }
        return out;
    }
    if (tool === 'codex') {
        const p = j.payload || {};
        if ((j.type === 'session_meta' || j.type === 'turn_context') && typeof p.cwd === 'string' && p.cwd) state.cwd = p.cwd;
        if (j.type !== 'response_item') return out;
        const at = atOf(j.timestamp);
        if (p.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
            for (const part of p.content) {
                if (part && typeof part.text === 'string') for (const raw of pathsInText(part.text)) out.push({ raw, how: 'mentioned', at, cwd: state.cwd });
            }
        } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
            const body = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
            for (const raw of patchedFiles(body)) out.push({ raw, how: 'wrote', at, cwd: state.cwd });
        }
        return out;
    }
    if (tool === 'antigravity') {
        if (j.type !== 'PLANNER_RESPONSE') return out;
        const at = atOf(j.created_at);
        for (const raw of pathsInText(j.content)) out.push({ raw, how: 'mentioned', at, cwd: state.cwd });
        for (const t of Array.isArray(j.tool_calls) ? j.tool_calls : []) {
            if (!t || !WROTE_AGY.test(t.name || '')) continue;
            let a = t.args;
            if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
            const f = a && (a.TargetFile || a.AbsolutePath || a.FilePath || a.file_path || a.target_file);
            if (f) out.push({ raw: String(f), how: 'wrote', at, cwd: state.cwd });
        }
        return out;
    }
    return out;
}

/** A reference as an absolute path (relative ones against the cwd then), or null. */
function resolveRef(raw, cwd, home) {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (s === '~' || s.startsWith('~/')) {
        if (!home) return null;
        s = path.join(home, s.slice(1));
    } else if (!path.isAbsolute(s)) {
        if (!cwd || !path.isAbsolute(cwd)) return null;
        s = path.resolve(cwd, s);
    }
    return path.normalize(s);
}

const SYSTEM_ROOTS = ['/System/', '/Library/', '/usr/', '/bin/', '/sbin/', '/etc/', '/private/etc/', '/private/var/db/', '/opt/', '/Applications/', '/dev/', '/proc/', '/sys/', '/var/lib/'];
const SKIP_DIRS = new Set(['node_modules', 'site-packages', 'dist-packages', '__pycache__', 'bower_components', 'vendor']);

/** May a found file be shown? Showable kind; not hidden, not a dependency, not the system's. */
function allowedPath(abs, home) {
    if (!abs || !path.isAbsolute(abs)) return false;
    const ext = path.extname(abs).slice(1).toLowerCase();
    if (!SHOWABLE.has(ext)) return false;
    const segs = abs.split('/').filter(Boolean);
    if (segs.some((s) => s.startsWith('.'))) return false;
    if (segs.some((s) => SKIP_DIRS.has(s))) return false;
    if (SYSTEM_ROOTS.some((r) => abs.startsWith(r))) return false;
    if (home && abs.startsWith(path.join(home, 'Library') + '/')) return false;
    return true;
}

/**
 * Fold references into a session's set: one entry per file, `wrote` winning
 * over `mentioned`, the latest moment kept. Returns the map (path → entry).
 */
function collect(refs, { home, into = new Map() } = {}) {
    for (const r of refs || []) {
        const abs = resolveRef(r.raw, r.cwd, home);
        if (!abs || !allowedPath(abs, home)) continue;
        const cur = into.get(abs);
        if (!cur) into.set(abs, { path: abs, how: r.how, at: r.at || null });
        else {
            if (r.how === 'wrote') cur.how = 'wrote';
            if ((r.at || 0) > (cur.at || 0)) cur.at = r.at;
        }
    }
    return into;
}

/** Parse complete JSONL lines into references (bad lines are skipped). */
function refsFromLines(lines, tool, state) {
    const out = [];
    for (const line of lines) {
        if (!line || line.length < 2) continue;
        // Cheap skips before JSON.parse: most lines name no file at all.
        if (!/\.(?:png|jpe?g|gif|webp|svg|pdf|html?|md|markdown|csv|tsv|ipynb|mp4|mov|webm)\b|"cwd"/i.test(line)) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        for (const r of refsFromRecord(j, tool, state)) out.push(r);
    }
    return out;
}

module.exports = { SHOWABLE_EXTS, pathsInText, patchedFiles, refsFromRecord, refsFromLines, resolveRef, allowedPath, collect };
