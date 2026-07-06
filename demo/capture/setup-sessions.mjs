// Create the sanitized demo shell sessions: Lyra2, Nebula2, Polaris2. The
// "2"-suffixed internal names keep them clear of any real session or stale
// alias; the capture driver's DOM rewriter displays them as Lyra/Nebula/
// Polaris. Each gets a deterministic clean bash (env -i) and a scrollback
// wipe, then Nebula2/Polaris2 start endless colorful tickers so switcher
// cards look live. Run spawn-aurora.mjs afterwards for the agent session.
import {
  getHopState, ensureTerminal, execTerminal, resizeTerminal, sleep
} from "../hop-demo-lib.mjs";
import {
  WORKSPACE, sanitizedShell, WIPE, loadTerminals, saveTerminals, seedDemoTree
} from "./capture-env.mjs";

const state = getHopState();
seedDemoTree();

const defs = [
  { name: "Lyra2",    after: ["ls -1"] },
  { name: "Nebula2",  after: ["sh ../tools/build.sh"] },
  { name: "Polaris2", after: ["sh ../tools/metrics.sh"] }
];

const out = loadTerminals({ required: false });
for (const def of defs) {
  const t = await ensureTerminal(state, { name: def.name, cwd: WORKSPACE, cols: 140, rows: 40 });
  await resizeTerminal(state, t.id, 140, 40);
  await sleep(1200);                      // let the real zsh prompt appear
  await execTerminal(state, t.id, sanitizedShell());
  await sleep(900);
  await execTerminal(state, t.id, WIPE);  // wipe screen + scrollback (removes real prompt)
  await sleep(500);
  for (const cmd of def.after) {
    await execTerminal(state, t.id, cmd);
    await sleep(700);
  }
  out[def.name] = { terminalId: t.id, sessionName: t.sessionName || def.name };
  console.log(`ready: ${def.name} -> ${t.id}`);
}
saveTerminals(out);
console.log("done");
