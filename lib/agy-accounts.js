'use strict';
// More than one Antigravity login on one Mac.
//
// agy (1.5.x) keeps its login in ONE keychain entry (service "gemini",
// account "antigravity") whatever folder it runs with, and no setting or
// variable changes that. Two things together give it a second login:
//
//   --gemini_dir <folder>   everything agy keeps (settings, conversations,
//                           logs) is read from and written to <folder>;
//   no keychain             agy reaches the keychain through
//                           /usr/bin/security. Run in a sandbox that may not
//                           start that program, it logs "OS credential
//                           manager unavailable … falling back to file-based
//                           secret storage" and keeps the login in a file
//                           in <folder> instead.
//
// Checked on 1.5.13: with the whole home folder walled off except the
// folder given, a sandboxed agy still starts and asks to sign in — nothing
// it needs for its login lives outside that folder. The default account
// (~/.gemini, the keychain) is never run sandboxed and never changes.
//
// An account folder is not a separate world: conversations, hop's hooks,
// skills and MCP servers are shared with the default folder by symbolic
// links, so a conversation can continue on any account (that is how a
// session moves when one account runs out) and hop finds every
// conversation in one place.

const fs = require('fs');
const path = require('path');

/** The file that marks a folder hop set up as an Antigravity account. */
const MARKER = '.hop-agy-account';

const KEYCHAIN_TOOL = '/usr/bin/security';
const BROWSER_TOOL = '/usr/bin/open';

/**
 * The sandbox agy runs in. `keychain: false` (an account folder) keeps it
 * from the keychain; `browser: false` (a background check) keeps it from
 * opening a sign-in page — a signed-out agy opens one by itself.
 */
function sandboxProfile({ keychain = false, browser = true } = {}) {
    let p = '(version 1)(allow default)';
    if (!keychain) p += `(deny process-exec (literal "${KEYCHAIN_TOOL}"))`;
    if (!browser) p += `(deny process-exec (literal "${BROWSER_TOOL}"))`;
    return p;
}

// Shared with the default folder. Folders here are created there first when
// missing, so a conversation started on any account lands in the one store.
const SHARED_DIRS = [
    'antigravity-cli/brain',
    'antigravity-cli/conversations',
    'antigravity-cli/annotations',
    // Which conversations are open right now: shared, so two accounts never
    // write one conversation at once.
    'antigravity-cli/presence',
    'antigravity-cli/implicit',
    'config/skills'
];
// Shared when the default folder has them.
const SHARED_FILES = [
    'antigravity-cli/history.jsonl',
    'antigravity-cli/settings.json',
    'antigravity-cli/bin',
    'config/hooks.json',
    'config/mcp_config.json',
    'config/config.json',
    'config/projects',
    'projects.json'
];

/**
 * Make `dir` an Antigravity account folder beside `defaultDir`. It holds
 * no login until someone signs in to it. → { links: [relative paths] }.
 * Throws when the folder is already there.
 */
function setUpAccountDir(dir, defaultDir, { fsImpl = fs, now = Date.now() } = {}) {
    if (fsImpl.existsSync(dir)) throw new Error(`${dir} is already there`);
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const sub of ['antigravity-cli', 'config']) fsImpl.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
    const links = [];
    const link = (rel) => {
        const from = path.join(defaultDir, rel);
        const to = path.join(dir, rel);
        fsImpl.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        fsImpl.symlinkSync(from, to);
        links.push(rel);
    };
    for (const rel of SHARED_DIRS) {
        fsImpl.mkdirSync(path.join(defaultDir, rel), { recursive: true, mode: 0o700 });
        link(rel);
    }
    for (const rel of SHARED_FILES) if (fsImpl.existsSync(path.join(defaultDir, rel))) link(rel);
    fsImpl.writeFileSync(path.join(dir, MARKER), JSON.stringify({ agent: 'antigravity', createdAt: new Date(now).toISOString(), sharedWith: defaultDir }, null, 1) + '\n', { mode: 0o600 });
    return { links };
}

/**
 * How to start agy as an account. `home`: { dir, isDefault }. `bin`: the
 * real agy. → { file, args } to put before agy's own arguments.
 * A background check (`browser: false`) of the default account still runs
 * sandboxed — keychain allowed — so a signed-out default never opens a page.
 */
function launchFor(home, { bin, browser = true, dataDir = null } = {}) {
    const own = home && !home.isDefault ? home.dir : dataDir;
    const tail = own ? ['--gemini_dir', own] : [];
    if (home && !home.isDefault) {
        return { file: '/usr/bin/sandbox-exec', args: ['-p', sandboxProfile({ keychain: false, browser }), bin, ...tail] };
    }
    if (!browser) return { file: '/usr/bin/sandbox-exec', args: ['-p', sandboxProfile({ keychain: true, browser: false }), bin, ...tail] };
    return { file: bin, args: tail };
}

/** The shell form, for a terminal: `HOP_AGY_HOME='…' '<launcher>'` (the default account: plain agy). */
function shellLaunch(home, launcher, agyWord = 'agy') {
    if (!home || home.isDefault) return agyWord;
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    return `HOP_AGY_HOME=${q(home.dir)} ${q(launcher)}`;
}

/** Who a sandboxed agy signed in as, from its log: the last "authenticated successfully as …". */
function emailFromLog(text) {
    const all = String(text || '').match(/authenticated successfully as (\S+@\S+)/g);
    return all && all.length ? all[all.length - 1].replace(/^.* as /, '') : null;
}

/** agy's print mode says this, and waits, when it is not signed in. */
const SIGNED_OUT_RE = /Authentication required|You are not logged into Antigravity|not signed in/i;

module.exports = { MARKER, sandboxProfile, setUpAccountDir, launchFor, shellLaunch, emailFromLog, SIGNED_OUT_RE, SHARED_DIRS, SHARED_FILES };
