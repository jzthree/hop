#!/usr/bin/env node
// Antigravity CLI (`agy`) hooks for hop — the twin of the Claude hook
// (scripts/claude-session-hook.js), so an agy session in a hop terminal is
// known to hop the same way: which conversation it holds (for `hop restore`
// and `hop recover`), when a turn starts and when it is done (the wall's
// working / done colours, "notify me when it finishes").
//
// Installed by `hop antigravity-hook install` into ~/.gemini/config/hooks.json
// as `node <this> <Event>` for SessionStart, PreInvocation and Stop. agy
// passes the event's JSON on stdin (camelCase: conversationId,
// workspacePaths, transcriptPath, …) and reads a JSON reply on stdout.
//
// Records go where the other agents' do, ~/.hop2/claude-sessions/: the
// conversation in <session>.agy (its own file: hop reads <session>.json as a
// Claude conversation), turns in the shared <session>.turn / .prompt tagged
// agent: "antigravity". Must never disrupt agy: every error is swallowed and
// a valid reply is always printed.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AGENT = "antigravity";

function sessionsDir() {
  const home = process.env.HOP_HOME || path.join(os.homedir(), ".hop2");
  const dir = path.join(home, "claude-sessions");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

// Atomic, so a reader never sees half a record.
function writeDurable(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// The command line of the agy this hook runs under (its parent), so restore
// can keep the flags it was started with.
function agyLaunchCmd() {
  try {
    const { execFileSync } = require("node:child_process");
    const cmd = execFileSync("ps", ["-o", "args=", "-p", String(process.ppid)], { encoding: "utf8", timeout: 2000 }).trim();
    return /(^|\/)agy(\s|$)|antigravity/.test(cmd) ? cmd : null;
  } catch { return null; }
}

// The conversation's own directory: the first workspace path, else where agy runs.
function workspaceOf(payload) {
  const w = Array.isArray(payload.workspacePaths) ? payload.workspacePaths.find((p) => typeof p === "string" && p) : null;
  return w || process.cwd();
}

function recordSession(dir, hopSession, payload) {
  const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : "";
  if (!conversationId) return;
  writeDurable(path.join(dir, `${hopSession}.agy`), JSON.stringify({
    sessionId: conversationId,
    agent: AGENT,
    cwd: workspaceOf(payload),
    source: "startup",
    configDir: null,
    launchCmd: agyLaunchCmd(),
    transcriptPath: typeof payload.transcriptPath === "string" ? payload.transcriptPath : null,
    // The model hop shows beside the session (every hook payload names it).
    model: modelOf(payload),
    updatedAt: new Date().toISOString()
  }));
}

const modelOf = (payload) => (typeof payload.modelName === "string" && payload.modelName ? payload.modelName.slice(0, 80) : null);

/** A /model switch mid-conversation: the record follows it (the rest of the record kept). */
function noteModel(dir, hopSession, payload) {
  const model = modelOf(payload);
  if (!model) return;
  const file = path.join(dir, `${hopSession}.agy`);
  const rec = readJson(file);
  if (!rec || rec.sessionId !== payload.conversationId || rec.model === model) return;
  writeDurable(file, JSON.stringify({ ...rec, model }));
}

// The agent's last words, from the transcript's tail: agy's step log puts the
// model's words in the content of a PLANNER_RESPONSE step (tool output is a
// GENERIC step). Anything else that looks like a model/assistant message is
// taken too, in case the format moves.
function lastMessage(payload) {
  const tp = typeof payload.transcriptPath === "string" ? payload.transcriptPath : "";
  if (!tp) return "";
  try {
    const fd = fs.openSync(tp, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    const textOf = (v) => (typeof v === "string" ? v
      : Array.isArray(v) ? v.map(textOf).join(" ")
      : v && typeof v === "object" ? textOf(v.text ?? v.content ?? v.parts ?? "") : "");
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { continue; }
      if (rec && rec.type === "PLANNER_RESPONSE") {
        const said = typeof rec.content === "string" ? rec.content.replace(/\s+/g, " ").trim() : "";
        if (said) return said.slice(0, 600);
        continue;
      }
      const role = String(rec?.role || rec?.type || rec?.message?.role || rec?.source || "").toLowerCase();
      if (!/model|assistant|agent/.test(role)) continue;
      const text = textOf(rec.message ?? rec.content ?? rec.text ?? rec.parts ?? "").replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 600);
    }
  } catch { /* no transcript */ }
  return "";
}

function bumpTurn(dir, hopSession, payload) {
  const file = path.join(dir, `${hopSession}.turn`);
  const prev = readJson(file);
  const count = prev && Number.isInteger(prev.count) && prev.count >= 0 ? prev.count : 0;
  const said = lastMessage(payload);
  writeDurable(file, JSON.stringify({
    sessionId: typeof payload.conversationId === "string" ? payload.conversationId : null,
    agent: AGENT,
    count: count + 1,
    at: new Date().toISOString(),
    ...(said ? { lastMessage: said } : {})
  }));
}

function notePrompt(dir, hopSession, payload) {
  writeDurable(path.join(dir, `${hopSession}.prompt`), JSON.stringify({
    sessionId: typeof payload.conversationId === "string" ? payload.conversationId : null,
    agent: AGENT,
    at: new Date().toISOString()
  }));
}

/** What agy is told back: nothing to inject, and a Stop is allowed to stop. */
function reply(event) {
  return event === "Stop" ? { decision: "stop" } : {};
}

function main(event, raw, env = process.env) {
  const hopSession = env.HOP_SESSION;
  if (!hopSession || !/^[A-Za-z0-9_-]+$/.test(hopSession)) return;
  let payload;
  try { payload = JSON.parse(raw || "{}"); } catch { return; }
  if (!payload || typeof payload !== "object") return;
  const dir = sessionsDir();
  if (event === "SessionStart") recordSession(dir, hopSession, payload);
  else if (event === "PreInvocation") {
    // A turn begins with its first model call; later calls are the same turn.
    if (!Number(payload.invocationNum)) notePrompt(dir, hopSession, payload);
    // A resumed conversation has no SessionStart of its own in some builds:
    // the first call also files the record when none names this conversation.
    const rec = readJson(path.join(dir, `${hopSession}.agy`));
    if (!rec || rec.sessionId !== payload.conversationId) recordSession(dir, hopSession, payload);
    else noteModel(dir, hopSession, payload);
  } else if (event === "Stop") {
    // Done only when agy says it is fully idle (not between sub-steps).
    if (payload.fullyIdle !== false) bumpTurn(dir, hopSession, payload);
  }
}

if (require.main === module) {
  const event = process.argv[2] || "";
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { /* no stdin */ }
  try { main(event, raw); } catch { /* never break agy */ }
  try { process.stdout.write(JSON.stringify(reply(event))); } catch { /* ignore */ }
  process.exit(0);
}

module.exports = { main, reply, AGENT };
