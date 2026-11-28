'use strict';
// Reading a Codex rollout (sessions/…/rollout-…-<thread>.jsonl) without
// loading it: a long-running thread's history runs to gigabytes.

const fs = require('fs');

/**
 * The cwd of the last turn recorded in a rollout file, read from its end in
 * growing pieces (4, 16, 64 MB). Null when none is found that far back, or
 * the file can't be read.
 */
function lastTurnCwd(file, spansMb = [4, 16, 64]) {
    let fd;
    try {
        const size = fs.statSync(file).size;
        fd = fs.openSync(file, 'r');
        for (const span of spansMb.map((mb) => Math.floor(mb * 1024 * 1024))) {
            const len = Math.min(size, span);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, size - len);
            const lines = buf.toString('utf8').split('\n');
            // The first piece may start mid-line, unless the read began at 0.
            for (let i = lines.length - 1; i >= (len < size ? 1 : 0); i--) {
                const l = lines[i];
                if (!l.includes('"turn_context"')) continue;
                try {
                    const d = JSON.parse(l);
                    if (d && d.type === 'turn_context' && typeof d.payload?.cwd === 'string' && d.payload.cwd) return d.payload.cwd;
                } catch (e) { /* a line cut short, or not one */ }
            }
            if (len >= size) break;
        }
    } catch (e) {
        return null;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* closed */ }
    }
    return null;
}

module.exports = { lastTurnCwd };
