'use strict';
// Each agent's own usage reply becomes one shape; a session that stopped at
// a limit is recognised from the end of its conversation; and the rotation
// decides, per stopped session, to continue it, move it, or wait.
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../lib/agent-usage');

const NOW = Date.parse('2026-11-18T12:00:00Z');
const LATER = '2026-11-20T00:00:00Z';

// A `get_usage` reply as Claude Code 2.1.325 sends it (trimmed).
const claudeReply = (rows, extra = {}) => ({
  subscription_type: 'max', rate_limits_available: true,
  rate_limits: { five_hour: null, limits: rows, extra_usage: { is_enabled: false }, ...extra }
});
const row = (kind, percent, model) => ({
  kind, group: kind === 'session' ? 'session' : 'weekly', percent, resets_at: LATER, severity: 'normal', is_active: false,
  scope: model ? { model: { id: null, display_name: model }, surface: null } : null
});

test('Claude: the server rows become meters; no 5-hour row means an unopened window', () => {
  const usage = u.parseClaudeUsage(claudeReply([row('weekly_all', 76), row('weekly_scoped', 100, 'Fable')]));
  assert.equal(usage.plan, 'max');
  assert.deepEqual(usage.meters.map((m) => [m.id, m.label, m.window, m.percent, m.model]), [
    ['session', '5-hour', '5h', 0, null],
    ['week', 'Week', 'week', 76, null],
    ['week:Fable', 'Fable week', 'week', 100, 'Fable']
  ]);
  assert.equal(usage.meters[0].idle, true);
  assert.equal(usage.meters[1].resetsAt, Date.parse(LATER));
});

test('Claude: an account with no plan limits reports none', () => {
  const usage = u.parseClaudeUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null });
  assert.equal(usage.available, false);
  assert.deepEqual(usage.meters, []);
  assert.equal(u.blockedFor(usage, 'claude-opus-5-5', NOW).unknown, true);
});

test('Claude: an older server without rows is read from its named windows', () => {
  const usage = u.parseClaudeUsage({ subscription_type: 'pro', rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 40, resets_at: LATER }, seven_day: { utilization: 12, resets_at: LATER }, seven_day_opus: { utilization: 90, resets_at: LATER }
  } });
  assert.deepEqual(usage.meters.map((m) => [m.id, m.percent]), [['session', 40], ['week', 12], ['week:Opus', 90]]);
});

test('Codex: windows are named by their length; a model quota is scoped to it', () => {
  const usage = u.parseCodexUsage(
    { account: { type: 'chatgpt', email: 'someone@example.org', planType: 'pro' } },
    { rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1795303820 }, secondary: { usedPercent: 14, windowDurationMins: 10080, resetsAt: 1795303820 }, rateLimitReachedType: null },
      astra: { limitId: 'astra', limitName: 'Astra', normalModelSlug: 'gpt-6-astra', primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1795303820 } }
    }, rateLimitResetCredits: { availableCount: 2 } }
  );
  assert.equal(usage.plan, 'pro');
  assert.equal(usage.email, 'someone@example.org');
  assert.equal(usage.resets, 2);
  assert.deepEqual(usage.meters.map((m) => [m.label, m.window, m.percent, m.model]), [
    ['5-hour', '5h', 30, null], ['Week', 'week', 14, null], ['Astra week', 'week', 100, 'gpt-6-astra']
  ]);
  assert.equal(usage.meters[0].resetsAt, 1795303820000);
  assert.equal(u.blockedFor(usage, 'gpt-6-astra', NOW).blocked, true);
  assert.equal(u.blockedFor(usage, 'gpt-6-luna', NOW).blocked, false);
});

test('Codex: the server saying the limit is reached blocks, whatever the percent', () => {
  const usage = u.parseCodexUsage(null, { rateLimits: { limitId: 'codex', primary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: 1795303820 }, rateLimitReachedType: 'rate_limit_reached' } });
  assert.equal(u.blockedFor(usage, null, NOW).blocked, true);
});

test('Antigravity: what is left becomes what is used, per model group', () => {
  const usage = u.parseAgyQuota({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon', buckets: [
      { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.976, reset_time: LATER },
      { id: 'gemini-5h', window: '5h', remaining_fraction: 0, reset_time: LATER }] },
    { name: 'Claude and GPT models', description: 'Models within this group: Claude Opus 5.5, GPT-OSS 120B', buckets: [
      { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: LATER }] }
  ] } } });
  assert.deepEqual(usage.meters.map((m) => [m.label, m.percent]), [['Gemini week', 2.4], ['Gemini 5-hour', 100], ['Claude and GPT week', 0]]);
  assert.equal(u.blockedFor(usage, 'Gemini 4 Carbon', NOW).blocked, true);
  assert.equal(u.blockedFor(usage, 'Claude Opus 5.5', NOW).blocked, false);
  assert.equal(u.parseAgyQuota({ status: 'ERROR' }), null);
});

