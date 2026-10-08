'use strict';
// Which ACCOUNT an agent session runs as.
//
// Claude Code keeps one login per config root (CLAUDE_CONFIG_DIR: its
// credentials, settings and transcripts all live under it), Codex one per
// CODEX_HOME. Two logins on one machine are therefore two roots —
// ~/.claude and ~/.claude_fable, say — and which one a session started
// under decides whose quota it spends and whose transcript store it writes.
// Nothing on the wall said which. These helpers name the roots, label them
// for a chip, and move a conversation between them.

const path = require('path');

const DEFAULT_BASENAME = { claude: '.claude', codex: '.codex' };
const ENV_VAR = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

const defaultHome = (agent, homeDir) => path.join(homeDir, DEFAULT_BASENAME[agent] || `.${agent}`);

/** "default" for the agent's own root, else the part after `.claude_` / `.codex-`, else the basename. */
function agentHomeLabel(dir, agent, homeDir) {
    if (!dir || dir === defaultHome(agent, homeDir)) return 'default';
    const base = path.basename(dir);
    const m = new RegExp(`^\\.?${agent}[_-](.+)$`).exec(base);
    return m ? m[1] : base.replace(/^\./, '');
}

/** { dir, label, isDefault } for a root (null/undefined = the default root). */
function describeAgentHome(dir, agent, homeDir) {
    const resolved = dir || defaultHome(agent, homeDir);
    return { dir: resolved, label: agentHomeLabel(resolved, agent, homeDir), isDefault: resolved === defaultHome(agent, homeDir) };
}

// A root is an ACCOUNT only when it holds a login's footprint — not every
// `.claude-something` directory does (`.claude-science` held one settings
// file; `.codexbar` is another app altogether).
const ACCOUNT_MARKERS = {
    claude: ['.claude.json', 'projects'],
    codex: ['auth.json', 'config.toml', 'sessions']
};

/**
 * Every account root on this machine for one agent: the default first, then
 * sibling installs (`.claude_x`, `.claude-y`, `.claude2`), then whatever the
 * environment points at. `entries` is the home directory's listing;
 * `exists(path)` checks a path. The default root is always listed when it
 * exists at all — its login may live outside it (~/.claude.json).
 */
function discoverAgentHomes(agent, { homeDir, entries, exists, envDir }) {
    const out = [];
    const markers = ACCOUNT_MARKERS[agent] || [];
    const push = (dir, needMarker) => {
        if (!dir || out.some((h) => h.dir === dir)) return;
        if (!exists(dir)) return;
        if (needMarker && !markers.some((m) => exists(path.join(dir, m)))) return;
        out.push(describeAgentHome(dir, agent, homeDir));
    };
    push(defaultHome(agent, homeDir), false);
    const re = new RegExp(`^\\.${agent}[_-]?[A-Za-z0-9][A-Za-z0-9_-]*$`);
    for (const e of [...(entries || [])].sort()) if (re.test(e)) push(path.join(homeDir, e), true);
    push(envDir, true);
    return out;
}

/** The environment that pins a launch to a root. */
const envForAgentHome = (agent, dir) => ({ [ENV_VAR[agent]]: dir });

/**
 * A recorded launch command without its config-root pin — `CLAUDE_CONFIG_DIR=… `,
 * `env -u CLAUDE_CONFIG_DIR `, or a wrapper launcher (`claude-fable`) that
 * pins one itself — so restore re-pins it from the record's configDir.
 */
function stripConfigPrefix(launchCmd) {
    let s = String(launchCmd || '').trim();
    s = s.replace(/^(?:env\s+-u\s+CLAUDE_CONFIG_DIR\s+|CLAUDE_CONFIG_DIR=(?:'[^']*'|"[^"]*"|\S+)\s+)+/, '');
    s = s.replace(/^(?:\S*\/)?claude[_-][A-Za-z0-9_-]+(?=\s|$)/, 'claude');
    return s;
}

/** Where a transcript/rollout lands when its root changes: the same relative path under the new root. */
function transcriptTarget(sourceFile, sourceRoot, targetRoot) {
    const rel = path.relative(sourceRoot, sourceFile);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return path.join(targetRoot, rel);
}

module.exports = { agentHomeLabel, describeAgentHome, discoverAgentHomes, envForAgentHome, stripConfigPrefix, transcriptTarget, defaultHome, ENV_VAR };
