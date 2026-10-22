'use strict';
// The conversation text a session search looks through, per transcript.
//
// A transcript is append-only JSONL, and most of its bytes are tool output
// and images, not conversation: a fixed 1 MB tail held two days of one
// session's talk and six minutes of another's. So the window is measured in
// conversation TEXT instead (a character budget), filled two ways:
//
//  - refresh(): reads only what was appended since the last look — a stat
//    and a few KB per search, so a keystroke-driven search sees a turn the
//    moment it lands without re-reading anything.
//  - backfill(): walks backwards from where the text starts, a chunk at a
//    time, until the budget is full, the file's start is reached, or the
//    scan limit is spent. It runs off the keystroke path (the caller
//    schedules it), so a session with a huge transcript still answers at
//    once from what is already loaded and deepens in the background.
//
// Only "text" fields are kept (user and agent messages in Claude and Codex
// transcripts); oldest text is dropped first once the budget is exceeded.

const fs = require('fs');

const TEXT_RE = /"text":"((?:[^"\\]|\\.){4,})"/g;
const MAX_PIECE = 20000;

const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

function extractText(chunk) {
    const out = [];
    TEXT_RE.lastIndex = 0;
    let m;
    while ((m = TEXT_RE.exec(chunk)) !== null) {
        // Long messages are kept (cut), not dropped: an earlier cap that
        // dropped them lost most agent replies.
        out.push(unescape(m[1].length > MAX_PIECE ? m[1].slice(0, MAX_PIECE) : m[1]));
    }
    return out;
}

function readRange(fd, start, end) {
    const len = Math.max(0, end - start);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, start + got);
        if (n <= 0) break;
        got += n;
    }
    return buf.subarray(0, got);
}

class TranscriptCorpus {
    constructor({ budgetChars = 256 * 1024, initialBytes = 1024 * 1024, backfillChunk = 4 * 1024 * 1024, backfillLimit = 64 * 1024 * 1024 } = {}) {
        this.budgetChars = budgetChars;
        this.initialBytes = initialBytes;
        this.backfillChunk = backfillChunk;
        this.backfillLimit = backfillLimit;
        this.entries = new Map(); // path -> state
    }

    // Bring a transcript's tail up to date; returns its state or null.
    refresh(path) {
        let st;
        try { st = fs.statSync(path); } catch (e) { this.entries.delete(path); return null; }
        let e = this.entries.get(path);
        // Replaced or truncated (a rewrite, not an append): start over.
        if (e && (e.ino !== st.ino || st.size < e.tail)) e = null;
        if (!e) {
            const start = Math.max(0, st.size - this.initialBytes);
            e = { path, ino: st.ino, head: start, tail: start, scanned: 0, pieces: [], chars: 0, done: start === 0, joined: null };
            // A tail that starts mid-line: the partial first line is
            // skipped here and picked up by the first backfill step.
            if (start > 0) {
                const fd = fs.openSync(path, 'r');
                try {
                    const probe = readRange(fd, start, Math.min(st.size, start + 1024 * 1024));
                    const nl = probe.indexOf(10);
                    e.tail = nl === -1 ? start + probe.length : start + nl + 1;
                    e.head = e.tail;
                } finally { fs.closeSync(fd); }
            }
            this.entries.set(path, e);
        }
        if (st.size > e.tail) {
            const fd = fs.openSync(path, 'r');
            try {
                const buf = readRange(fd, e.tail, st.size);
                // Only whole lines: a line still being written is read next time.
                const last = buf.lastIndexOf(10);
                if (last !== -1) {
                    const text = extractText(buf.subarray(0, last + 1).toString('utf8'));
                    this._append(e, text);
                    e.tail += last + 1;
                }
            } finally { fs.closeSync(fd); }
        }
        e.size = st.size;
        return e;
    }

    // One step backwards. Returns true while there is more to do.
    backfill(path) {
        const e = this.entries.get(path);
        if (!e || e.done) return false;
        if (e.chars >= this.budgetChars || e.head === 0 || e.scanned >= this.backfillLimit) { e.done = true; return false; }
        const start = Math.max(0, e.head - this.backfillChunk);
        let fd;
        try { fd = fs.openSync(path, 'r'); } catch (err) { e.done = true; return false; }
        try {
            const buf = readRange(fd, start, e.head);
            // Begin at a line start; a line longer than the chunk is skipped
            // whole (those are tool output or images, not conversation).
            let from = 0;
            if (start > 0) {
                const nl = buf.indexOf(10);
                from = nl === -1 ? buf.length : nl + 1;
            }
            this._prepend(e, extractText(buf.subarray(from).toString('utf8')));
            e.scanned += e.head - start;
            // Next time, end where the first whole line began (or, with no
            // newline in the whole chunk, skip past it).
            e.head = from < buf.length ? start + from : start;
        } finally { fs.closeSync(fd); }
        if (e.chars >= this.budgetChars || e.head === 0 || e.scanned >= this.backfillLimit) e.done = true;
        return !e.done;
    }

    text(path) {
        const e = this.entries.get(path);
        if (!e) return { text: '', lower: '' };
        if (e.joined === null) {
            const text = e.pieces.join('\n');
            e.joined = { text, lower: text.toLowerCase() };
        }
        return e.joined;
    }

    pending() {
        return [...this.entries.values()].filter((e) => !e.done).map((e) => e.path);
    }

    forget(keep) {
        for (const p of this.entries.keys()) if (!keep.has(p)) this.entries.delete(p);
    }

    _append(e, pieces) {
        if (!pieces.length) return;
        for (const p of pieces) { e.pieces.push(p); e.chars += p.length + 1; }
        this._trimOldest(e);
        e.joined = null;
    }

    _prepend(e, pieces) {
        if (!pieces.length) return;
        // Fill only up to the budget: the newest of the older text is kept.
        const room = this.budgetChars - e.chars;
        if (room <= 0) return;
        const take = [];
        let used = 0;
        for (let i = pieces.length - 1; i >= 0 && used < room; i--) {
            take.unshift(pieces[i]);
            used += pieces[i].length + 1;
        }
        e.pieces = take.concat(e.pieces);
        e.chars += used;
        e.joined = null;
    }

    _trimOldest(e) {
        let drop = 0;
        while (e.chars > this.budgetChars && drop < e.pieces.length - 1) {
            e.chars -= e.pieces[drop].length + 1;
            drop++;
        }
        if (drop) {
            e.pieces = e.pieces.slice(drop);
            // What was dropped is older than the budget: no backfill needed.
            e.done = true;
        }
    }
}

module.exports = { TranscriptCorpus, extractText };
