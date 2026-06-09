import fs from "node:fs";
import path from "node:path";
import {
  buildSanitizedLaunchCommand,
  createSession,
  ensureTerminal,
  execTerminal,
  findFreePort,
  getHopState,
  parseArgs,
  prepareSanitizedWorkspace,
  recordHopView,
  resizeTerminal,
  sleep,
  startHopDaemon,
  startStaticPreviewServer,
  stopHopDaemon,
  waitForTerminalOutput,
  writeTerminal
} from "./hop-demo-lib.mjs";

function readPrompt(args, key, fallback) {
  const fileKey = `${key}-file`;
  if (args[fileKey]) {
    return fs.readFileSync(path.resolve(args[fileKey]), "utf8").trim();
  }
  if (args[key]) {
    return String(args[key]).trim();
  }
  return fallback;
}

function resolvePreset(args) {
  const preset = args.preset || "summary";
  if (preset === "landing-page") {
    return {
      prompt: "Open index.html and turn it into a more polished, visually striking product landing page for Hop. Keep it as a single static page. Make the changes directly.",
      followup: "Now tighten the headline and hero copy so it reads like a product demo page in one quick scan."
    };
  }
  return {
    prompt: "Summarize the current project in 3 short bullets and suggest one safe improvement. Do not mention any local usernames, hostnames, or file paths.",
    followup: "Now restate the improvement as one short sentence fit for an on-screen demo caption. Do not mention local paths."
  };
}

async function bestEffortOutputWait(state, terminalId, timeoutMs) {
  try {
    await waitForTerminalOutput(state, terminalId, { timeoutMs });
  } catch {
    // Demo capture should keep moving even if a terminal stream reconnect is noisy.
  }
}

