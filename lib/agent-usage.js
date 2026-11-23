'use strict';
// How much of an account's limits is used, as each agent's own CLI reports
// it, and what to do when a session stops at one.
//
//   Claude Code   the `get_usage` control request of a headless `claude -p`
//                 (no prompt is sent: nothing is spent)
//   Codex         `account/rateLimits/read` on a private `codex app-server`
//   Antigravity   `agy -p "/quota" --output-format json`
//
// Each answers in about a second. Their replies differ; here they become one
// shape — { plan, meters: [{ id, label, window, percent, resetsAt, model,
// models }] } — that the Accounts page draws and the rotation reads. Pure:
// the daemon runs the CLIs and hands the replies in.

/** A time as ms: ISO text, epoch seconds or epoch ms. Null when there is none. */
function toMs(t) {
    if (t === null || t === undefined || t === '') return null;
    if (typeof t === 'number') return Number.isFinite(t) && t > 0 ? (t < 1e11 ? t * 1000 : t) : null;
    const n = Date.parse(String(t));
    return Number.isFinite(n) ? n : null;
}
const percentOf = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n) * 10) / 10) : 0);

const WINDOW_LABEL = { '5h': '5-hour', week: 'Week' };
const meter = (id, window, percent, resetsAt, extra = {}) => ({
    id, window, label: extra.label || WINDOW_LABEL[window] || window,
    percent: percentOf(percent), resetsAt: toMs(resetsAt),
    model: extra.model || null, models: extra.models || null,
    ...(extra.idle ? { idle: true } : {})
});

/** Claude Code: the `response` of a successful `get_usage` control reply. */
function parseClaudeUsage(resp) {
    if (!resp || typeof resp !== 'object') return null;
    const rl = resp.rate_limits && typeof resp.rate_limits === 'object' ? resp.rate_limits : null;
    const out = { plan: resp.subscription_type || null, available: resp.rate_limits_available === true && !!rl, meters: [], extra: null };
    if (!rl) return out;
    if (Array.isArray(rl.limits)) {
        for (const row of rl.limits) {
            if (!row || typeof row !== 'object') continue;
            const name = row.scope?.model?.display_name || row.scope?.surface?.display_name || null;
            if (row.kind === 'session') out.meters.push(meter('session', '5h', row.percent, row.resets_at));
            else if (row.kind === 'weekly_all') out.meters.push(meter('week', 'week', row.percent, row.resets_at));
            else if (row.kind === 'weekly_scoped') out.meters.push(meter(`week:${name || 'scoped'}`, 'week', row.percent, row.resets_at, { label: `${name || 'Scoped'} week`, model: name || 'scoped' }));
            // A meter this hop has never heard of still counts: by its group.
            else out.meters.push(meter(String(row.kind || 'limit'), row.group === 'session' ? '5h' : 'week', row.percent, row.resets_at, { label: name ? `${name} ${row.group || ''}`.trim() : String(row.kind || 'limit').replace(/_/g, ' '), model: name }));
        }
    } else {
        // A server that predates the rows: the named windows.
        const legacy = [['five_hour', 'session', '5h', null], ['seven_day', 'week', 'week', null], ['seven_day_opus', 'week:Opus', 'week', 'Opus'], ['seven_day_sonnet', 'week:Sonnet', 'week', 'Sonnet']];
        for (const [key, id, window, model] of legacy) {
            const w = rl[key];
            if (w && typeof w === 'object') out.meters.push(meter(id, window, w.utilization, w.resets_at, model ? { label: `${model} week`, model } : {}));
        }
    }
    // No 5-hour row means no window is open: nothing used in it yet.
    if (out.available && !out.meters.some((m) => m.id === 'session')) out.meters.unshift(meter('session', '5h', 0, null, { idle: true }));
    const order = (m) => (m.id === 'session' ? 0 : m.id === 'week' ? 1 : 2);
    out.meters.sort((a, b) => order(a) - order(b));
    if (rl.extra_usage && rl.extra_usage.is_enabled === true) out.extra = { enabled: true, reached: rl.extra_usage.spend_limit_reached === true };
    return out;
}

