// Spawn a real coding agent in session Aurora2 (displayed as "Aurora") via
// the Hop MCP server. Wipes scrollback before launch so no real shell prompt
// survives, accepts a trust prompt if one appears, checks the agent is on
// screen, and stores terminal info for later dispatch.
//
// The agent command defaults to `claude`; override with HOP_CAPTURE_AGENT.
import { startMcp } from "./mcp-client.mjs";
import {
  AGENT_CMD, WORKSPACE, loadTerminals, saveTerminals, seedDemoTree
} from "./capture-env.mjs";

seedDemoTree();
const mcp = startMcp("video-capture");

try {
  await mcp.init();

  const res = await mcp.callTool("hopx_spawn_agent", {
    name: "Aurora2",
    cwd: WORKSPACE,
    agent: "custom",
    command: `clear; printf '\\033[3J'; ${AGENT_CMD}`,
    ready_timeout_ms: 120000,
    cols: 140, rows: 40
  }, 240000);
  if (res.isError || !res.parsed?.terminal_id) {
    console.error("SPAWN FAIL: " + res.text.slice(0, 500));
    process.exit(1);
  }
  const terminalId = res.parsed.terminal_id;
  console.log(`spawned terminal_id=${terminalId} ready=${res.parsed.ready}`);

  // Screen check: trust prompt? agent visible?
  const agentToken = AGENT_CMD.split(/\s+/)[0].toLowerCase();
  for (let attempt = 0; attempt < 3; attempt++) {
    const ui = await mcp.callTool("hop_read_terminal", { terminal_id: terminalId, mode: "ui" }, 30000);
    const screen = JSON.stringify(ui.parsed?.ui?.lines || ui.text || "").toLowerCase();
    if (screen.includes("do you trust") || screen.includes("trust the files")) {
      console.log("trust prompt detected -> accepting");
      await mcp.callTool("hop_write_terminal", { terminal_id: terminalId, data: "\r" }, 20000);
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    console.log(`agent-on-screen=${screen.includes(agentToken)}`);
    console.log("screen sample: " + screen.slice(0, 400));
    break;
  }
  const info = loadTerminals({ required: false });
  info.Aurora2 = { terminalId, sessionName: res.parsed.sessionName || "Aurora2" };
  saveTerminals(info);
} finally {
  mcp.kill();
}
