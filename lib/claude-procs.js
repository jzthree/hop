'use strict';
// Which running claude processes have a conversation open, from one
// `ps -axo pid=,tty=,command=` snapshot. A conversation is open where a
// claude was started with `--resume <id>` — except a fork: `--resume <id>
// --fork-session` names the conversation it started FROM and runs a new
// one, so it never holds <id> (a Nov 10 fork made `hop recover` refuse,
// saying the original was "already running in this session").

const CLAUDE_RE = /(^|\/|\s)claude[\w.-]*(\s|$)/;
const PROBE_RE = /\bps\b.*-axo|grep\b/;
const FORK_RE = /(^|\s)--fork-session(?=[\s=;&|)]|$)/;

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** [{ pid, tty }] of the claude processes holding conversation `sessionId`. */
function resumeProcesses(psText, sessionId) {
    if (!sessionId) return [];
    const idInResume = new RegExp(`--resume(=|\\s+)${escapeRe(sessionId)}\\b`);
    const out = [];
    for (const raw of String(psText || '').split('\n')) {
        const m = raw.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const command = m[3];
        if (!CLAUDE_RE.test(command) || PROBE_RE.test(command) || FORK_RE.test(command)) continue;
        if (idInResume.test(command)) out.push({ pid: Number(m[1]), tty: m[2] });
    }
    return out;
}

module.exports = { resumeProcesses };
