#!/usr/bin/env node
// Claude Code hook for hop. Two jobs, chosen by the hook event on stdin:
//
//   SessionStart -> record which Claude conversation belongs to this hop session,
//       at <HOP_HOME>/claude-sessions/<HOP_SESSION>.json
//       ({ sessionId, cwd, source, updatedAt }), so `hop restore` can relaunch it
//       with `claude --resume <id>` from the same cwd.
//
//   Stop -> bump a per-turn completion counter at
//       <HOP_HOME>/claude-sessions/<HOP_SESSION>.turn
//       ({ sessionId, count, at }). `count` increments once each time Claude
//       finishes a turn, giving a deterministic "agent is done with this turn"
//       signal a driver (the hop MCP) can wait on instead of scraping the screen.
//
// Claude runs this with a JSON payload on stdin that includes `hook_event_name`.
// It is a no-op outside hop (HOP_SESSION unset) and must NEVER disrupt Claude:
// it ignores all errors and always exits 0.

const fs = require("node:fs");
const os = require("node:os");

// Crash-safe write: temp + fsync + atomic rename. Records are the restore
// inventory — an un-fsynced page cache at power loss must not be able to
// take a conversation's identity with it (the 07-29 thermal-sleep crash
// erased three days of plainly-written files while fsynced ones survived).
function writeDurable(file, data) {
  try {
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch {
    try { fs.writeFileSync(file, data, { mode: 0o600 }); } catch { /* never disrupt claude */ }
  }
}

const path = require("node:path");
const { execFileSync } = require("node:child_process");

// The full command line claude was ACTUALLY started with (alias expansion has
// already happened in argv), so `hop restore` can relaunch with the same
// flags (--dangerously-skip-permissions etc.) instead of a bare `claude`.
// The hook may run under a shell claude spawned, so walk up a few parents.
function claudeLaunchCmd() {
  try {
    let pid = process.ppid;
    for (let hop = 0; hop < 4 && pid > 1; hop++) {
      const out = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
        encoding: "utf8", timeout: 1500
      }).trim();
      const m = out.match(/^\s*(\d+)\s+(.*)$/s);
      if (!m) return null;
      const cmd = m[2].trim();
      const word = (cmd.split(/\s+/)[0] || "").replace(/^-/, "");
      const base = word.split("/").pop() || "";
      if (/^claude[\w.-]*$/.test(base)) return cmd;
      if (base === "node" && /claude/i.test(cmd)) return cmd;
      if (!/^(sh|bash|zsh|dash|fish|ksh|env)$/.test(base)) return null; // unknown ancestor — stop
      pid = Number(m[1]);
    }
  } catch { /* never break claude */ }
  return null;
}

// A headless claude (`-p`/`--print`, stream-json piping, --no-session-
// persistence) is tooling, never the terminal's conversation: a classifier
// the room's own claude shells out to, a batch job, a test. It has nothing
// to resume - with --no-session-persistence there is no transcript at all -
// and its Stops are not the user's turns. The nested-claude guards cannot
// see it when it runs in the room's OWN directory (the parked-rival rule
// keys on a different cwd): on 2026-08-19 a furniture-classifier `claude
// -p ... --no-session-persistence` spawned inside the `room` session took
// over its record, and two days later `hop restore` found "no transcript
// on this host" and reopened a plain shell over a live conversation.
function isHeadlessLaunch(cmd) {
  if (typeof cmd !== "string" || !cmd) return false;
  const tokens = cmd.split(/\s+/);
  for (const t of tokens) {
    if (t === "-p" || t === "--print") return true;
    if (t === "--no-session-persistence") return true;
    if (/^--(input|output)-format(=|$)/.test(t)) return true;
  }
  return false;
}

