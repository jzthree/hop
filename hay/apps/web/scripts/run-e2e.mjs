import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const port = "4170";
const baseUrl = `http://localhost:${port}`;
const serverEntry = path.join(root, "apps/server/dist/index.js");
const webDist = path.join(root, "apps/web/dist");

const run = (command, envOverrides = {}) => {
  execSync(command, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ...envOverrides
    }
  });
};

const waitForServer = (url, timeoutMs = 15000) => {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
          return;
        }
        retry();
      });
      request.on("error", retry);
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("Server did not start in time"));
        return;
      }
      setTimeout(attempt, 500);
    };

    attempt();
  });
};

const joinRoom = async (page, name, room) => {
  await page.goto(baseUrl);
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Room").fill(room);
  await page.getByRole("button", { name: "Start session" }).click();
  await page.locator(".terminal-frame").waitFor({ state: "visible" });
};

const runE2E = async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const room = `e2e-${Date.now()}`;
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await joinRoom(page1, "Alex", room);
    await joinRoom(page2, "Blake", room);

    await page1.locator(".terminal-frame").click();
    await page1.keyboard.type("echo shared");
    await page1.keyboard.press("Enter");

    await page2.waitForFunction(() => {
      return window.__termshare?.getBufferText().includes("shared");
    });

    const roomLock = `e2e-${Date.now()}-lock`;
    const context2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page3 = await context2.newPage();
    const page4 = await context2.newPage();

    await joinRoom(page3, "Casey", roomLock);
    await joinRoom(page4, "Drew", roomLock);

    await page3.getByRole("button", { name: "Lock control" }).click();
    await page3.waitForFunction(() => {
      return document.querySelector(".status-main")?.textContent?.includes("Locked");
    });
    await page4.locator(".terminal-frame").click();
    await page4.keyboard.type("whoami");
    await page4.keyboard.press("Enter");

    await page4.waitForFunction(() => {
      return document.querySelector(".notice")?.textContent?.includes("Control is locked");
    });
    const notice = await page4.locator(".notice").textContent();
    assert.ok(notice?.includes("Control is locked"));

    await context.close();
    await context2.close();
  } finally {
    await browser.close();
  }
};

run("npm -w packages/shared run build");
run("npm -w apps/server run build");
run("npm -w apps/web run build", { VITE_E2E: "true" });

const server = spawn("node", [serverEntry], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: port,
    SERVE_WEB: "true",
    WEB_DIST_PATH: webDist,
    PTY_MODE: "mock"
  }
});

try {
  await waitForServer(`${baseUrl}/health`);
  await runE2E();
} finally {
  server.kill("SIGTERM");
}
