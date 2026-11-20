'use strict';
// Codex sessions whose helper servers pile up are restarted while idle. The
// detector must flag only a real pile-up (a healthy Codex runs one or two of
// each helper), and the sweep must restart only an idle, unwatched session
// with an empty input box: one per sweep, never twice in a row.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('../lib/codex-helpers');

const CODEX = '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
const launch = (session) => `${CODEX} --no-daemon -c shell_environment_policy.set.HOP_SESSION="${session}" -c mcp_servers.hop.env.HOP_SESSION="${session}" resume abc`;
const REPL = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl';
const healthyHelpers = [REPL, REPL, '/opt/homebrew/bin/node /x/hop2/mcp/hop-mcp.js', 'npm exec nebula-notebook-mcp',
    '/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node ./dist/server.mjs',
    '/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node ./dist/server.mjs',
    '/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node ./launch.mjs',
    `${CODEX}-code-mode-host`];
function ps(trees) {
    let pid = 1000;
    const lines = [];
    for (const { command, children } of trees) {
        const parent = pid++;
        lines.push(`${parent} 1 ${command}`);
        for (const c of children) lines.push(`${pid++} ${parent} ${c}`);
    }
    return lines.join('\n') + '\n';
}

test('a healthy Codex is left alone; a pile-up is found and named', () => {
    const text = ps([
        { command: launch('s_healthy'), children: healthyHelpers },
        { command: launch('s_piled'), children: [...healthyHelpers, ...Array(14).fill(REPL)] },
        // The agent's own commands repeating are not helpers.
        { command: launch('s_polling'), children: [...healthyHelpers, ...Array(9).fill('/bin/zsh -lc sleep 60')] },
        // A Codex hop did not launch has no session to restart.
        { command: `${CODEX} app-server`, children: Array(20).fill(REPL) }
    ]);
    const found = h.findPileUps(text);
    assert.deepEqual(found.map((x) => [x.session, x.worst.label, x.worst.copies]), [['s_piled', 'node_repl', 16]]);
    assert.equal(found[0].helpers, healthyHelpers.length + 14);
});

test('helper names read well in the log', () => {
    assert.equal(h.helperLabel('/x/venvs/0.2.10/bin/python -m ngs_workbench_mcp'), 'ngs_workbench_mcp');
    assert.equal(h.helperLabel('/x/codex-primary-runtime/dependencies/node/bin/node ./dist/server.mjs'), 'computer-use server.mjs');
    assert.equal(h.helperLabel(REPL), 'node_repl');
    assert.equal(h.sessionOf(launch('Accessibility-fork-codex')), 'Accessibility-fork-codex');
    assert.equal(h.sessionOf(`${CODEX} resume x`), null);
    assert.equal(h.isCodex(`${CODEX}-code-mode-host`), false);
});

test('only an idle, unwatched session with an empty box may be restarted, and not too often', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const idle = { session: 's_1', phase: 'idle', lastActivityAt: now - 3600_000, userAttached: false, lastUserSeenAt: now - 3600_000, draft: false };
    assert.deepEqual(h.mayRestart(idle, [], now), { ok: true });
    assert.equal(h.mayRestart({ ...idle, phase: 'working' }, [], now).why, 'working');
    assert.equal(h.mayRestart({ ...idle, userAttached: true }, [], now).why, 'open on screen');
    assert.equal(h.mayRestart({ ...idle, lastActivityAt: now - 60_000 }, [], now).why, 'active recently');
    assert.equal(h.mayRestart({ ...idle, lastUserSeenAt: now - 60_000 }, [], now).why, 'seen recently');
    assert.equal(h.mayRestart({ ...idle, draft: true }, [], now).why, 'text in its input box');
    assert.equal(h.mayRestart(idle, [{ at: now - 3600_000, session: 's_1' }], now).why, 'restarted recently');
    assert.deepEqual(h.mayRestart(idle, [{ at: now - 7 * 3600_000, session: 's_1' }], now), { ok: true });
    const busyDay = Array.from({ length: 8 }, (_, i) => ({ at: now - i * 60_000, session: `s_other${i}` }));
    assert.equal(h.mayRestart(idle, busyDay, now).why, 'daily limit');
});

// ---- the daemon's sweep -------------------------------------------------------

