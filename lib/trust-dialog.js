'use strict';
const fs = require('fs');

// The directory the dialog is asking about, so an answer is only ever given
// for the workspace the session was launched in - never for wherever a
// shell happened to wander.
function trustDialogWorkspace(screenText) {
    const m = /Accessing\s*workspace:?\s*(\/[^\s\u2502\u2500]+)/i.exec(String(screenText || ''));
    return m ? m[1].replace(/\/+$/, '') : null;
}
/**
 * What a trust dialog on screen is asking, and the exact keys that say yes.
 *
 * Two variants exist. The classic one names the workspace ("Accessing
 * workspace: /path") and numbers its options ("1. Yes, proceed / 2. No,
 * exit"): typing the number answers it. The other appears when the folder's
 * .claude/settings.json pre-approves tool permissions: it names no path (the
 * folder IS the launch directory), lists "No, exit" FIRST, and is an ARROW
 * SELECTOR — a ❯ marks the highlighted option and Enter confirms it. Typing
 * a digit does nothing there, and the Enter that follows confirms the
 * default: "No, exit". That is exactly how motif's restore was declined
 * three times over — "1\r" on 2026-09-04, "2\r" on 2026-09-10 — and the
 * session came back as a shell each time. So the answer is read off the
 * screen: the number when the options are numbered, otherwise enough arrow
 * presses to move the highlight onto the yes option, then Enter.
 */
function trustDialogAnswer(screenText, sessionCwd) {
    const text = String(screenText || '');
    const asked = trustDialogWorkspace(text);
    const preapproval = /pre-?approves\s*\d+\s*tool\s*permissions|Only\s*proceed\s*if\s*you\s*trust\s*this\s*configuration/i.test(text);
    const lines = text.split('\n');
    const isYes = (l) => /Yes,?\s*(I\s*trust\s*this\s*folder|proceed)/i.test(l);
    const isOption = (l) => isYes(l) || /No,?\s*exit/i.test(l);
    const yesIdx = lines.findIndex(isYes);
    let input = '1\r';
    let how = 'option 1';
    if (yesIdx >= 0) {
        const numbered = /(?:^|\s)(\d+)\.\s*Yes/i.exec(lines[yesIdx]);
        if (numbered) {
            input = `${numbered[1]}\r`;
            how = `option ${numbered[1]}`;
        } else {
            // Highlighted row → yes row, counting only option rows between.
            const highlighted = lines.findIndex((l) => /[❯›>]\s*(Yes|No)/i.test(l));
            const from = highlighted >= 0 ? highlighted : lines.findIndex(isOption);
            const between = lines.slice(Math.min(from, yesIdx), Math.max(from, yesIdx)).filter(isOption).length;
            const steps = from === yesIdx ? 0 : Math.max(0, between - (from < yesIdx ? 0 : 0));
            const arrow = from < yesIdx ? '\x1b[B' : '\x1b[A';
            input = arrow.repeat(from === yesIdx ? 0 : Math.max(1, steps)) + '\r';
            how = from === yesIdx ? 'Enter on the highlighted yes' : `${from < yesIdx ? 'down' : 'up'} ×${Math.max(1, steps)} + Enter`;
        }
    }
    const ours = asked ? samePath(asked, sessionCwd) : preapproval;
    return { input, how, asked, preapproval, ours };
}
function samePath(a, b) {
    const norm = (p) => {
        let v = String(p || '').replace(/\/+$/, '');
        try { v = fs.realpathSync(v); } catch (e) { /* keep as-is */ }
        return v;
    };
    return !!a && !!b && norm(a) === norm(b);
}

module.exports = { trustDialogWorkspace, trustDialogAnswer, samePath };