async function ensurePortSession(state, name, port) {
  try {
    await createSession(state, {
      name,
      type: "port",
      port
    });
  } catch (error) {
    if (!String(error.message || error).includes("already in use")) {
      throw error;
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const outRoot = path.resolve(args.out || path.join("demo-output", `run-${Date.now()}`));
const isolatedHopHome = path.resolve(args["hop-home"] || path.join(outRoot, "hop-home"));
const startDaemon = args["start-daemon"] === true || args["start-daemon"] === "true";
const stopDaemon = args["stop-daemon"] === true || args["stop-daemon"] === "true";
const sessionName = args.name || "demo-agent";
const previewSessionName = args["preview-name"] || "demo-preview";
const workspaceDir = path.resolve(args.cwd || path.join(outRoot, "workspace"));
const baseLaunchCommand = args.launch || "codex";
const commandSettleMs = Number(args["command-settle"] || 1000);
const desktopDurationMs = Number(args["desktop-duration"] || 8000);
const followupDurationMs = Number(args["followup-duration"] || 5000);
const previewDurationMs = Number(args["preview-duration"] || 3500);
const mobileDurationMs = Number(args["mobile-duration"] || 3500);
const sessionsDurationMs = Number(args["sessions-duration"] || 2500);
const desktopWidth = Number(args.width || 1920);
const desktopHeight = Number(args.height || 1080);
const skipSessions = args["skip-sessions"] === true || args["skip-sessions"] === "true";
const skipPreview = args["skip-preview"] === true || args["skip-preview"] === "true";
const skipMobile = args["skip-mobile"] === true || args["skip-mobile"] === "true";

const preset = resolvePreset(args);
const prompt = readPrompt(args, "prompt", preset.prompt);
const followup = readPrompt(args, "followup", preset.followup);

fs.mkdirSync(outRoot, { recursive: true });
prepareSanitizedWorkspace(workspaceDir, {
  reset: args["reset-workspace"] !== "false"
});

const launchCommand = buildSanitizedLaunchCommand(baseLaunchCommand, {
  cwd: workspaceDir,
  cwdLabel: "workspace",
  homeDir: path.join(outRoot, "shell-home")
});

let state = startDaemon ? await startHopDaemon(isolatedHopHome) : getHopState(args["hop-home"]);
let previewServer = null;

try {
  const terminal = await ensureTerminal(state, {
    name: sessionName,
    cwd: workspaceDir,
    cols: 140,
    rows: 40
  });

  await resizeTerminal(state, terminal.id, 140, 40);
  await bestEffortOutputWait(state, terminal.id, 3000);

  const allowedSessions = [sessionName];

  if (!skipPreview) {
    const previewPort = await findFreePort();
    previewServer = await startStaticPreviewServer(workspaceDir, previewPort);
    await ensurePortSession(state, previewSessionName, previewPort);
    allowedSessions.push(previewSessionName);
  }

  const manifest = {
    outRoot,
    sessionName,
    previewSessionName: skipPreview ? null : previewSessionName,
    localUrl: state.localUrl,
    publicUrl: state.publicUrl,
    clips: []
  };

  if (!skipSessions) {
    const clipDir = path.join(outRoot, "01-sessions");
    await recordHopView(state, {
      outDir: clipDir,
      width: desktopWidth,
      height: desktopHeight,
      allowedSessions,
      pageMode: "session-picker",
      durationMs: sessionsDurationMs,
      settleMs: 500
    });
    manifest.clips.push({ name: "sessions", dir: clipDir });
  }

  await execTerminal(state, terminal.id, launchCommand);
  await bestEffortOutputWait(state, terminal.id, 6000);
  await sleep(commandSettleMs);

  if (prompt) {
    await writeTerminal(state, terminal.id, `${prompt}\n`);
    await bestEffortOutputWait(state, terminal.id, 2000);
  }

  const liveDir = path.join(outRoot, "02-agent-live");
  await recordHopView(state, {
    session: sessionName,
    outDir: liveDir,
    width: desktopWidth,
    height: desktopHeight,
    allowedSessions: [sessionName],
    durationMs: desktopDurationMs,
    settleMs: 500
  });
  manifest.clips.push({ name: "agent-live", dir: liveDir });

  if (followup) {
    await writeTerminal(state, terminal.id, `${followup}\n`);
    await bestEffortOutputWait(state, terminal.id, 1500);

    const followupDir = path.join(outRoot, "03-agent-redirect");
    await recordHopView(state, {
      session: sessionName,
      outDir: followupDir,
      width: desktopWidth,
      height: desktopHeight,
      allowedSessions: [sessionName],
      durationMs: followupDurationMs,
      settleMs: 500
    });
    manifest.clips.push({ name: "agent-redirect", dir: followupDir });
  }

  if (!skipPreview) {
    const previewDir = path.join(outRoot, "04-preview");
    await recordHopView(state, {
      session: previewSessionName,
      outDir: previewDir,
      width: desktopWidth,
      height: desktopHeight,
      allowedSessions,
      durationMs: previewDurationMs,
      settleMs: 500
    });
    manifest.clips.push({ name: "preview", dir: previewDir });
  }

  if (!skipMobile) {
    const mobileDir = path.join(outRoot, skipPreview ? "04-mobile" : "05-mobile");
    await recordHopView(state, {
      session: sessionName,
      outDir: mobileDir,
      mobile: true,
      allowedSessions: [sessionName],
      durationMs: mobileDurationMs,
      settleMs: 500
    });
    manifest.clips.push({ name: "mobile", dir: mobileDir });
  }

  const manifestPath = path.join(outRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify({
    ok: true,
    outRoot,
    manifest: manifestPath,
    sessionName,
    previewSessionName: skipPreview ? null : previewSessionName,
    workspaceDir,
    hopHome: isolatedHopHome,
    clips: manifest.clips
  }, null, 2));
} finally {
  if (previewServer) {
    previewServer.kill("SIGTERM");
  }
  if (stopDaemon) {
    stopHopDaemon(isolatedHopHome);
  }
}