function sessionsDir() {
  const home = process.env.HOP_HOME || path.join(os.homedir(), ".hop2");
  const dir = path.join(home, "claude-sessions");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

// The transcript store is not a workspace. A cwd inside any claude config's
// projects directory (~/.claude*/projects/<encoded>) means SOMETHING resumed
// this conversation from where its transcript lives — salvage tooling, a
// script poking at history — and recording it poisons the whole downstream
// chain: `hop restore` relaunches there, fork inherits it (the
// Accessibility-fork incident: forked session opened in
// ~/.claude/projects/-Users-jianzhou), and each propagates it further.
function isTranscriptStorePath(cwd) {
  return /[\\/]\.claude[^\\/]*[\\/]projects([\\/]|$)/.test(String(cwd || ""));
}

function recordSession(dir, hopSession, payload, launchCmd) {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return;
  let cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  // The payload's cwd is claude's CURRENT directory, which follows the
  // conversation's own shell: a claude launched in ~ whose Bash tool cd'd
  // into ~/Code/x reports ~/Code/x from then on. That is fine for a launch
  // (`startup`: a fresh process stands where it was started) and poison for
  // a compaction, which is the same process, mid-flight, wherever its shell
  // has wandered. Recording the drifted directory on compact made `hop
  // restore` compare it against the room's real directory, conclude the
  // record belonged to some OTHER claude, and drop the room to a plain
  // shell — a 975-turn conversation discarded as an intruder (angler,
  // 2026-08-21). A conversation's home never moves: keep the incumbent's.
  const incumbent = () => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, `${hopSession}.json`), "utf8")); }
    catch { return null; }
  };
  if (payload.source === "compact") {
    const prev = incumbent();
    if (prev && prev.cwd && !isTranscriptStorePath(prev.cwd)) cwd = prev.cwd;
  }
  if (isTranscriptStorePath(cwd)) {
    // Keep the incumbent record's cwd if there is one — the conversation
    // itself is still real (same or new id), only the location is junk.
    const prev = incumbent();
    if (prev && prev.cwd && !isTranscriptStorePath(prev.cwd)) cwd = prev.cwd;
  }
  const record = JSON.stringify({
    sessionId,
    cwd,
    source: payload.source || null,
    // Which Claude config this conversation lives in (e.g. a `claude-fable`
    // wrapper with CLAUDE_CONFIG_DIR=~/.claude_fable). `hop restore` must
    // replay it, or `claude --resume <id>` looks in the wrong config and fails.
    configDir: process.env.CLAUDE_CONFIG_DIR || null,
    // Resolved argv of the running claude (flags survive even when they came
    // from a shell alias, which a rebuilt/prefixed command would not expand).
    launchCmd,
    updatedAt: new Date().toISOString()
  });
  // One file per hop session avoids concurrent-write races between sessions.
  const file = path.join(dir, `${hopSession}.json`);
  // Second nested-claude guard, for the case the env check above cannot see:
  // hop SCRUBS CLAUDE_CODE_* when it spawns a session shell, so a claude
  // started by a tool/MCP inside this session may carry no parent id at all.
  // Such a claude almost always runs in a DIFFERENT directory than the
  // session's own conversation (an agent workspace, a scratch tree). Never
  // let it silently take over an existing record: keep the incumbent and
  // park this one alongside for diagnosis. A genuine re-launch in the same
  // directory (the normal case — user quits claude and starts it again)
  // still updates the record.
  try {
    const prevRaw = fs.readFileSync(file, "utf8");
    const prev = JSON.parse(prevRaw);
    if (prev && prev.sessionId && prev.sessionId !== sessionId && prev.cwd && prev.cwd !== cwd) {
      try {
        writeDurable(path.join(dir, `${hopSession}.other.json`), record);
      } catch { /* ignore */ }
      return;
    }
  } catch { /* no incumbent (or unreadable) — record normally */ }
  try {
    writeDurable(file, record);
  } catch { /* ignore */ }
}

function bumpTurn(dir, hopSession, payload) {
  const file = path.join(dir, `${hopSession}.turn`);
  let count = 0;
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8"));
    if (prev && Number.isInteger(prev.count) && prev.count >= 0) count = prev.count;
  } catch { /* missing/corrupt -> start at 0 */ }
  const record = JSON.stringify({
    sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
    count: count + 1,
    at: new Date().toISOString()
  });
  try {
    writeDurable(file, record);
  } catch { /* ignore */ }
}

function main() {
  const hopSession = process.env.HOP_SESSION;
  if (!hopSession || !/^[A-Za-z0-9_-]+$/.test(hopSession)) return; // not a hop session

  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { return; }
  let payload;
  try { payload = JSON.parse(raw || "{}"); } catch { return; }
  if (!payload || typeof payload !== "object") return;

  // Nested-claude guard: a claude spawned from ANOTHER claude's tool shell
  // (e.g. a headless test run by an orchestrating Claude Code) inherits this
  // terminal's HOP_SESSION — but it is not the terminal's primary conversation.
  // Its env carries the PARENT's CLAUDE_CODE_SESSION_ID; when that is set and
  // differs from this process's own session id, recording would clobber the
  // terminal's record (wrong cwd + an unresumable conversation on `hop
  // restore`) and its Stops would fake turn completions. Skip both. hop scrubs
  // these markers when spawning session shells, so each session's primary
  // claude (and every fleet worker in its own session) still records normally.
  const parentSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  const ownSessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (parentSessionId && ownSessionId && parentSessionId !== ownSessionId) return;

  // Third guard, for the case neither env check can see: a headless claude
  // in the room's own directory. Its argv tells the truth even when its
  // environment does not. Neither recorded nor counted.
  const launchCmd = claudeLaunchCmd();
  if (isHeadlessLaunch(launchCmd)) return;

  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const dir = sessionsDir();
  // Only the main agent's Stop bumps the turn counter. SubagentStop (a Task-tool
  // sub-agent finishing) is intentionally not registered/handled, so it never
  // signals a premature "turn done".
  if (event === "Stop") {
    bumpTurn(dir, hopSession, payload);
  } else {
    recordSession(dir, hopSession, payload, launchCmd); // SessionStart (default)
  }
}

try { main(); } catch { /* never break claude */ }
process.exit(0);