test('a scoped limit blocks only the model it names; an unknown model counts every meter', () => {
  const usage = u.parseClaudeUsage(claudeReply([row('weekly_all', 76), row('weekly_scoped', 100, 'Fable')]));
  assert.equal(u.blockedFor(usage, 'claude-fable-5-2[1m]', NOW).blocked, true);
  assert.equal(u.blockedFor(usage, 'claude-fable-5-2[1m]', NOW).until, Date.parse(LATER));
  const opus = u.blockedFor(usage, 'claude-opus-5-5', NOW);
  assert.equal(opus.blocked, false);
  assert.equal(opus.headroom, 24);
  assert.equal(u.blockedFor(usage, null, NOW).blocked, true);
});

test('a window whose reset has passed counts as empty', () => {
  const usage = u.parseClaudeUsage(claudeReply([row('session', 100), row('weekly_all', 20)]));
  assert.equal(u.blockedFor(usage, 'claude-opus-5-5', NOW).blocked, true);
  assert.equal(u.blockedFor(usage, 'claude-opus-5-5', Date.parse(LATER) + 1000).blocked, false);
});

// ---- stopped at a limit ----------------------------------------------------

const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const limitNotice = (text = "You've hit your 5-hour limit · resets 3pm (America/Chicago)") => ({
  type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', timestamp: '2026-11-18T11:00:00Z',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }
});

test('Claude: a conversation that ends on the limit notice is stopped', () => {
  const stop = u.claudeLimitStop(jsonl({ type: 'user', message: { content: 'go on' } }, limitNotice(), { type: 'system', subtype: 'turn_duration' }));
  assert.equal(stop.at, Date.parse('2026-11-18T11:00:00Z'));
  assert.match(stop.text, /5-hour limit/);
  // The tail of a file starts mid-line: that line is skipped, not fatal.
  assert.ok(u.claudeLimitStop('th": 3}\n' + jsonl(limitNotice("You've hit your Fable limit · resets Nov 22 at 4pm"))));
});

test('Claude: anything said after the notice means someone has it in hand', () => {
  assert.equal(u.claudeLimitStop(jsonl(limitNotice(), { type: 'user', message: { content: '<command-name>/login</command-name>' } })), null);
  assert.equal(u.claudeLimitStop(jsonl(limitNotice(), { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } })), null);
  // A subagent's records do not speak for the conversation.
  assert.ok(u.claudeLimitStop(jsonl(limitNotice(), { type: 'assistant', isSidechain: true, message: { content: [] } })));
  // Another API error is not a usage limit.
  assert.equal(u.claudeLimitStop(jsonl({ ...limitNotice('API Error: Overloaded'), error: 'overloaded' })), null);
  assert.equal(u.claudeLimitStop(''), null);
});

test('Codex: a last turn that ended on the usage limit is stopped', () => {
  const done = (error) => ({ timestamp: '2026-11-18T11:00:00Z', type: 'event_msg', payload: { type: 'task_complete', error } });
  const limit = { message: 'You’ve hit your usage limit. Visit … or try again at Nov 20th, 2026 6:42 PM.', codex_error_info: 'usage_limit_exceeded' };
  assert.match(u.codexLimitStop(jsonl({ type: 'event_msg', payload: { type: 'task_started' } }, done(limit), { type: 'response_item', payload: {} })).text, /usage limit/);
  assert.equal(u.codexLimitStop(jsonl(done(limit), { type: 'event_msg', payload: { type: 'task_started' } })), null);
  assert.equal(u.codexLimitStop(jsonl(done(limit), { type: 'event_msg', payload: { type: 'user_message' } })), null);
  assert.equal(u.codexLimitStop(jsonl(done(null))), null);
  assert.equal(u.codexLimitStop(jsonl(done({ message: 'stream disconnected', codex_error_info: 'other' }))), null);
});

// ---- the decision ----------------------------------------------------------

const account = (dir, rows, more = {}) => ({
  dir, loggedIn: true, email: `${dir}@example.org`, pooled: true,
  usage: u.parseClaudeUsage(claudeReply(rows)), usageAt: NOW - 60_000, ...more
});
const STOP = { at: NOW - 5 * 60_000, text: 'limit' };
const fable = { model: 'claude-fable-5-2', homeDir: 'a' };

