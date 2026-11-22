'use strict';
// Removing an agent account (Settings → Agent accounts).
//
// An account is a folder (lib/agent-homes.js). Removing one takes it out of
// hop's lists and the rotation, and this Mac forgets its login, but loses
// nothing else: the folder, with its conversations, is moved into hop's own
// folder (removed-accounts/), where it can be moved back from or deleted.
// Its login goes: Claude Code's keychain entry for that folder, and the
// login files an agent keeps in the folder itself. Nobody is signed out on
// the server, so another folder holding the same login keeps working.
//
// The agent's own folder (the default account) is never removed, nor one a
// session is running on or signing in to.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The login an agent keeps inside an account folder.
const LOGIN_FILES = {
    claude: ['.credentials.json'],          // Linux; on a Mac it is in the keychain
    codex: ['auth.json'],
    antigravity: ['antigravity-cli/antigravity-oauth-token']
};

/** Claude Code's keychain entry for a config folder (a folder other than ~/.claude). */
const claudeKeychainService = (dir) =>
    `Claude Code-credentials-${crypto.createHash('sha256').update(String(dir)).digest('hex').slice(0, 8)}`;

/** Where a removed folder goes: `<removedDir>/codex_work-2026-11-21-231500`. */
function removedFolderFor(dir, removedDir, now = Date.now()) {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return path.join(removedDir, `${path.basename(dir).replace(/^\.+/, '')}-${stamp}`);
}

/**
 * Why an account cannot be removed now, in a sentence for the page; null
 * when it can. `home`: { dir, label, isDefault }.
 */
function whyNotRemovable({ agent, home, liveSessions = 0, signingIn = false, envDir = null }) {
    if (!home) return 'There is no such account';
    if (home.isDefault) return `The default account is ${agent === 'antigravity' ? 'Antigravity' : agent === 'codex' ? 'Codex' : 'Claude Code'}'s own folder, so hop does not remove it`;
    if (envDir && path.resolve(envDir) === path.resolve(home.dir)) return 'hop was started with this folder as its own account, so it stays';
    if (signingIn) return 'It is signing in: cancel that first';
    if (liveSessions > 0) return `${liveSessions} running ${liveSessions === 1 ? 'session uses' : 'sessions use'} it: move ${liveSessions === 1 ? 'it' : 'them'} to another account, or close ${liveSessions === 1 ? 'it' : 'them'}, first`;
    return null;
}

/**
 * Move an account folder to `dest` (never following its links: an
 * Antigravity folder links to the default one's conversations), then drop
 * the login files in the moved copy. → { dest, droppedLogins: [relative paths] }.
 */
function moveAccountFolder(agent, dir, dest, { fsImpl = fs } = {}) {
    fsImpl.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    if (fsImpl.existsSync(dest)) throw new Error(`${dest} is already there`);
    try {
        fsImpl.renameSync(dir, dest);
    } catch (e) {
        if (e && e.code !== 'EXDEV') throw e;
        // Another disk: copy (links as links), then remove the original.
        fsImpl.cpSync(dir, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
        fsImpl.rmSync(dir, { recursive: true, force: true });
    }
    const dropped = [];
    for (const rel of LOGIN_FILES[agent] || []) {
        const f = path.join(dest, rel);
        try {
            fsImpl.lstatSync(f);
            fsImpl.rmSync(f, { force: true });   // a link is removed itself, never what it points at
            dropped.push(rel);
        } catch (e) { /* not there */ }
    }
    return { dest, droppedLogins: dropped };
}

module.exports = { LOGIN_FILES, claudeKeychainService, removedFolderFor, whyNotRemovable, moveAccountFolder };
