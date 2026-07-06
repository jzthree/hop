// Shared configuration for the capture rig (demo/capture/*). Every
// machine-specific value lives here as an env override with a macOS default,
// so the individual scripts stay free of hardcoded paths and identities.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareSanitizedWorkspace } from "../hop-demo-lib.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const REPO_ROOT = path.resolve(HERE, "../..");

export const CHROME =
  process.env.HOP_CAPTURE_CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const FFMPEG = process.env.HOP_CAPTURE_FFMPEG || "/opt/homebrew/bin/ffmpeg";

// Root of the sanitized demo tree: workspace/ (session cwd), tools/ (ticker
// scripts), home/ (fake $HOME for the sanitized shells), video/ (raw
// Playwright recordings before trim), terminals.json (session registry).
export const DEMO_ROOT = process.env.HOP_CAPTURE_ROOT || "/tmp/hop-demo";
export const WORKSPACE = path.join(DEMO_ROOT, "workspace");
export const TOOLS_DIR = path.join(DEMO_ROOT, "tools");
export const DEMO_HOME = path.join(DEMO_ROOT, "home");
export const VID_TMP = path.join(DEMO_ROOT, "video");
export const TERMINALS_PATH = path.join(DEMO_ROOT, "terminals.json");

// Where finished clips land.
export const OUT =
  process.env.HOP_CAPTURE_OUT || path.join(REPO_ROOT, "demo-output", "footage", "live");

// Command launched inside Aurora2 by spawn-aurora.mjs.
export const AGENT_CMD = process.env.HOP_CAPTURE_AGENT || "claude";

// Demo cast, by INTERNAL session name. The capture driver's DOM rewriter
// shows the display names (Aurora/Lyra/Nebula/Polaris); Vega appears via the
// 01-sessions rename clip.
export const ALLOWED = ["Aurora2", "Lyra2", "Nebula2", "Polaris2", "Vega"];

// Strings that must NEVER be visible in a kept frame (identity leaks). The
// defaults cover the account-email welcome banner plus the real home
// directory and username; add more with HOP_CAPTURE_FORBIDDEN="a,b,c".
export const SCREEN_FORBIDDEN = [
  "Welcome back",
  os.homedir(),
  os.userInfo().username,
  ...(process.env.HOP_CAPTURE_FORBIDDEN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
];

// Deterministic clean shell for demo sessions: env -i wipes the real
// environment, --norc/--noprofile skip dotfiles, PS1 is the demo prompt.
export const sanitizedShell = (prompt = "demo@hop workspace $ ") =>
  `exec env -i HOME=${DEMO_HOME} USER=demo LOGNAME=demo TERM=xterm-256color ` +
  "LANG=en_US.UTF-8 PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin " +
  `PS1='${prompt}' /bin/bash --norc --noprofile`;

// Wipe screen AND scrollback (removes the real zsh prompt from history).
export const WIPE = "printf '\\033[2J\\033[3J\\033[H'";

export function loadTerminals({ required = true } = {}) {
  if (!fs.existsSync(TERMINALS_PATH)) {
    if (!required) return {};
    throw new Error(
      `${TERMINALS_PATH} not found — run setup-sessions.mjs (and spawn-aurora.mjs) first`
    );
  }
  return JSON.parse(fs.readFileSync(TERMINALS_PATH, "utf8"));
}

export function saveTerminals(map) {
  fs.mkdirSync(DEMO_ROOT, { recursive: true });
  fs.writeFileSync(TERMINALS_PATH, JSON.stringify(map, null, 2));
}

// Seed the sanitized demo tree: the workspace files the agent tours, the
// ticker scripts the shell sessions run, the fake HOME, and the `hop math`
// wrapper used by clip 06. Idempotent; never overwrites existing workspace
// content except the rig-owned tools and wrapper.
export function seedDemoTree() {
  fs.mkdirSync(DEMO_HOME, { recursive: true });
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  prepareSanitizedWorkspace(WORKSPACE, { reset: false });
  for (const f of fs.readdirSync(path.join(HERE, "tools"))) {
    fs.copyFileSync(path.join(HERE, "tools", f), path.join(TOOLS_DIR, f));
  }
  const wsScripts = path.join(WORKSPACE, "scripts");
  fs.mkdirSync(wsScripts, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "hop-math.js"),
    path.join(wsScripts, "hop-math.js")
  );
  const hopWrapper = path.join(WORKSPACE, "hop");
  fs.writeFileSync(
    hopWrapper,
    `#!/usr/bin/env node
// hop (demo workspace copy) — \`hop math\` entry point.
if (process.argv[2] === 'math') {
  const { runMathCli } = require('./scripts/hop-math.js');
  process.exit(runMathCli(process.argv.slice(3)));
}
console.error('hop (demo): only \`hop math\` is available in this workspace');
process.exit(1);
`
  );
  fs.chmodSync(hopWrapper, 0o755);
}