const SRC = fs.readFileSync(path.join(__dirname, '..', 'hop'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(SRC);
    assert.ok(m, `hop defines ${name}`);
    let depth = 0;
    for (let i = SRC.indexOf('{', SRC.indexOf(')', m.index)); i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}' && --depth === 0) return SRC.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

function sweepEnv({ text, entries, phase = 'idle', box = { working: false, state: { found: true, isEmpty: true } }, busy = false, seen = {}, history = [], env = {} }) {
    const calls = { restores: [], records: [], logs: [] };
    const restarts = [...history];
    const sandbox = {
        codexHelpers: h, Date, Promise, Map, Number, process: { env },
        log: (m) => calls.logs.push(m), DIM: '', CYAN: '', YELLOW: '',
        psSnapshot: async () => text,
        listAllSessionEntriesRuntimeFirst: async () => ({ runtimeAvailable: true, entries }),
        agentPhaseFieldsForAll: async (list) => new Map(list.map((e) => [e.internalName, { agentPhase: phase }])),
        getSessionDisplayName: (n) => n,
        getSessionSeenInfo: (n) => seen[n] || { userAttached: false, lastUserSeenAt: Date.now() - 3600_000 },
        readRoomComposer: async () => box,
        loadCodexRestarts: () => restarts,
        recordCodexRestart: (r) => { restarts.push(r); calls.records.push(r); },
        restoreSavedSessions: async (opts) => {
            calls.restores.push(opts);
            if (opts.dryRun) return { skipped: busy ? [{ name: 'x', reason: 'busy — mid-turn' }] : [] };
            return { restored: opts.only };
        }
    };
    const code = `let shuttingDown = false; const CODEX_HELPER_SWEEP_STUCK_MS = 900000;
        let codexHelperSweepBusy = false, codexHelperSweepStartedAt = 0; const codexHelperWaitLogged = new Map();
        ${fnSource('runCodexHelperSweep')}; runCodexHelperSweep`;
    return { sweep: vm.runInNewContext(code, sandbox), calls };
}
const live = (name) => ({ internalName: name, live: true, agent: 'codex', lastActivityAt: Date.now() - 3600_000 });
const piledPs = ps([
    { command: launch('s_a'), children: [...healthyHelpers, ...Array(10).fill(REPL)] },
    { command: launch('s_b'), children: [...healthyHelpers, ...Array(20).fill(REPL)] }
]);

test('the sweep restarts the worst idle pile-up, one per sweep, with a dry run first', async () => {
    const env = sweepEnv({ text: piledPs, entries: [live('s_a'), live('s_b')] });
    await env.sweep();
    const real = env.calls.restores.filter((r) => !r.dryRun);
    assert.equal(real.length, 1);
    assert.deepEqual(Array.from(real[0].only), ['s_b']);
    assert.equal(real[0].replaceIdleAgent, true);
    assert.equal(env.calls.restores[0].dryRun, true, 'it checks first');
    assert.equal(env.calls.records[0].copies, 22);
    // The next sweep takes the other; the first is on its cooldown.
    await env.sweep();
    assert.deepEqual(env.calls.restores.filter((r) => !r.dryRun).map((r) => Array.from(r.only)[0]), ['s_b', 's_a']);
});

test('nothing is restarted while working, watched, typed into, busy, or switched off', async () => {
    const cases = [
        { phase: 'working' },
        { seen: { s_b: { userAttached: true, lastUserSeenAt: Date.now() }, s_a: { userAttached: true, lastUserSeenAt: Date.now() } } },
        { box: { working: false, state: { found: true, isEmpty: false } } },
        { box: null },
        { busy: true },
        { env: { HOP_CODEX_RESTART: '0' } }
    ];
    for (const extra of cases) {
        const env = sweepEnv({ text: piledPs, entries: [live('s_a'), live('s_b')], ...extra });
        await env.sweep();
        assert.equal(env.calls.restores.filter((r) => !r.dryRun).length, 0, JSON.stringify(extra));
        assert.equal(env.calls.records.length, 0);
    }
});

test('a healthy fleet costs one process listing and nothing else', async () => {
    const env = sweepEnv({ text: ps([{ command: launch('s_a'), children: healthyHelpers }]), entries: [live('s_a')] });
    await env.sweep();
    assert.equal(env.calls.restores.length, 0);
    assert.equal(env.calls.logs.length, 0);
});
