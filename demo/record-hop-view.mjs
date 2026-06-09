import { getHopState, parseArgs, recordHopView } from "./hop-demo-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const state = getHopState(args["hop-home"]);

const result = await recordHopView(state, {
  session: args.session,
  outDir: args.out || args["out-dir"],
  mobile: args.mobile === true || args.mobile === "true",
  width: args.width,
  height: args.height,
  headless: args.headless === "false" ? false : true,
  timeoutMs: args.timeout,
  settleMs: args.settle,
  durationMs: args.duration,
  screenshot: args.screenshot
});

console.log(JSON.stringify({
  ok: true,
  localUrl: state.localUrl,
  publicUrl: state.publicUrl,
  session: args.session || null,
  outDir: result.outDir,
  screenshot: result.screenshotPath
}, null, 2));
