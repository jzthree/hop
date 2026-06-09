import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, devices } from "../hay/node_modules/playwright/index.mjs";

const DEFAULT_HOP_HOME = process.env.HOP_HOME || path.join(process.env.HOME, ".hop2");
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export async function sleep(ms) {
  await delay(ms);
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

export function getHopState(hopHome = DEFAULT_HOP_HOME) {
  const statePath = path.join(hopHome, ".tunnel-state");
  const secretPath = path.join(hopHome, ".session_secret");
  if (!fs.existsSync(statePath)) {
    throw new Error(`Hop state file not found: ${statePath}`);
  }
  if (!fs.existsSync(secretPath)) {
    throw new Error(`Hop session secret file not found: ${secretPath}`);
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const sessionSecret = fs.readFileSync(secretPath, "utf8").trim();
  if (!state.port) {
    throw new Error(`Invalid Hop state file: missing port in ${statePath}`);
  }
  return {
    hopHome,
    port: Number(state.port),
    publicUrl: state.url || null,
    localUrl: `http://127.0.0.1:${state.port}`,
    sessionSecret
  };
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export async function waitForFile(filePath, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }
    await sleep(200);
  }
}

export async function waitForHopReady(hopHome, timeoutMs = 10000) {
  const statePath = path.join(hopHome, ".tunnel-state");
  await waitForFile(statePath, timeoutMs);
  const startedAt = Date.now();
  while (true) {
    const state = getHopState(hopHome);
    try {
      const response = await fetch(`${state.localUrl}/api/sessions`, {
        headers: {
          Authorization: `Bearer ${state.sessionSecret}`
        }
      });
      if (response.ok) {
        return state;
      }
    } catch {
      // keep polling
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for Hop API in ${hopHome}`);
    }
    await sleep(250);
  }
}

function withNodePath(env = {}) {
  const currentPath = process.env.PATH || "";
  const nextPath = currentPath.includes("/opt/homebrew/bin")
    ? currentPath
    : `/opt/homebrew/bin:${currentPath}`;
  return {
    ...process.env,
    ...env,
    PATH: nextPath
  };
}

export function runHopCli(args, options = {}) {
  const result = spawnSync("/opt/homebrew/bin/node", [path.join(REPO_ROOT, "hop"), ...args], {
    cwd: REPO_ROOT,
    env: withNodePath(options.env || {}),
    encoding: "utf8",
    stdio: options.stdio || "pipe"
  });
  if (result.status !== 0) {
    const stderr = result.stderr || "";
    const stdout = result.stdout || "";
    throw new Error(`hop ${args.join(" ")} failed: ${stderr || stdout || result.status}`);
  }
  return result;
}

export async function startHopDaemon(hopHome) {
  ensureDir(hopHome);
  runHopCli(["start"], {
    env: { HOP_HOME: hopHome },
    stdio: "pipe"
  });
  return waitForHopReady(hopHome, 15000);
}

export function stopHopDaemon(hopHome) {
  try {
    runHopCli(["stop"], {
      env: { HOP_HOME: hopHome },
      stdio: "pipe"
    });
  } catch {
    // Best effort shutdown for demo homes.
  }
}

export function prepareSanitizedWorkspace(workspaceDir, options = {}) {
  const reset = options.reset !== false;
  if (reset) {
    resetDir(workspaceDir);
  } else {
    ensureDir(workspaceDir);
  }
  const readmePath = path.join(workspaceDir, "README.md");
  const appPath = path.join(workspaceDir, "index.html");
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# Demo Project

This is a sanitized workspace for Hop product demos.

- No personal paths
- No personal usernames
- Safe to record on screen
`);
  }
  if (!fs.existsSync(appPath)) {
    fs.writeFileSync(appPath, `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hop Demo Workspace</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 48px; background: linear-gradient(135deg, #f9f5ef, #efe6d6); color: #1f2937; }
      .card { max-width: 720px; background: rgba(255,255,255,0.85); padding: 32px; border-radius: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.08); }
      h1 { margin-top: 0; font-size: 44px; }
      p { font-size: 18px; line-height: 1.6; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Hop Demo Workspace</h1>
      <p>Visible, steerable agent terminals for real work.</p>
      <p>This file exists to give the demo agent something clean to read and change.</p>
    </div>
  </body>
</html>
`);
  }
  return workspaceDir;
}

export function buildSanitizedLaunchCommand(command, options = {}) {
  const prompt = options.prompt || "demo@hop ~/workspace % ";
  const homeDir = options.homeDir || path.join(os.tmpdir(), "hop-demo-home");
  const cwdLabel = options.cwdLabel || "workspace";
  ensureDir(homeDir);
  return [
    `export HOME=${JSON.stringify(homeDir)}`,
    "export USER=demo",
    "export LOGNAME=demo",
    "export HOSTNAME=hop-demo",
    "export TERM_PROGRAM=HopDemo",
    "unset VIRTUAL_ENV CONDA_DEFAULT_ENV CONDA_PROMPT_MODIFIER",
    `export PS1=${JSON.stringify(prompt)}`,
    `PROMPT=${JSON.stringify(prompt)}`,
    `RPROMPT=''`,
    `cd ${JSON.stringify(options.cwd || ".")}`,
    `printf '\\033]0;%s\\007' ${JSON.stringify(cwdLabel)}`,
    "clear",
    command
  ].join("; ");
}

export async function hopApi(state, pathname, options = {}) {
  const method = options.method || "GET";
  const headers = {
    Authorization: `Bearer ${state.sessionSecret}`,
    ...options.headers
  };
  let body = options.body;
  if (body && typeof body === "object" && !(body instanceof Buffer)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch(`${state.localUrl}${pathname}`, {
    method,
    headers,
    body
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    const detail = payload && payload.error ? payload.error : text || `${response.status}`;
    throw new Error(`${method} ${pathname} failed: ${detail}`);
  }
  return payload;
}

export async function createSession(state, options) {
  return hopApi(state, "/api/sessions", {
    method: "POST",
    body: options
  });
}

export async function deleteSession(state, internalName) {
  return hopApi(state, "/api/sessions/delete", {
    method: "POST",
    body: { internalName }
  });
}

export async function createTerminal(state, options) {
  return hopApi(state, "/api/terminals", {
    method: "POST",
    body: options
  });
}

export async function attachTerminal(state, options) {
  return hopApi(state, "/api/terminals/attach", {
    method: "POST",
    body: options
  });
}

export async function ensureTerminal(state, options) {
  try {
    return await createTerminal(state, options);
  } catch (error) {
    if (!String(error.message || error).includes("Session name already in use")) {
      throw error;
    }
    return attachTerminal(state, { name: options.name, cols: options.cols, rows: options.rows });
  }
}

export async function execTerminal(state, terminalId, command) {
  return hopApi(state, `/api/terminals/${encodeURIComponent(terminalId)}/exec`, {
    method: "POST",
    body: { command }
  });
}

export async function writeTerminal(state, terminalId, data) {
  return hopApi(state, `/api/terminals/${encodeURIComponent(terminalId)}/write`, {
    method: "POST",
    body: { data }
  });
}

export async function resizeTerminal(state, terminalId, cols, rows) {
  return hopApi(state, `/api/terminals/${encodeURIComponent(terminalId)}/resize`, {
    method: "POST",
    body: { cols, rows }
  });
}

export async function closeTerminal(state, terminalId, killSession = false) {
  return hopApi(state, `/api/terminals/${encodeURIComponent(terminalId)}?killSession=${killSession ? "true" : "false"}`, {
    method: "DELETE"
  });
}

export async function waitForTerminalOutput(state, terminalId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15000);
  const pattern = options.pattern ? String(options.pattern) : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${state.localUrl}/api/terminals/${encodeURIComponent(terminalId)}/stream`, {
    headers: {
      Authorization: `Bearer ${state.sessionSecret}`
    },
    signal: controller.signal
  });
  if (!response.ok) {
    clearTimeout(timer);
    throw new Error(`Terminal stream failed: ${response.status}`);
  }
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  try {
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary = pending.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        boundary = pending.indexOf("\n\n");
        const dataLine = rawEvent
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        const payload = JSON.parse(dataLine.slice(6));
        if (payload.type !== "output" && payload.type !== "snapshot") continue;
        const chunkText = typeof payload.data === "string" ? payload.data : "";
        text += chunkText;
        if (!pattern || text.includes(pattern)) {
          clearTimeout(timer);
          controller.abort();
          return { payload, text };
        }
      }
    }
  } catch (error) {
    if (error.name === "AbortError") {
      clearTimeout(timer);
      return { payload: null, text };
    }
    clearTimeout(timer);
    throw error;
  }
  clearTimeout(timer);
  return { payload: null, text };
}

function buildCookie(state) {
  return {
    name: "tunnel_session",
    value: state.sessionSecret,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax"
  };
}

export async function openRecordedContext(state, options = {}) {
  const outDir = options.outDir || path.join(process.cwd(), "demo-output");
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    headless: options.headless !== false,
    executablePath: options.chromePath || DEFAULT_CHROME_PATH
  });
  const useMobile = Boolean(options.mobile);
  const contextOptions = useMobile
    ? {
        ...devices["iPhone 14"],
        recordVideo: {
          dir: outDir,
          size: { width: 390, height: 844 }
        }
      }
    : {
        viewport: {
          width: Number(options.width || 1920),
          height: Number(options.height || 1080)
        },
        recordVideo: {
          dir: outDir,
          size: {
            width: Number(options.width || 1920),
            height: Number(options.height || 1080)
          }
        }
      };
  const context = await browser.newContext(contextOptions);
  await context.addCookies([buildCookie(state)]);
  return { browser, context, outDir };
}

export async function recordHopView(state, options = {}) {
  const { browser, context, outDir } = await openRecordedContext(state, options);
  const page = await context.newPage();
  const targetPath = options.session
    ? `/s/${encodeURIComponent(options.session)}`
    : "/sessions";
  await page.goto(`${state.localUrl}${targetPath}`, {
    waitUntil: "networkidle",
    timeout: Number(options.timeoutMs || 30000)
  });
  if (options.sessionPrefix || options.allowedSessions) {
    const allowedSessions = Array.isArray(options.allowedSessions)
      ? options.allowedSessions
      : null;
    const sessionPrefix = options.sessionPrefix || null;
    await page.evaluate(({ prefix, allowed }) => {
      const allowName = (name) => {
        if (!name) return false;
        if (Array.isArray(allowed) && allowed.length > 0) {
          return allowed.includes(name);
        }
        if (prefix) {
          return name.startsWith(prefix);
        }
        return true;
      };

      document.querySelectorAll(".session-item-wrapper, .session-list-item").forEach((node) => {
        const label = node.querySelector(".session-title, .session-name, .session-list-name");
        const text = (label?.textContent || node.textContent || "").trim();
        if (!allowName(text)) {
          node.remove();
        }
      });
    }, {
      prefix: sessionPrefix,
      allowed: allowedSessions
    });
  }
  if (options.pageMode === "session-picker") {
    await page.addStyleTag({
      content: `
        body { background: linear-gradient(180deg, #f6f1e8 0%, #f9f7f2 100%) !important; }
        .container {
          max-width: 1080px !important;
          margin: 32px auto 0 !important;
          transform: scale(1.08);
          transform-origin: top center;
        }
      `
    });
  }
  const settleMs = Number(options.settleMs || 1000);
  const durationMs = Number(options.durationMs || 5000);
  if (settleMs > 0) {
    await sleep(settleMs);
  }
  const screenshotPath = path.join(outDir, options.screenshot || "capture.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  if (durationMs > 0) {
    await sleep(durationMs);
  }
  await context.close();
  await browser.close();
  return { outDir, screenshotPath };
}

export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address !== "object") {
          reject(new Error("Failed to allocate a local port"));
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

export async function waitForHttp(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (true) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${url}`);
    }
    await sleep(250);
  }
}

export async function startStaticPreviewServer(rootDir, port) {
  const child = spawn("/opt/homebrew/bin/node", [path.join(REPO_ROOT, "demo", "static-preview-server.mjs"), "--root", rootDir, "--port", String(port)], {
    cwd: REPO_ROOT,
    env: withNodePath(),
    stdio: "pipe"
  });
  await waitForHttp(`http://127.0.0.1:${port}`, 10000);
  return child;
}
