'use strict';
// Codex 0.159 runs EVERY session's shell commands and MCP servers through one
// shared app-server daemon, spawned by whichever codex started first. The
// daemon inherits that first session's environment, so HOP_SESSION — hop's
// "which session am I in" — named the first session for all of them: the
// surf session's `hop view` filed its result under Accessibility-fork-codex,
// and the hop MCP server every codex talks to answered with the wrong name.
//
// Identity must travel with the THREAD, not the process tree. Codex applies
// its shell_environment_policy per thread when it spawns a command, and the
// per-thread MCP server config likewise, and both accept per-launch `-c`
// overrides. So every codex hop launches carries its own session id in
// both — verified: with HOP_SESSION=wrong in the environment, a command run
// by codex saw the override.
//
// And it runs WITHOUT the shared daemon (`--no-daemon`): hop is already the
// multiplexer, and a second one inside Codex is what mixed the sessions up —
// its notify program (the turn-complete hook behind "finished" and restore)
// also ran with the daemon's environment, so every session's turns were
// counted against the first one. Verified: without the daemon the MCP
// servers are children of the session's own codex, carrying its id.

const FLAG_MARK = 'shell_environment_policy.set.HOP_SESSION';

/** The per-launch overrides that pin a codex thread to a hop session. */
function codexIdentityFlags(internalName) {
    const id = String(internalName || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) return '';
    return `--no-daemon -c '${FLAG_MARK}="${id}"' -c 'mcp_servers.hop.env.HOP_SESSION="${id}"'`;
}

/**
 * `codex …` (optionally behind `command ` / `exec `) becomes
 * `codex <identity flags> …`. Anything else — a shell, claude, an already
 * pinned codex line — is returned unchanged.
 */
function withCodexIdentity(command, internalName) {
    const raw = typeof command === 'string' ? command : '';
    const flags = codexIdentityFlags(internalName);
    if (!flags) return raw;
    if (raw.includes(FLAG_MARK)) return raw;
    const m = /^(\s*(?:(?:command|exec)\s+)?)codex(?=\s|$)/.exec(raw);
    if (!m) return raw;
    const rest = raw.slice(m[0].length);
    return `${m[1]}codex ${flags}${rest}`;
}

module.exports = { withCodexIdentity, codexIdentityFlags, FLAG_MARK };