/** Codex: the results of `account/read` and `account/rateLimits/read`. */
function parseCodexUsage(account, limits) {
    if (!limits || typeof limits !== 'object') return null;
    const snapshots = limits.rateLimitsByLimitId && typeof limits.rateLimitsByLimitId === 'object'
        ? Object.values(limits.rateLimitsByLimitId)
        : (limits.rateLimits ? [limits.rateLimits] : []);
    const rc = limits.rateLimitResetCredits && typeof limits.rateLimitResetCredits === 'object' ? limits.rateLimitResetCredits : null;
    const out = {
        plan: account?.account?.planType || snapshots.find((s) => s?.planType)?.planType || null,
        email: account?.account?.email || null,
        available: snapshots.length > 0, meters: [], reached: null,
        // Banked "full resets": each one empties the account's limits once.
        resets: Number.isFinite(Number(rc?.availableCount)) && rc.availableCount !== null ? Number(rc.availableCount) : null,
        // When the banked resets expire, soonest first (null: not told).
        resetsExpire: Array.isArray(rc?.credits)
            ? rc.credits.filter((c) => c && c.status === 'available').map((c) => toMs(c.expiresAt)).filter(Boolean).sort((a, b) => a - b)
            : null,
        // The backend's own word on whether the plan's included usage may be used now.
        ordinaryAllowed: typeof limits.ordinaryUsageAllowed === 'boolean' ? limits.ordinaryUsageAllowed : null,
        // Past the plan's limits Codex carries on with the account's paid credits.
        credits: null
    };
    for (const snap of snapshots) {
        if (!snap || typeof snap !== 'object') continue;
        const general = !snap.limitId || snap.limitId === 'codex';
        const name = general ? null : (snap.limitName || snap.normalModelSlug || snap.limitId);
        for (const w of [snap.primary, snap.secondary]) {
            if (!w || typeof w !== 'object') continue;
            const mins = Number(w.windowDurationMins) || 0;
            const window = mins >= 1440 ? 'week' : '5h';
            const span = mins >= 10080 ? 'week' : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : mins ? `${Math.round(mins / 60)}-hour` : 'limit';
            out.meters.push(meter(`${snap.limitId || 'codex'}:${mins || 'x'}`, window, w.usedPercent, w.resetsAt, {
                label: name ? `${name} ${span}` : (span === 'week' ? 'Week' : span),
                model: general ? null : (snap.normalModelSlug || name)
            }));
        }
        if (general && snap.rateLimitReachedType) out.reached = snap.rateLimitReachedType;
        if (general && snap.credits && typeof snap.credits === 'object') {
            const balance = Number(snap.credits.balance);
            out.credits = { has: snap.credits.hasCredits === true, unlimited: snap.credits.unlimited === true, balance: Number.isFinite(balance) ? balance : null };
        }
    }
    out.meters.sort((a, b) => Number(!!a.model) - Number(!!b.model) || (a.window === '5h' ? 0 : 1) - (b.window === '5h' ? 0 : 1));
    return out;
}

