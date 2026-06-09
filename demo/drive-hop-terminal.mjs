import path from "node:path";
import {
  closeTerminal,
  ensureTerminal,
  execTerminal,
  getHopState,
  parseArgs,
  resizeTerminal,
  waitForTerminalOutput,
  writeTerminal
} from "./hop-demo-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const state = getHopState(args["hop-home"]);
const name = args.name || "demo-agent";
const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
const cols = Number(args.cols || 140);
const rows = Number(args.rows || 40);
const kill = args.kill === true || args.kill === "true";
const readyTimeoutMs = Number(args["ready-timeout"] || 3000);
const skipReadyWait = args["skip-ready-wait"] === true || args["skip-ready-wait"] === "true";

const terminal = await ensureTerminal(state, {
  name,
  cwd,
  cols,
  rows
});

await resizeTerminal(state, terminal.id, cols, rows);

if (!skipReadyWait && (args.exec || args.write)) {
  await waitForTerminalOutput(state, terminal.id, {
    timeoutMs: readyTimeoutMs
  });
}

if (args.exec) {
  await execTerminal(state, terminal.id, String(args.exec));
}

if (args.write) {
  await writeTerminal(state, terminal.id, String(args.write));
}

if (args["wait-pattern"] || args["wait-timeout"]) {
  const waitResult = await waitForTerminalOutput(state, terminal.id, {
    pattern: args["wait-pattern"],
    timeoutMs: Number(args["wait-timeout"] || 15000)
  });
  console.log(JSON.stringify({
    ok: true,
    terminalId: terminal.id,
    sessionName: terminal.sessionName,
    displayName: terminal.displayName,
    waitMatched: Boolean(waitResult.payload),
    outputPreview: waitResult.text.slice(-500)
  }, null, 2));
} else {
  console.log(JSON.stringify({
    ok: true,
    terminalId: terminal.id,
    sessionName: terminal.sessionName,
    displayName: terminal.displayName
  }, null, 2));
}

if (kill) {
  await closeTerminal(state, terminal.id, true);
}
