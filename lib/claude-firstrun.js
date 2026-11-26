'use strict';
// Claude Code's first run in an account folder it has not set up yet: a
// theme picker, security notes, an offer to change the terminal's settings,
// and (with the Chrome extension installed) whether to use the browser.
// hop moves a session into such a folder when it changes accounts, and the
// relaunched session then sits on these screens while hop's "continue"
// waits for an input box that never comes.
//
// Here: which of those screens is up, and the keys that answer it the way a
// careful person would — the theme they already chose elsewhere, Enter past
// the notes, "No" to changing the terminal, browser tools left off. Only
// these screens: any other question (trusting a folder, CLAUDE.md imports,
// a permission) is the person's, and gets no keys. Pure.

const UP = '\x1b[A', DOWN = '\x1b[B', ENTER = '\r', ESC = '\x1b';

// Claude Code's theme ids → the words its picker shows.
const THEME_LABEL = {
    auto: 'Auto (match terminal)',
    dark: 'Dark mode',
    light: 'Light mode',
    'dark-daltonized': 'Dark mode (colorblind-friendly)',
    'light-daltonized': 'Light mode (colorblind-friendly)',
    'dark-ansi': 'Dark mode (ANSI colors only)',
    'light-ansi': 'Light mode (ANSI colors only)'
};

const clean = (line) => String(line).replace(/[❯✔›>]/g, ' ').replace(/\s+/g, ' ').trim();

/** Keys that move a picker's ❯ from where it is onto the option reading `label`, or null. */
function moveTo(lines, label) {
    let at = -1, want = -1;
    lines.forEach((l, i) => {
        if (/❯/.test(l)) at = i;
        if (clean(l).replace(/^\d+\.\s*/, '') === label) want = i;
    });
    if (at < 0 || want < 0) return null;
    // Options are one per line; blank lines were dropped, so the distance is in options.
    const n = want - at;
    return (n > 0 ? DOWN : UP).repeat(Math.abs(n));
}

/**
 * The first-run screen on `screenText` (the visible rows, ANSI stripped),
 * and the keys that answer it: { kind, keys } or null.
 * `theme` is the theme id to choose (the person's own, from another folder);
 * without one the picker's own choice is kept.
 */
function firstRunStep(screenText, { theme = null } = {}) {
    const lines = String(screenText || '').split('\n').filter((l) => l.trim());
    const text = lines.join('\n');
    if (/Claude in Chrome extension detected/.test(text) && /Esc to keep browser tools off/.test(text)) {
        return { kind: 'chrome', keys: ESC };
    }
    if (/Choose the text style that looks best with your terminal/.test(text) && /To change this later, run \/theme/.test(text)) {
        const label = theme && THEME_LABEL[theme];
        const move = label ? moveTo(lines, label) : '';
        return { kind: 'theme', keys: (move || '') + ENTER };
    }
    // (Its "press Enter" line has had more than one wording: the notes themselves say which screen this is.)
    if (/Security notes:/.test(text) && /Claude can make mistakes/.test(text) && !/❯/.test(text)) {
        return { kind: 'notes', keys: ENTER };
    }
    if (/Use Claude Code's terminal setup\?/.test(text)) {
        const move = moveTo(lines, 'No, maybe later with /terminal-setup');
        return move === null ? null : { kind: 'terminal-setup', keys: move + ENTER };
    }
    return null;
}

module.exports = { firstRunStep, THEME_LABEL };
