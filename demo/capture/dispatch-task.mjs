// Dispatch a narration task to the Aurora2 agent via hopx_agent_turn (async),
// then wait until the identity banner has scrolled off the visible screen AND
// enough output has streamed that modest scrollback is safe.
// Usage: node dispatch-task.mjs "<task text>" [minCharsStreamed]
import { getHopState } from "../hop-demo-lib.mjs";
import { startMcp } from "./mcp-client.mjs";
import { SCREEN_FORBIDDEN, loadTerminals } from "./capture-env.mjs";

const task = process.argv[2];
const minChars = Number(process.argv[3] || 2500);
if (!task) { console.error("usage: dispatch-task.mjs <task>"); process.exit(1); }
const { Aurora2 } = loadTerminals();
if (!Aurora2) { console.error("Aurora2 not registered — run spawn-aurora.mjs first"); process.exit(1); }

const state = getHopState();
const preview = async () => {
  const r = await fetch(`${state.localUrl}/api/sessions/preview?name=Aurora2`, {
    headers: { Authorization: `Bearer ${state.sessionSecret}` }
  });
  return (await r.json()).text || "";
};

const mcp = startMcp("video-dispatch");
try {
  await mcp.init();

  const turn = await mcp.callTool("hopx_agent_turn", { terminal_id: Aurora2.terminalId, data: task, async: true }, 60000);
  console.log("dispatched wait_id=" + (turn.parsed?.wait_id || "none") + (turn.isError ? " ERROR " + turn.text.slice(0, 200) : ""));

  // Wait until banner is off the visible screen and output volume is healthy.
  let streamed = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const text = await preview();
    const bannerVisible = SCREEN_FORBIDDEN.some((bad) => text.includes(bad));
    streamed = text.length;
    if (!bannerVisible && text.length > minChars) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`screen ready, visible chars=${streamed}`);
} finally {
  mcp.kill();
  process.exit(0);
}