/** Antigravity: what `agy -p "/quota" --output-format json` prints. */
function parseAgyQuota(reply) {
    const groups = reply?.command?.data?.groups;
    if (!Array.isArray(groups)) return null;
    const out = { plan: null, available: true, meters: [] };
    for (const g of groups) {
        if (!g || !Array.isArray(g.buckets)) continue;
        const short = String(g.name || 'Models').replace(/\s+models$/i, '');
        const models = String(g.description || '').replace(/^[^:]*:\s*/, '').split(',').map((s) => s.trim()).filter(Boolean);
        for (const b of g.buckets) {
            if (!b || !Number.isFinite(Number(b.remaining_fraction))) continue;
            const window = b.window === '5h' ? '5h' : 'week';
            out.meters.push(meter(String(b.id || `${short}:${window}`), window, (1 - Number(b.remaining_fraction)) * 100, b.reset_time, {
                label: `${short} ${window === '5h' ? '5-hour' : 'week'}`, models: models.length ? models : [short]
            }));
        }
    }
    return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/**
 * The meters that govern a session running `model`: the account-wide ones,
 * and the scoped ones that name it ("Fable week" for claude-fable-5-2).
 * With no model known, every meter counts — the careful reading.
 */
function metersFor(usage, model) {
    const all = Array.isArray(usage?.meters) ? usage.meters : [];
    const m = norm(model);
    return all.filter((x) => {
        if (!x.model && !x.models) return true;
        if (!m) return true;
        if (x.model) return m.includes(norm(x.model)) || norm(x.model).includes(m);
        return x.models.some((name) => m.includes(norm(name)) || norm(name).includes(m));
    });
}

/**
 * Whether a session on this account, running `model`, is at a limit now.
 * { blocked, meter, until, headroom }: `until` is when the blocking window
 * resets (null = unknown); `headroom` the points left on the fullest
 * governing meter. A window whose reset has passed counts as empty.
 */
function blockedFor(usage, model, now = Date.now()) {
    if (!usage || usage.available === false) return { blocked: false, unknown: true, meter: null, until: null, headroom: null };
    let worst = null;
    for (const x of metersFor(usage, model)) {
        const live = x.resetsAt === null || x.resetsAt > now;
        const used = live ? x.percent : 0;
        if (!worst || used > worst.used) worst = { used, meter: x };
    }
    const used = worst ? worst.used : 0;
    if (used >= 100) return { blocked: true, meter: worst.meter, until: worst.meter.resetsAt, headroom: 0 };
    if (usage.reached || usage.ordinaryAllowed === false) return { blocked: true, meter: null, until: null, headroom: 0 };
    return { blocked: false, meter: worst ? worst.meter : null, until: null, headroom: Math.max(0, 100 - used) };
}

/**
 * Whether a session on this account, past its plan's limit, runs on paid
 * usage instead of stopping: Codex's credits, Claude's extra usage. (Its
 * next turn costs money while another account may have free room.)
 */
function onPaidUsage(usage, model, now = Date.now()) {
    if (!usage || !blockedFor(usage, model, now).blocked) return false;
    if (usage.credits) return usage.credits.has === true && usage.credits.unlimited !== true;
    if (usage.extra) return usage.extra.enabled === true && usage.extra.reached !== true;
    return false;
}

// ---- A session stopped at a limit -----------------------------------------
// Read from the END of its conversation file: the last thing said there is
// the agent's own limit notice, with nothing from anyone after it.

function linesFromEnd(tail) {
    const lines = String(tail || '').split('\n');
    const out = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line || line[0] !== '{') continue;
        try { out.push(JSON.parse(line)); } catch (e) { /* the tail's cut first line, or noise */ }
    }
    return out;
}

/** Claude Code's transcript tail → { at, text } when it ends on a usage-limit notice, else null. */
function claudeLimitStop(tail) {
    for (const rec of linesFromEnd(tail)) {
        if (!rec || rec.isSidechain === true) continue;
        if (rec.type !== 'assistant' && rec.type !== 'user') continue;
        if (rec.type === 'assistant' && rec.isApiErrorMessage === true && rec.error === 'rate_limit') {
            const text = (Array.isArray(rec.message?.content) ? rec.message.content : [])
                .map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ').trim();
            return { at: toMs(rec.timestamp) || 0, text: text.slice(0, 200) };
        }
        return null; // the last word was something else: a reply, or the person's own
    }
    return null;
}

/** Codex's rollout tail → { at, text } when its last turn ended on the usage limit, else null. */
function codexLimitStop(tail) {
    for (const rec of linesFromEnd(tail)) {
        if (!rec || rec.type !== 'event_msg' || !rec.payload) continue;
        const kind = rec.payload.type;
        if (kind === 'task_complete') {
            const err = rec.payload.error;
            if (err && err.codex_error_info === 'usage_limit_exceeded') return { at: toMs(rec.timestamp) || 0, text: String(err.message || '').slice(0, 200) };
            return null;
        }
        if (kind === 'task_started' || kind === 'user_message' || kind === 'turn_aborted') return null;
    }
    return null;
}

/**
 * Antigravity's screen → { text } when it shows agy's own quota notice near
 * the bottom ("RESOURCE_EXHAUSTED (code 429): Individual quota reached …
 * Resets in 2h18m34s."), else null. agy writes the notice to its log and
 * its screen only, not to the conversation, so the screen is where it is
 * read; the text, resets countdown and all, tells one stop from the next.
 */
function agyLimitStop(screenText) {
    const lines = String(screenText || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-30);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/Individual quota reached|RESOURCE_EXHAUSTED|quota (?:reached|exceeded|exhausted)/i.test(lines[i])) {
            return { text: lines[i].replace(/\s+/g, ' ').slice(0, 200) };
        }
    }
    return null;
}

// ---- What to do about it ---------------------------------------------------

const DEFAULT_RULES = {
    cooldownMs: 10 * 60_000,     // one action per session, then leave it be a while
    // Keep a session running as long as any account can (Jian, 2026-11-22):
    // these only stop a move or continue that keeps failing from looping.
    maxMovesPerDay: 12,
    maxResumesPerDay: 12,
    minHeadroom: 10,             // a target a few points from its own limit is no target
    maxUsageAgeMs: 10 * 60_000,  // act only on a reading this fresh
    // A reset empties the account for every session on it: the next stopped
    // session there must not spend another on a reading from before it.
    resetCooldownMs: 30 * 60_000,
    // A banked reset this close to expiring goes before free room elsewhere.
    resetExpiringMs: 2 * 86400_000
};

