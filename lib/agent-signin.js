'use strict';
// Signing in to an agent account from hop's Accounts page.
//
// The daemon runs the agent's own sign-in in a terminal of its own —
//   Claude Code   claude auth login
//   Codex         codex login
//   Antigravity   agy (its first screen asks how to sign in)
// — and the page shows what matters from it: the sign-in link (to open, or
// to copy into a private window when the browser is signed in to someone
// else), a box for the code a sign-in page may hand back, and the CLI's last
// lines. This module reads the CLI's output; it is pure, so it is tested
// without running anything.

/** A terminal's output as plain lines: no colours, cursor moves or links. */
function plainText(raw) {
    return String(raw || '')
        // OSC (window titles, hyperlinks): ESC ] … BEL or ESC \
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        // CSI sequences
        .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, '')
        // Other two-character escapes (charset, keypad)
        .replace(/\x1b[()*+][A-Za-z0-9]|\x1b[=>78DEHMNOZc]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// Where each agent sends a person to sign in.
const AUTH_URL = {
    claude: /^https:\/\/(?:[a-z0-9-]+\.)*(?:claude\.ai|claude\.com|anthropic\.com)\/\S*(?:oauth|authorize)/i,
    codex: /^https:\/\/auth\.openai\.com\/\S*(?:oauth|authorize)/i,
    antigravity: /^https:\/\/accounts\.google\.com\/\S*oauth/i
};

/** Every https link in the output, including those hidden in terminal hyperlinks. */
function linksIn(raw) {
    const text = String(raw || '');
    const out = [];
    const push = (u) => {
        const clean = u.replace(/[)\]}>"'.,;│|]+$/, '');
        if (clean.length > 12 && !out.includes(clean)) out.push(clean);
    };
    for (const m of text.matchAll(/\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g)) push(m[1]);
    for (const m of plainText(text).matchAll(/https:\/\/[^\s"'<>│|]+/g)) push(m[0]);
    return out;
}

/** The sign-in link for an agent: its auth host, the longest (most complete) seen. */
function signInLink(agent, raw) {
    const re = AUTH_URL[agent];
    const found = linksIn(raw).filter((u) => (re ? re.test(u) : /oauth|authorize/i.test(u)));
    return found.sort((a, b) => b.length - a.length)[0] || null;
}

// The CLI's last lines worth reading: no rules drawn with box characters,
// nothing a page has to scroll sideways for.
const lastLines = (text, n) => text.split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^[\s─━═│┃┌┐└┘├┤┬┴┼╭╮╯╰▄▀█░▒▓⣀-⣿.·•-]+$/.test(l))
    .map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l))
    .slice(-n);

/**
 * What a sign-in's output says now:
 *   url            the link to sign in at
 *   wantsCode      the CLI is asking for a code from the sign-in page
 *   chooseMethod   agy's first screen: which way to sign in (Google OAuth is first)
 *   succeeded      the CLI said it is signed in
 *   lines          its last lines, links shortened, for the page
 */
function readSignIn(agent, raw) {
    const text = plainText(raw);
    const tail = text.slice(-6000);
    const url = signInLink(agent, raw);
    const succeeded = agent === 'claude' ? /Login successful|Successfully logged in|Logged in as/i.test(tail)
        : agent === 'codex' ? /Successfully logged in/i.test(tail)
        : /authenticated successfully as|Signed in as/i.test(tail);
    const wantsCode = !succeeded && /paste (?:the |an |your )?(?:authori[sz]ation )?code|code here|enter (?:the )?code/i.test(tail);
    // (Once its link is out, the choice was made.)
    const chooseMethod = agent === 'antigravity' && !url && /Select login method/i.test(tail) && /Google OAuth/i.test(tail);
    const lines = lastLines(tail, 14).map((l) => l.replace(/https:\/\/\S{40,}/g, (u) => `${u.slice(0, 36)}…`));
    return { url, wantsCode, chooseMethod, succeeded, lines };
}

/** A code or line the person typed for the CLI: one line, printable, bounded. */
function cleanInput(text) {
    const s = String(text || '').replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
    return s.length > 0 && s.length <= 2000 ? s : null;
}

module.exports = { plainText, linksIn, signInLink, readSignIn, cleanInput, AUTH_URL };
