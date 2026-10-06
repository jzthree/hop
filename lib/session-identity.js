'use strict';
// WHICH hop session is this process in? The honest answer comes from the
// process tree, not from an inherited variable.
//
// HOP_SESSION is set on each session's shell by the host, and children
// inherit it — which is right until something re-parents the work: Codex's
// shared app-server daemon ran every session's commands and MCP servers
// under the FIRST session's environment, so `hop view`, `hop checkback` and
// the MCP tools all defaulted to that one session. An arbitrary default is
// worse than none.
//
// So: walk the parents. The terminal host spawns one shell per session; the
// ancestor that is a direct child of the host IS the session's shell, and its
// HOP_SESSION is the truth. If the walk passes through a known multiplexer
// (Codex's app-server daemon or its code-mode host) the answer is ambiguous
// — the caller may belong to any session that daemon serves — and the
// verdict says so instead of guessing. With no host in the chain at all
// (a plain terminal, a cron), the environment is all there is, and the
// verdict says that too.

const MAX_HOPS = 24;
// A multiplexer is recognised by WHAT RUNS, the program and its first word,
// never by text anywhere in the arguments — a shell whose command line
// merely mentions "codex app-server" (a test, a grep) is not one.
const isMultiplexer = (command) => {
    const words = String(command || '').trim().split(/\s+/);
    const program = (words[0] || '').split('/').pop();
    return program === 'codex-code-mode-host' || (program === 'codex' && words[1] === 'app-server');
};

/**
 * @param {object} o
 * @param {number} o.pid                 the calling process
 * @param {number|null} o.hostPid        the terminal host's pid (null = unknown)
 * @param {string|null} o.envSession     process.env.HOP_SESSION as inherited
 * @param {(pid:number)=>{ppid:number, command:string, session?:string|null}|null} o.readProc
 *        one process: its parent, command line, and the HOP_SESSION in its environment
 * @returns {{ ok: boolean, session: string|null, via: 'ancestry'|'env'|null, reason?: string, note?: string, chain: Array<{pid:number, command:string}> }}
 */
function resolveCallerSession(o) {
    const chain = [];
    const env = o.envSession && /^[A-Za-z0-9_-]+$/.test(o.envSession) ? o.envSession : null;
    let pid = Number(o.pid);
    let viaDaemon = null;
    let shellSession = null;
    // The nearest ancestor whose environment could be read. The session
    // shell itself is a login zsh whose environment macOS will not show
    // (`ps -E` prints nothing for it); everything under it inherited the
    // shell's HOP_SESSION, so the nearest readable one carries the truth —
    // unless a multiplexer sits in between, which is caught separately.
    let nearestSession = null;
    for (let hops = 0; hops < MAX_HOPS && pid && pid > 1; hops++) {
        const info = o.readProc(pid);
        if (!info) break;
        chain.push({ pid, command: String(info.command || '').slice(0, 120) });
        if (isMultiplexer(info.command)) viaDaemon = viaDaemon || { pid, command: String(info.command || '').slice(0, 80) };
        // The calling process's own variable is what we are checking, so it
        // does not count as evidence; its ancestors' do.
        if (hops > 0 && !nearestSession && info.session) nearestSession = info.session;
        if (o.hostPid && info.ppid === o.hostPid) {
            // This process is the session's own shell.
            shellSession = info.session || nearestSession || null;
            break;
        }
        if (!info.ppid || info.ppid === pid) break;
        pid = info.ppid;
    }
    if (viaDaemon) {
        return {
            ok: false, session: null, via: null, chain,
            reason: 'shared-daemon',
            note: `This process runs under a shared agent daemon (${viaDaemon.command.trim()}), which serves several sessions — the inherited HOP_SESSION${env ? ` ("${env}")` : ''} may belong to another one. Pass the session explicitly.`
        };
    }
    if (shellSession) {
        const note = env && env !== shellSession
            ? `HOP_SESSION says "${env}" but this process lives in session "${shellSession}" (by its shell); using the latter.`
            : undefined;
        return { ok: true, session: shellSession, via: 'ancestry', chain, note };
    }
    if (env) return { ok: true, session: env, via: 'env', chain, note: o.hostPid ? 'Not under a hop session shell; trusting HOP_SESSION as inherited.' : undefined };
    return { ok: false, session: null, via: null, chain, reason: 'no-session', note: 'Not inside a hop session (no session shell above this process, and HOP_SESSION is unset).' };
}

/**
 * Parse `HOP_SESSION=…` out of a `ps -E` line (macOS): the command line
 * followed by the environment. Given the plain command line too, only the
 * ENVIRONMENT part is read — a shell whose arguments contain
 * "HOP_SESSION=x" (a test, a script) is not thereby in session x.
 */
function sessionFromEnvLine(line, plainCommand) {
    let text = String(line || '');
    const plain = String(plainCommand || '').trim();
    if (plain && text.startsWith(plain)) text = text.slice(plain.length);
    const m = /(?:^|\s)HOP_SESSION=([A-Za-z0-9_-]+)/.exec(text);
    return m ? m[1] : null;
}

module.exports = { resolveCallerSession, sessionFromEnvLine, isMultiplexer };