const fresh = (a, now, rules) => !!a && !!a.usage && Number.isFinite(a.usageAt) && now - a.usageAt <= rules.maxUsageAgeMs;
// Another folder signed in to the same login is the same limits.
const sameLogin = (a, b) => !!(a && b && a.dir !== b.dir && a.email && b.email && a.email === b.email);
const inRotation = (a) => !!a && a.pooled !== false && a.loggedIn === true;

/** Whether hop may spend one of this account's banked resets now. */
function canReset(a, now = Date.now(), rules = DEFAULT_RULES) {
    if (!inRotation(a) || !fresh(a, now, rules) || !(Number(a.usage.resets) > 0)) return false;
    return !(Number.isFinite(a.lastResetAt) && now - a.lastResetAt < rules.resetCooldownMs);
}
/** Its resets are to be used up first: marked so (a plan about to end), or one is about to expire. */
function spendResetsFirst(a, now = Date.now(), rules = DEFAULT_RULES) {
    if (a?.spendFirst === true) return true;
    const t = a?.usage?.resetsExpire?.[0];
    return Number.isFinite(t) && t - now < rules.resetExpiringMs;
}

/**
 * The account to move a stopped session to: in the rotation, logged in, not
 * the one it is on (nor the same login in another folder), read recently,
 * with room for the session's model — one marked to be used up first, then
 * the one with the most room. Null when none qualifies.
 */
function pickTarget({ current, accounts, model, now = Date.now(), rules = DEFAULT_RULES }) {
    let best = null;
    for (const a of accounts || []) {
        if (!a || a.dir === current?.dir || !inRotation(a) || sameLogin(a, current)) continue;
        if (!fresh(a, now, rules)) continue;
        const b = blockedFor(a.usage, model, now);
        if (b.unknown || b.blocked || b.headroom < rules.minHeadroom) continue;
        const first = a.spendFirst === true;
        if (!best || first > best.first || (first === best.first && b.headroom > best.headroom)) best = { account: a, headroom: b.headroom, first };
    }
    return best;
}

/**
 * A session's account is past its limit: what gets it running on the plans'
 * own usage again, or null. In order —
 *   its own account's banked reset, when that account's resets go first;
 *   room on an account to be used up first;
 *   a reset on such an account, and a move there;
 *   room on any account;
 *   its own account's reset;
 *   a reset on any account, and a move there.
 * Free room elsewhere renews every week and is lost unused; a banked reset
 * keeps, unless its plan is ending (spendFirst) or it is about to expire.
 */
function planPastLimit({ own, accounts, model, now = Date.now(), rules = DEFAULT_RULES }) {
    const resetHere = canReset(own, now, rules);
    if (resetHere && spendResetsFirst(own, now, rules)) return { action: 'reset', target: own, move: false, reason: `spent one of its ${own.usage.resets} banked resets` };
    const pick = pickTarget({ current: own, accounts, model, now, rules });
    if (pick && pick.first) return { action: 'move', target: pick.account, reason: `${Math.round(pick.headroom)}% left there` };
    // Accounts at their own limit with a reset to spend, best first.
    const there = (accounts || [])
        .filter((a) => a && a.dir !== own.dir && !sameLogin(a, own) && canReset(a, now, rules) && blockedFor(a.usage, model, now).blocked)
        .sort((a, b) => (spendResetsFirst(b, now, rules) - spendResetsFirst(a, now, rules))
            || ((a.usage.resetsExpire?.[0] || Infinity) - (b.usage.resetsExpire?.[0] || Infinity))
            || (Number(b.usage.resets) - Number(a.usage.resets)));
    const viaReset = (a) => ({ action: 'reset', target: a, move: true, reason: `spent one of its ${a.usage.resets} banked resets` });
    if (there.length && spendResetsFirst(there[0], now, rules)) return viaReset(there[0]);
    if (pick) return { action: 'move', target: pick.account, reason: `${Math.round(pick.headroom)}% left there` };
    if (resetHere) return { action: 'reset', target: own, move: false, reason: `spent one of its ${own.usage.resets} banked resets` };
    if (there.length) return viaReset(there[0]);
    return null;
}

