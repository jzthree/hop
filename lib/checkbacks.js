'use strict';
// Check-backs: a message typed into a session at a later moment, on a
// trigger the daemon watches. For the human ("remind the surf agent at
// 15:00 to report") and for agents, which promise to "check back in 30
// minutes" and then — Codex reliably — never do: the agent schedules the
// check-back with hop, and hop types the prompt into it when the moment
// comes, whether or not the agent remembered.
//
// Triggers:
//   at     one moment (ms since epoch)
//   every  a period, from the first moment on
//   idle   the next time the session is not working (an agent's turn ended)
//   file   a path appears, or changes after the check-back was made
//   cmd    a shell command exits 0 (polled every `everyMs`)
//
// Delivery waits for the session to be idle unless `force`: a prompt typed
// mid-turn lands in the agent's composer and only submits when the turn
// ends, which is confusing; waiting is what a person at the keyboard does.
//
// Pure: the daemon supplies the clock and the probes and types the text.

const MINUTE = 60_000;

/** "45m", "2h", "1h30m", "90s", "2d" → ms; null if not a duration. */
function parseDuration(s) {
    const str = String(s || '').trim().toLowerCase();
    if (!str) return null;
    const re = /(\d+(?:\.\d+)?)\s*(min|d|h|m|s)(?![a-z])/g;
    let total = 0, matched = false, last = 0;
    for (let m = re.exec(str); m; m = re.exec(str)) {
        matched = true; last = re.lastIndex;
        const n = Number(m[1]);
        const unit = m[2][0];
        total += n * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? MINUTE : 1000);
    }
    if (!matched || str.slice(last).trim() !== '') return null;
    return total > 0 ? Math.round(total) : null;
}

/**
 * A moment: a duration from now ("45m"), a clock time today or tomorrow
 * ("15:00", "3pm", "9:30pm"), or an ISO date-time. ms since epoch, or null.
 */
function parseWhen(s, now = Date.now()) {
    const str = String(s || '').trim();
    if (!str) return null;
    const dur = parseDuration(str);
    if (dur) return now + dur;
    const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(str);
    if (clock) {
        let h = Number(clock[1]);
        const min = Number(clock[2] || 0);
        const ap = (clock[3] || '').toLowerCase();
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        if (h > 23 || min > 59) return null;
        const d = new Date(now);
        d.setHours(h, min, 0, 0);
        let t = d.getTime();
        if (t <= now) t += 86_400_000; // that time has passed today: tomorrow
        return t;
    }
    const iso = Date.parse(str);
    return Number.isFinite(iso) ? iso : null;
}

const SESSION_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate and normalise a request into a stored check-back. Throws with a
 * message fit for the CLI/API on bad input. Exactly one trigger.
 */
