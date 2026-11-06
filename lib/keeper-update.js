'use strict';
// Does an update end the terminals? The pty-keeper (scripts/pty-keeper.js)
// owns every terminal; daemon and host restarts leave it, and the sessions,
// running. Two things are different about it:
//
// - Its PROTOCOL (`const VERSION = N`, also published as package.json
//   "hopKeeperProtocol"): the keeper a host needs. An update whose host needs
//   a newer protocol than the running keeper speaks cannot be applied
//   without replacing the keeper — which ends every terminal. Bump both only
//   for a change the host depends on.
// - Its CODE: a keeper started before its file last changed is missing
//   fixes. That never forces anything; replacing it is the user's choice.
//
// Pure: the daemon and `hop update` supply what they read.

/** The protocol a keeper source declares, or null. */
function parseKeeperProtocol(source) {
    const m = /\bconst\s+VERSION\s*=\s*(\d+)\s*;/.exec(String(source || ''));
    return m ? Number(m[1]) : null;
}

/**
 * What the next update means for the terminals.
 *   running:   { version, pid, startedAt (ms), terminals } | null (no keeper)
 *   installed: { protocol, changedAt (ms) } — the code on disk
 *   latest:    { protocol } | null — the release an update would install
 */
function keeperPlan({ running, installed, latest }) {
    if (!running) {
        return { keeper: false, requiresRestart: false, stale: false, reason: null };
    }
    const speaks = Number(running.version) || 0;
    const need = Math.max(Number(installed?.protocol) || 0, Number(latest?.protocol) || 0);
    const requiresRestart = need > speaks;
    const stale = !!(installed?.changedAt && running.startedAt && installed.changedAt > running.startedAt);
    const reason = requiresRestart
        ? `this update needs terminal keeper protocol ${need}; the running keeper speaks ${speaks}`
        : stale
            ? 'the terminal keeper predates fixes to it that are already installed'
            : null;
    return { keeper: true, requiresRestart, stale, reason, runningProtocol: speaks, neededProtocol: need };
}

module.exports = { parseKeeperProtocol, keeperPlan };
