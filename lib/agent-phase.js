'use strict';
// What an agent session is doing right now, for the wall's colours — the web
// wall and the phone both read it from the session list, so they agree:
//
//   working      a turn is in flight
//   done         the last turn finished, and the human has not opened the
//                session since  (turnSeen: false)
//   done, read   the last turn finished and the human has looked  (turnSeen: true)
//
// Decided from records hop already keeps. The turn record (`.turn`, written by
// Claude's Stop hook and Codex's notify chain) says when the last turn ENDED.
// Claude's UserPromptSubmit hook (`.prompt`) says when the current one began;
// Codex has no such hook, so for it — and for Claude sessions that predate
// the hook — output flowing after the last turn ended stands in for it.
// "Read" is the daemon's seen witness: a user client (not a wall preview, not
// an agent's terminal) attached to the session since the turn ended.

/** Output this recent means a turn is in flight (Codex spins while it works). */
const WORKING_RECENT_MS = 15000;
/** A submitted prompt with no output for this long was interrupted (Esc), not working. */
const PROMPT_STALE_MS = 45000;
/** The final render lands just after the Stop hook fires; output inside this tail is the turn's own. */
const TURN_TAIL_MS = 1500;

/**
 * @param {object} o
 * @param {string|null} o.agent            'claude' | 'codex' | null
 * @param {number} [o.turnAt]              ms, when the last turn ended (0 = never)
 * @param {number} [o.promptAt]            ms, when the last prompt was submitted (0 = unknown)
 * @param {number} [o.lastActivityAt]      ms, last PTY output
 * @param {number} [o.lastUserSeenAt]      ms, when a user client last left (or attached)
 * @param {boolean} [o.userAttached]       a user client is on it right now
 * @param {boolean|null} [o.screenWorking]  what the LIVE screen says, when it was read:
 *        both TUIs print "esc to interrupt" only while a turn runs. Wins over
 *        the timing heuristics — Codex repaints while idle (rotating tips, the
 *        user typing), which looked like work from the timestamps alone.
 * @param {number} [o.now]
 * @returns {{ phase: 'working'|'done'|null, turnSeen: boolean }}
 */
function agentPhase(o) {
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    if (!o.agent) return { phase: null, turnSeen: true };
    const turnAt = Number(o.turnAt) || 0;
    const promptAt = Number(o.promptAt) || 0;
    const active = Number(o.lastActivityAt) || 0;
    let working;
    if (o.screenWorking === true || o.screenWorking === false) {
        working = o.screenWorking;
    } else if (promptAt > turnAt) {
        // Claude, with the prompt hook: a prompt newer than the last turn end
        // is a turn in flight — unless the screen has been dead quiet for so
        // long that it was interrupted and never finished.
        working = active > 0 && now - active < PROMPT_STALE_MS;
    } else {
        working = active > 0 && now - active < WORKING_RECENT_MS && active > turnAt + TURN_TAIL_MS;
    }
    if (working) return { phase: 'working', turnSeen: true };
    if (!turnAt) return { phase: null, turnSeen: true };
    const seenAt = o.userAttached ? now : (Number(o.lastUserSeenAt) || 0);
    return { phase: 'done', turnSeen: seenAt >= turnAt };
}

/** The screen's own word: a turn in flight prints this in both TUIs. */
const WORKING_SCREEN_RE = /esc to interrupt/i;
const screenSaysWorking = (text) => WORKING_SCREEN_RE.test(String(text || ''));

module.exports = { agentPhase, screenSaysWorking, WORKING_SCREEN_RE, WORKING_RECENT_MS, PROMPT_STALE_MS, TURN_TAIL_MS };
