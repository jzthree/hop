#!/usr/bin/env node
// Claude Code SessionStart hook for hop session restore.
//
// Claude runs this on session start/resume with a JSON payload on stdin
// ({ session_id, cwd, source, ... }). When the session is running inside a hop
// terminal (env HOP_SESSION is set), we record which Claude conversation belongs
// to that hop session, so `hop restore` can later relaunch it with
// `claude --resume <session_id>` from the same cwd.
//
// This must NEVER disrupt Claude: it ignores all errors and always exits 0, and
// is a no-op outside hop (HOP_SESSION unset).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function main() {
  const hopSession = process.env.HOP_SESSION;
  if (!hopSession || !/^[A-Za-z0-9_-]+$/.test(hopSession)) return; // not a hop session

  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { return; }
  let payload;
  try { payload = JSON.parse(raw || "{}"); } catch { return; }
  const sessionId = payload && typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return;
  const cwd = payload && typeof payload.cwd === "string" ? payload.cwd : process.cwd();

  const home = process.env.HOP_HOME || path.join(os.homedir(), ".hop2");
  const dir = path.join(home, "claude-sessions");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  const record = JSON.stringify({
    sessionId,
    cwd,
    source: payload.source || null,
    updatedAt: new Date().toISOString()
  });
  // One file per hop session avoids concurrent-write races between sessions.
  try {
    fs.writeFileSync(path.join(dir, `${hopSession}.json`), record, { mode: 0o600 });
  } catch { /* ignore */ }
}

try { main(); } catch { /* never break claude */ }
process.exit(0);
