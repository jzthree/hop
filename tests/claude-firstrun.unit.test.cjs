// Claude Code's first-run screens, as hop reads them off a relaunched session.
const test = require('node:test');
const assert = require('node:assert/strict');
const { firstRunStep } = require('../lib/claude-firstrun');

const UP = '\x1b[A', DOWN = '\x1b[B', ENTER = '\r', ESC = '\x1b';

// As captured (2.1.332) from a session hop moved into a new account folder.
const THEME = ` Let's get started.
 Choose the text style that looks best with your terminal
 To change this later, run /theme
 Auto (match terminal)
 Dark mode
 Light mode
 Dark mode (colorblind-friendly)
 ❯ ✔ Light mode (colorblind-friendly)
 Dark mode (ANSI colors only)
 Light mode (ANSI colors only)
 ╌╌╌╌╌╌╌╌╌╌
 1 function greet() {
 Syntax theme: GitHub (ctrl+t to disable)`;

const CHROME = ` Claude in Chrome extension detected
 Claude will use your Chrome browser by default — navigating sites, filling forms, and capturing screenshots in your existing session.
 ❯ No, keep browser tools off
 Yes, use my browser
 Enter to confirm · Esc to keep browser tools off`;

const NOTES = ` Security notes:
 1. Claude can make mistakes.
 You're responsible for Claude's actions and should always
 review them, especially when running code.
 Press Enter to continue…`;

const TERMINAL = ` Use Claude Code's terminal setup?
 Recommended for your terminal:
 ❯ 1. Yes, use recommended settings
 2. No, maybe later with /terminal-setup`;

test('theme picker: the person\'s own theme, chosen by moving the cursor onto it', () => {
  assert.deepEqual(firstRunStep(THEME, { theme: 'dark-daltonized' }), { kind: 'theme', keys: UP + ENTER });
  assert.deepEqual(firstRunStep(THEME, { theme: 'light-ansi' }), { kind: 'theme', keys: DOWN + DOWN + ENTER });
  assert.deepEqual(firstRunStep(THEME, { theme: 'light-daltonized' }), { kind: 'theme', keys: ENTER }, 'already on it');
  assert.deepEqual(firstRunStep(THEME, {}), { kind: 'theme', keys: ENTER }, 'no preference known: keep the picker\'s');
  assert.deepEqual(firstRunStep(THEME, { theme: 'no-such' }), { kind: 'theme', keys: ENTER });
});

test('Chrome prompt: browser tools stay off', () => {
  assert.deepEqual(firstRunStep(CHROME), { kind: 'chrome', keys: ESC });
});

test('security notes: Enter; terminal setup: No, never a change to the terminal', () => {
  assert.deepEqual(firstRunStep(NOTES), { kind: 'notes', keys: ENTER });
  assert.deepEqual(firstRunStep(TERMINAL), { kind: 'terminal-setup', keys: DOWN + ENTER });
});

test('anything else is the person\'s to answer', () => {
  assert.equal(firstRunStep(' Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n Yes, I trust this folder'), null);
  assert.equal(firstRunStep(' Allow external CLAUDE.md file imports?\n ❯ No, disable external imports'), null);
  assert.equal(firstRunStep('❯ run M2\n⏵⏵ auto mode on'), null);
  assert.equal(firstRunStep(''), null);
});