/**
 * One stopped session, decided: { action, target?, move?, reason, until? }.
 *   'resume'  its own account has room again — tell it to continue
 *   'move'    another account has room — move it there, then continue
 *   'reset'   spend a banked reset on `target` (moving there when `move`),
 *             then continue
 *   'wait'    nothing has room (or it has been moved enough today)
 *   'none'    not now: acted on moments ago, or its account could not be read
 * `history` is this session's earlier actions: [{ at, kind: 'move'|'resume'|'reset' }].
 * Accounts may carry `spendFirst` (use up its usage and resets before the
 * others') and `lastResetAt` (hop's last reset there).
 */
function planForStop({ stop, session, accounts, history = [], now = Date.now(), rules = DEFAULT_RULES }) {
    const recent = history.filter((h) => h && now - h.at < 24 * 3600_000);
    const last = recent.reduce((m, h) => Math.max(m, h.at), 0);
    if (last && now - last < rules.cooldownMs) return { action: 'none', reason: 'acted on moments ago' };
    const own = (accounts || []).find((a) => a.dir === session.homeDir) || null;
    if (!own || !own.usage || !Number.isFinite(own.usageAt)) return { action: 'none', reason: "its account's usage could not be read" };
    // Only a reading taken after the stop says anything about it.
    if (own.usageAt < stop.at || now - own.usageAt > rules.maxUsageAgeMs) return { action: 'none', reason: "its account's usage is not read yet" };
    const mine = blockedFor(own.usage, session.model, now);
    if (mine.unknown) return { action: 'none', reason: "its account reports no limits" };
    if (!mine.blocked) {
        if (recent.filter((h) => h.kind === 'resume').length >= rules.maxResumesPerDay) return { action: 'wait', reason: 'continued often enough today', until: null };
        return { action: 'resume', reason: 'its account has room again' };
    }
    if (recent.filter((h) => h.kind === 'move').length >= rules.maxMovesPerDay) {
        // Moved enough today; a reset on its own account needs no move.
        const plan = canReset(own, now, rules) ? { action: 'reset', target: own, move: false, reason: `spent one of its ${own.usage.resets} banked resets` } : null;
        return plan || { action: 'wait', reason: 'moved often enough today', until: mine.until };
    }
    const plan = planPastLimit({ own, accounts, model: session.model, now, rules });
    if (plan) return plan;
    // When the first of them has room again.
    let until = mine.until;
    for (const a of accounts || []) {
        if (a.dir === own.dir || !inRotation(a) || !a.usage) continue;
        const b = blockedFor(a.usage, session.model, now);
        if (b.blocked && b.until && (!until || b.until < until)) until = b.until;
    }
    return { action: 'wait', reason: 'no account in the rotation has room', until: until || null };
}

/**
 * A session sitting idle on an account past its limit that carries on with
 * paid usage (Codex credits, Claude extra usage): its next turn would cost
 * money while a plan's own usage may be free elsewhere. { action: 'move' |
 * 'reset' | 'none', target?, move?, reason } — nothing is typed afterwards:
 * it was not stopped.
 */
function planForPaid({ session, accounts, history = [], now = Date.now(), rules = DEFAULT_RULES }) {
    const recent = history.filter((h) => h && now - h.at < 24 * 3600_000);
    const last = recent.reduce((m, h) => Math.max(m, h.at), 0);
    if (last && now - last < rules.cooldownMs) return { action: 'none', reason: 'acted on moments ago' };
    const own = (accounts || []).find((a) => a.dir === session.homeDir) || null;
    if (!own || !fresh(own, now, rules)) return { action: 'none', reason: "its account's usage is not read yet" };
    if (!onPaidUsage(own.usage, session.model, now)) return { action: 'none', reason: 'not on paid usage' };
    const plan = planPastLimit({ own, accounts, model: session.model, now, rules });
    if (!plan) return { action: 'none', reason: 'no account has free room' };
    if (plan.action === 'move' || plan.move) {
        if (recent.filter((h) => h.kind === 'move').length >= rules.maxMovesPerDay) return { action: 'none', reason: 'moved often enough today' };
    }
    return plan;
}

module.exports = {
    toMs, parseClaudeUsage, parseCodexUsage, parseAgyQuota, metersFor, blockedFor,
    claudeLimitStop, codexLimitStop, agyLimitStop, onPaidUsage, canReset, spendResetsFirst,
    pickTarget, planPastLimit, planForStop, planForPaid, DEFAULT_RULES
};