test('a stopped session moves to the account with the most room for its model', () => {
  const plan = u.planForStop({ stop: STOP, session: fable, now: NOW, accounts: [
    account('a', [row('weekly_all', 76), row('weekly_scoped', 100, 'Fable')]),
    account('b', [row('weekly_all', 60), row('weekly_scoped', 70, 'Fable')]),
    account('c', [row('weekly_all', 10), row('weekly_scoped', 40, 'Fable')])
  ] });
  assert.equal(plan.action, 'move');
  assert.equal(plan.target.dir, 'c');
});

test('accounts that cannot take it are passed over', () => {
  const full = [row('session', 100), row('weekly_all', 50)];
  const room = [row('weekly_all', 10)];
  const plan = (others) => u.planForStop({ stop: STOP, session: { model: 'claude-opus-5-5', homeDir: 'a' }, now: NOW, accounts: [account('a', full), ...others] });
  assert.equal(plan([account('b', room, { pooled: false })]).action, 'wait', 'taken out of the rotation');
  assert.equal(plan([account('b', room, { loggedIn: false })]).action, 'wait', 'logged out');
  assert.equal(plan([account('b', room, { email: 'a@example.org' })]).action, 'wait', 'the same login in another folder');
  assert.equal(plan([account('b', room, { usageAt: NOW - 3600_000 })]).action, 'wait', 'a stale reading');
  assert.equal(plan([account('b', [row('weekly_all', 95)])]).action, 'wait', 'a few points from its own limit');
  assert.equal(plan([account('b', room)]).action, 'move');
});

test('with no room anywhere it waits for the first reset', () => {
  const soon = '2026-11-18T15:00:00Z';
  const a = account('a', [row('session', 100)]);
  const b = account('b', [{ ...row('session', 100), resets_at: soon }]);
  const plan = u.planForStop({ stop: STOP, session: { model: 'claude-opus-5-5', homeDir: 'a' }, now: NOW, accounts: [a, b] });
  assert.equal(plan.action, 'wait');
  assert.equal(plan.until, Date.parse(soon));
});

test('when its own account has room again it continues where it is', () => {
  const a = account('a', [row('weekly_all', 30)]);
  assert.equal(u.planForStop({ stop: STOP, session: fable, now: NOW, accounts: [a, account('b', [row('weekly_all', 1)])] }).action, 'resume');
});

test('nothing is decided on a reading older than the stop, or one that failed', () => {
  const stale = account('a', [row('weekly_all', 30)], { usageAt: STOP.at - 1000 });
  assert.equal(u.planForStop({ stop: STOP, session: fable, now: NOW, accounts: [stale] }).action, 'none');
  assert.equal(u.planForStop({ stop: STOP, session: fable, now: NOW, accounts: [{ dir: 'a', loggedIn: true, usage: null }] }).action, 'none');
  assert.equal(u.planForStop({ stop: STOP, session: fable, now: NOW, accounts: [] }).action, 'none');
});

test('a session is left alone after an action, and not passed around all day', () => {
  const accounts = [account('a', [row('session', 100)]), account('b', [row('weekly_all', 5)])];
  const session = { model: 'claude-opus-5-5', homeDir: 'a' };
  const at = (minutesAgo, kind) => ({ at: NOW - minutesAgo * 60_000, kind });
  assert.equal(u.planForStop({ stop: STOP, session, now: NOW, accounts, history: [at(3, 'move')] }).action, 'none');
  assert.equal(u.planForStop({ stop: STOP, session, now: NOW, accounts, history: [at(30, 'move')] }).action, 'move');
  // Kept running as long as any account can: a few moves a day are fine…
  const four = [at(30, 'move'), at(90, 'move'), at(200, 'move'), at(400, 'move')];
  assert.equal(u.planForStop({ stop: STOP, session, now: NOW, accounts, history: four }).action, 'move');
  // …only a move that keeps failing to help is stopped from looping all day.
  const twelve = Array.from({ length: 12 }, (_, i) => at(30 + i * 60, 'move'));
  assert.equal(u.planForStop({ stop: STOP, session, now: NOW, accounts, history: twelve }).action, 'wait');
  // Yesterday's moves no longer count.
  assert.equal(u.planForStop({ stop: STOP, session, now: NOW, accounts, history: twelve.map((h) => ({ ...h, at: h.at - 25 * 3600_000 })) }).action, 'move');
  const roomy = [account('a', [row('weekly_all', 5)])];
  const six = [20, 60, 100, 140, 180, 220].map((m) => at(m, 'resume'));
  assert.equal(u.planForStop({ stop: STOP, session, now: NOW, accounts: roomy, history: six }).action, 'resume');
  const manyResumes = Array.from({ length: 12 }, (_, i) => at(20 + i * 40, 'resume'));
  assert.equal(u.planForStop({ stop: STOP, session, now: NOW, accounts: roomy, history: manyResumes }).action, 'wait');
});
