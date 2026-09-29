#!/usr/bin/env node
// Codex `notify` handler for hop — the Codex-side twin of the Claude Stop hook
// (scripts/claude-session-hook.js), giving Codex sessions the same
// turn-completion signal so "notify me when it finishes" works for both agents.
//
// Codex allows exactly ONE notify program, and the user may already have one
// (Codex Computer Use uses it). So this is a WRAPPER: on an agent-turn-complete
// event it bumps the per-turn counter hop reads, then FORWARDS the event to the
// original notify command unchanged, so whatever was there keeps working.
//
// Codex invokes:  <notify[0]> <notify[1..]> <json-payload>
// We are installed as: ["node", "<this script>", "--chain", <orig...>]  (the
// "--chain <orig...>" part is optional). Codex appends the JSON payload as the
// LAST argv element. So:
//   argv = [node, thisScript, "--chain", origCmd, origArg1, ..., <json>]
// Everything between "--chain" and the final element is the original command to
// forward to; the final element is always the JSON payload.
//
// Must NEVER disrupt Codex: it ignores all errors and always exits 0 (after the
// chained program, if any, has been spawned).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function turnsDir() {
  const home = process.env.HOP_HOME || path.join(os.homedir(), ".hop2");
  const dir = path.join(home, "claude-sessions"); // shared with the claude hook; hop reads <internal>.turn here
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

// WHICH hop session finished a turn. The environment says HOP_SESSION, but
// under Codex's shared app-server daemon every session's notify ran with
// the FIRST session's environment, so surf's turns were counted against
// Accessibility-fork-codex (233 of them) and its own record sat at 1. The
// thread is the truth: if another session's turn record already names this
// root thread, the turn is that session's. (hop launches codex without the
// daemon now; this keeps the sessions that predate the change honest.)
function resolveHopSession(dir, rootId, envSession) {
  if (!rootId) return envSession;
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".turn")); } catch { return envSession; }
  const owners = [];
  for (const f of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (rec && rec.agent === "codex" && rec.sessionId === rootId) owners.push(f.slice(0, -".turn".length));
    } catch { /* unreadable record */ }
  }
  if (owners.includes(envSession)) return envSession;
  return owners.length === 1 ? owners[0] : envSession;
}

// A sub-agent's rollout names its parent in its first line (session_meta →
// parent_thread_id). Walk up to the root, reading only that line of each
// file — a long thread's rollout runs to hundreds of MB. Any failure leaves
// the id as given; hop resolves it again at restore time.
function findRollout(id) {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) { const hit = walk(p, depth + 1); if (hit) return hit; }
      else if (e.isFile() && e.name.endsWith(".jsonl") && e.name.includes(id)) return p;
    }
    return null;
  };
  return walk(root, 0);
}
function rootThreadId(id) {
  let cur = id;
  for (let hops = 0; hops < 8 && cur; hops++) {
    const file = findRollout(cur);
    if (!file) return cur;
    let parent = null;
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const text = buf.toString("utf8", 0, n);
      const meta = JSON.parse(text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length));
      parent = meta && meta.payload && typeof meta.payload.parent_thread_id === "string" ? meta.payload.parent_thread_id : null;
    } catch { return cur; }
    if (!parent || parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

// Same crash-safe write + same {sessionId, count, at} shape the Claude hook
// uses, so hop's finishBump() reads one number regardless of which agent wrote.
function bumpTurn(payload) {
  const envSession = process.env.HOP_SESSION;
  if (!envSession || !/^[A-Za-z0-9_-]+$/.test(envSession)) return; // not a hop session
  const dir = turnsDir();
  const rawThread = (payload && typeof payload["thread-id"] === "string") ? payload["thread-id"]
             : (payload && typeof payload.thread_id === "string") ? payload.thread_id
             : (payload && typeof payload.session_id === "string") ? payload.session_id : null;
  const rootId = rootThreadId(rawThread);
  const hopSession = resolveHopSession(dir, rootId, envSession);
  const file = path.join(dir, `${hopSession}.turn`);
  let count = 0;
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8"));
    if (prev && Number.isInteger(prev.count) && prev.count >= 0) count = prev.count;
  } catch { /* missing/corrupt -> start at 0 */ }
  const rec = JSON.stringify({
    // The thread id is the conversation (and the rollout file's name); the
    // turn id names one turn and matches nothing on disk. With multi-agent
    // codex the thread that finished may be a SUB-agent, which cannot be
    // resumed on its own — record the root, which can.
    sessionId: rootId,
    count: count + 1,
    at: new Date().toISOString(),
    agent: "codex"
  });
  try {
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeSync(fd, rec); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch {
    try { fs.writeFileSync(file, rec, { mode: 0o600 }); } catch { /* never disrupt codex */ }
  }
}

function main() {
  const rest = process.argv.slice(2);
  if (rest.length === 0) return;
  const json = rest[rest.length - 1];              // Codex always appends the payload last
  let chain = [];
  const ci = rest.indexOf("--chain");
  if (ci !== -1) chain = rest.slice(ci + 1, rest.length - 1); // between --chain and the payload

  let payload = null;
  try { payload = JSON.parse(json); } catch { /* not JSON — still forward */ }

  // Diagnosable without a full run: record the last event type we saw. A
  // finish that never fires usually means Codex names the event differently —
  // this file says what it actually sent. Single line, overwritten each time.
  try {
    const home = process.env.HOP_HOME || path.join(os.homedir(), ".hop2");
    fs.writeFileSync(path.join(home, "codex-notify-last.json"),
      JSON.stringify({ at: new Date().toISOString(), type: payload && payload.type,
                       session: process.env.HOP_SESSION || null }), { mode: 0o600 });
  } catch { /* diagnostics are optional */ }

  // The finish event. Codex's turn-complete type is "agent-turn-complete";
  // accept any *-turn-complete for forward-compatibility.
  const type = payload && typeof payload.type === "string" ? payload.type : "";
  if (/turn[-_]?complete/i.test(type) || type === "agent-turn-complete") {
    try { bumpTurn(payload); } catch { /* never disrupt codex */ }
  }

  // Forward to the original notify program EXACTLY as Codex would have called
  // it: origCmd origArgs... <json>. Detached-ish but inheriting stdio so it
  // behaves identically to being Codex's direct notify.
  if (chain.length > 0) {
    try {
      const [cmd, ...args] = chain;
      const child = spawn(cmd, [...args, json], { stdio: "inherit" });
      child.on("error", () => {});
      // Don't hang Codex waiting on the chained program.
      child.unref();
    } catch { /* the bump already happened; forwarding is best-effort */ }
  }
}

try { main(); } catch { /* never break codex */ }
process.exit(0);
