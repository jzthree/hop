'use strict';
// Update check — notify-only, never installs anything by itself.
//
// At daemon start (and daily after) asks the npm registry for the newest
// published hop2 and compares it with the running version. The answer is
// served at /api/update for the web client's notice, and logged once to the
// daemon log. HOP_NO_UPDATE_CHECK=1 turns it off. Network failures are
// silent: an update check must never affect operation.

const fs = require('fs');
const path = require('path');

const REGISTRY_URL = 'https://registry.npmjs.org/hop2/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

// Numeric compare on MAJOR.MINOR.PATCH; prerelease tags are ignored.
function isNewerVersion(latest, current) {
    const parse = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const l = parse(latest);
    const c = parse(current);
    for (let i = 0; i < 3; i++) {
        if ((l[i] || 0) !== (c[i] || 0)) return (l[i] || 0) > (c[i] || 0);
    }
    return false;
}

// A git checkout updates with `hop update`; an npm install with npm.
function installKind(root) {
    return fs.existsSync(path.join(root, '.git')) ? 'git' : 'npm';
}

function updateCommand(kind) {
    return kind === 'git' ? 'hop update' : 'npm install -g hop2@latest && hop update --restart';
}

function createUpdateChecker({ root, current, fetchImpl = globalThis.fetch, log = () => {}, url = REGISTRY_URL } = {}) {
    const kind = installKind(root);
    let info = { current, latest: null, updateAvailable: false, checkedAt: null, install: kind, command: updateCommand(kind) };
    let timer = null;

    async function checkOnce() {
        try {
            const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!res.ok) return info;
            const data = await res.json();
            if (!data || typeof data.version !== 'string') return info;
            const updateAvailable = isNewerVersion(data.version, info.current);
            const firstDiscovery = updateAvailable && info.latest !== data.version;
            info = { ...info, latest: data.version, updateAvailable, checkedAt: Date.now() };
            if (firstDiscovery) log(`hop ${data.version} is available (running ${info.current}) — update with: ${info.command}`);
        } catch (e) { /* offline / registry down — stay quiet */ }
        return info;
    }

    return {
        start() {
            if (process.env.HOP_NO_UPDATE_CHECK) return;
            void checkOnce();
            timer = setInterval(() => void checkOnce(), CHECK_INTERVAL_MS);
            timer.unref?.();
        },
        stop() { if (timer) { clearInterval(timer); timer = null; } },
        checkOnce,
        info: () => info,
    };
}

module.exports = { createUpdateChecker, isNewerVersion, installKind, updateCommand, REGISTRY_URL };