function normalizeCheckback(input, now = Date.now(), id = null) {
    const o = input || {};
    const session = String(o.session || '').trim();
    if (!session || !SESSION_RE.test(session)) throw new Error('a session is required');
    const message = String(o.message || '').replace(/[\r\n]+$/, '').trim();
    if (!message) throw new Error('a message to type is required');
    if (message.length > 4000) throw new Error('message too long (4000 chars max)');
    let trigger = null;
    const set = (k) => o[k] !== undefined && o[k] !== null && o[k] !== false && o[k] !== '';
    // With a command probe, `every` is its poll period, not a trigger of its own.
    const given = ['at', 'in', 'every', 'idle', 'file', 'cmd'].filter((k) => set(k) && !(k === 'every' && set('cmd')) && !(k === 'at' && set('every')));
    if (given.length !== 1) throw new Error('exactly one trigger: --at <time> | --in <duration> | --every <duration> | --when-idle | --when-file <path> | --when-cmd <command>');
    const k = given[0];
    if (k === 'at' || k === 'in') {
        const at = k === 'in' ? (parseDuration(o.in) ? now + parseDuration(o.in) : null) : parseWhen(o.at, now);
        if (!at) throw new Error(k === 'in' ? 'bad duration (try 45m, 2h, 1h30m)' : 'bad time (try 15:00, 3pm, 45m, or an ISO date)');
        trigger = { kind: 'at', at };
    } else if (k === 'every') {
        const everyMs = parseDuration(o.every);
        if (!everyMs || everyMs < MINUTE) throw new Error('bad period (at least 1m: try 30m, 2h)');
        const first = o.at ? parseWhen(o.at, now) : now + everyMs;
        trigger = { kind: 'every', everyMs, next: first || now + everyMs, until: o.until ? parseWhen(o.until, now) : null };
    } else if (k === 'idle') {
        const afterMs = o.idleFor ? parseDuration(o.idleFor) : 0;
        trigger = { kind: 'idle', afterMs: afterMs || 0, armedAt: now };
    } else if (k === 'file') {
        const p = String(o.file).trim();
        if (!p) throw new Error('a path is required');
        trigger = { kind: 'file', path: p, baselineMtime: Number.isFinite(o.baselineMtime) ? o.baselineMtime : null };
    } else if (k === 'cmd') {
        const command = String(o.cmd).trim();
        if (!command) throw new Error('a command is required');
        const everyMs = parseDuration(o.every) || MINUTE;
        trigger = { kind: 'cmd', command, everyMs, nextCheck: now, cwd: o.cwd || null };
    }
    return {
        id: id || `cb_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        session,
        message,
        trigger,
        force: o.force === true,
        createdBy: o.createdBy || 'user',
        createdAt: now,
        status: 'pending',
        firedAt: null,
        deliveredAt: null,
        deliveries: 0,
        lastError: null
    };
}

/**
 * Has the trigger fired? `ctx` carries what the daemon probed for this
 * check-back this sweep: `phase` ('working' | 'done' | null | undefined
 * when the session is unknown), `fileMtime` (ms, or null when absent),
 * `cmdExit` (0 = success, other = not yet, undefined = not probed).
 */
function triggerFired(cb, ctx, now = Date.now()) {
    const t = cb.trigger || {};
    switch (t.kind) {
        case 'at': return now >= t.at;
        case 'every': return now >= t.next && (!t.until || now <= t.until);
        case 'idle': {
            if (ctx.phase === 'working') return false;
            const since = Number(ctx.idleSince) || t.armedAt || cb.createdAt;
            return now - since >= (t.afterMs || 0);
        }
        case 'file': {
            if (ctx.fileMtime === null || ctx.fileMtime === undefined) return false;
            return t.baselineMtime === null || t.baselineMtime === undefined ? true : ctx.fileMtime > t.baselineMtime;
        }
        case 'cmd': return ctx.cmdExit === 0;
        default: return false;
    }
}

/** A fired check-back may be typed now? Idle, or forced, or not an agent at all. */
function mayDeliver(cb, ctx) {
    if (cb.force) return true;
    return ctx.phase !== 'working';
}

/** The record after a delivery: done, or rescheduled for a periodic one. */
function afterDelivery(cb, now = Date.now()) {
    const next = { ...cb, deliveredAt: now, deliveries: (cb.deliveries || 0) + 1, firedAt: null, lastError: null };
    const t = cb.trigger || {};
    if (t.kind === 'every') {
        let n = t.next;
        while (n <= now) n += t.everyMs;
        if (t.until && n > t.until) return { ...next, status: 'delivered' };
        return { ...next, status: 'pending', trigger: { ...t, next: n } };
    }
    if (t.kind === 'cmd' || t.kind === 'file' || t.kind === 'idle' || t.kind === 'at') return { ...next, status: 'delivered' };
    return { ...next, status: 'delivered' };
}

/** Which of the pending check-backs need a cmd probe this sweep. */
function cmdDue(cb, now = Date.now()) {
    const t = cb.trigger || {};
    return cb.status === 'pending' && t.kind === 'cmd' && now >= (t.nextCheck || 0);
}

/** One line for `hop checkback --list`. */
function describe(cb, now = Date.now()) {
    const t = cb.trigger || {};
    const rel = (ms) => {
        const d = ms - now, a = Math.abs(d);
        const s = a < MINUTE ? `${Math.round(a / 1000)}s` : a < 3_600_000 ? `${Math.round(a / MINUTE)}m` : a < 86_400_000 ? `${(a / 3_600_000).toFixed(1)}h` : `${(a / 86_400_000).toFixed(1)}d`;
        return d >= 0 ? `in ${s}` : `${s} ago`;
    };
    let when = '';
    if (t.kind === 'at') when = `at ${new Date(t.at).toLocaleString()} (${rel(t.at)})`;
    else if (t.kind === 'every') when = `every ${Math.round(t.everyMs / MINUTE)}m, next ${rel(t.next)}`;
    else if (t.kind === 'idle') when = t.afterMs ? `when idle for ${Math.round(t.afterMs / MINUTE)}m` : 'when idle';
    else if (t.kind === 'file') when = `when ${t.path} ${t.baselineMtime ? 'changes' : 'exists'}`;
    else if (t.kind === 'cmd') when = `when \`${t.command}\` succeeds (every ${Math.round(t.everyMs / MINUTE)}m)`;
    const state = cb.status === 'pending' && cb.firedAt ? 'fired, waiting for idle' : cb.status;
    return `${cb.id}  ${cb.session}  ${when}  [${state}${cb.force ? ', force' : ''}]  ${JSON.stringify(cb.message.slice(0, 60))}`;
}

module.exports = { parseDuration, parseWhen, normalizeCheckback, triggerFired, mayDeliver, afterDelivery, cmdDue, describe };
