// Recreate the four sanitized demo sessions for the 04-phone-switcher clip,
// PHONE-FIT. Every PTY is created at 46x40 AND re-claimed via REST resize
// after the last write, so the API client is the latest typer and its size
// wins the election (same trick the capture driver uses for clip 03). No
// 140-col content ever exists, so the phone view cannot pan/crop the left
// text edge.
//
// Aurora2 runs a scripted agent-lookalike ticker (tools/agent.sh) — NOT a
// real agent — because clip 04 only shows preview cards plus a brief
// terminal shot.
import {
  getHopState, ensureTerminal, execTerminal, resizeTerminal, sleep
} from "../hop-demo-lib.mjs";
import {
  WORKSPACE, sanitizedShell, WIPE, saveTerminals, seedDemoTree
} from "./capture-env.mjs";

const state = getHopState();
seedDemoTree();

const COLS = 46, ROWS = 40;

const defs = [
  { name: "Lyra2",    after: ["ls -1"] },
  { name: "Aurora2",  after: ["sh ../tools/agent.sh"] },
  { name: "Nebula2",  after: ["sh ../tools/build.sh"] },
  { name: "Polaris2", after: ["sh ../tools/metrics.sh"] }
];

const out = {};
for (const def of defs) {
  const t = await ensureTerminal(state, { name: def.name, cwd: WORKSPACE, cols: COLS, rows: ROWS });
  await resizeTerminal(state, t.id, COLS, ROWS);
  await sleep(1400);                      // let the real zsh prompt appear
  await execTerminal(state, t.id, sanitizedShell("demo@hop $ "));
  await sleep(900);
  await execTerminal(state, t.id, WIPE);  // wipe screen + scrollback (removes real prompt)
  await sleep(500);
  for (const cmd of def.after) {
    await execTerminal(state, t.id, cmd);
    await sleep(700);
  }
  // Re-claim the size election AFTER the last write on this terminal.
  await resizeTerminal(state, t.id, COLS, ROWS);
  out[def.name] = { terminalId: t.id, sessionName: t.sessionName || def.name };
  console.log(`ready: ${def.name} -> ${t.id}`);
}
saveTerminals(out);

// Sanity: every demo PTY must report phone-fit width, and no preview line may
// exceed COLS characters.
await sleep(2500);
const sess = await fetch(`${state.localUrl}/api/sessions`, {
  headers: { Authorization: `Bearer ${state.sessionSecret}` }
}).then((r) => r.json());
for (const def of defs) {
  const s = (sess.sessions || []).find((x) => x.name === def.name);
  console.log(`${def.name}: cols=${s?.cols} rows=${s?.rows} live=${s?.live}`);
  const p = await fetch(
    `${state.localUrl}/api/sessions/preview?name=${encodeURIComponent(def.name)}`,
    { headers: { Authorization: `Bearer ${state.sessionSecret}` } }
  ).then((r) => r.json()).catch(() => ({}));
  const maxw = Math.max(0, ...String(p.text || "").split("\n").map((l) => l.length));
  console.log(`${def.name}: preview max line width = ${maxw}`);
  if (maxw > COLS) throw new Error(`ABORT: ${def.name} preview wider than ${COLS} cols`);
}
console.log("done");
