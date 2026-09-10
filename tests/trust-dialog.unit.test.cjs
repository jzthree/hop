const test = require('node:test');
const assert = require('node:assert/strict');
const { trustDialogAnswer } = require('../lib/trust-dialog');

const classic = `
 Quick safety check
 Accessing workspace: /Users/me/proj
 Is this a project you created or one you trust?
 ❯ 1. Yes, proceed
   2. No, exit
`;
const preapproval = `
 ⚠ This folder pre-approves 15 tool permissions in .claude/settings.json:
 mcp__x__read, mcp__y__write, and 7 more
 These will apply without asking. Only proceed if you trust this configuration.
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;

test('classic numbered dialog: type the number of the yes option, only for the session\'s own workspace', () => {
    const ours = trustDialogAnswer(classic, '/Users/me/proj');
    assert.equal(ours.input, '1\r');
    assert.equal(ours.asked, '/Users/me/proj');
    assert.equal(ours.ours, true);
    assert.equal(trustDialogAnswer(classic, '/Users/me/elsewhere').ours, false);
});

test('pre-approval dialog is an arrow selector with "No, exit" highlighted: Down then Enter (the motif regression)', () => {
    const a = trustDialogAnswer(preapproval, '/Users/me');
    assert.equal(a.preapproval, true);
    assert.equal(a.input, '\x1b[B\r');
    assert.equal(a.asked, null);   // names no path: the folder is the launch directory
    assert.equal(a.ours, true);
});

test('a selector already highlighting yes needs only Enter', () => {
    const t = preapproval.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust', '❯ Yes, I trust');
    assert.equal(trustDialogAnswer(t, '/Users/me').input, '\r');
});

test('a numbered pre-approval layout takes its number', () => {
    const t = preapproval.replace('❯ No, exit', '  1. No, exit').replace('  Yes, I trust', '❯ 2. Yes, I trust');
    assert.equal(trustDialogAnswer(t, '/Users/me').input, '2\r');
});
