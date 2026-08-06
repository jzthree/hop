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
  await page.getByLabel("Session").fill(room);
  await page.getByRole("button", { name: "Connect" }).click();
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

    // Renderer-geometry regression guard: xterm stacks its renderer canvases
    // absolutely at the screen's top-left. A stray CSS override once forced
    // them into flow — the WebGL canvas wrapped one screen-height down and
    // every terminal rendered blank while the buffer stayed correct (so
    // buffer-level asserts alone missed it). Fail fast if any canvas drifts.
    const canvasOffsets = await page1.evaluate(() =>
      [...document.querySelectorAll(".xterm-screen canvas")].map((c) => ({
        top: c.offsetTop, left: c.offsetLeft, pos: getComputedStyle(c).position
      }))
    );
    for (const c of canvasOffsets) {
      assert.equal(c.top, 0, `renderer canvas pushed out of view: ${JSON.stringify(canvasOffsets)}`);
      assert.equal(c.left, 0, `renderer canvas pushed out of view: ${JSON.stringify(canvasOffsets)}`);
      assert.equal(c.pos, "absolute", `renderer canvas must stay position:absolute: ${JSON.stringify(canvasOffsets)}`);
    }

    await page1.locator(".terminal-frame").click();
    await page1.keyboard.type("echo shared");
    await page1.keyboard.press("Enter");

    await page2.waitForFunction(() => {
      return window.__hay?.getBufferText().includes("shared");
    });

    // Switching to an untouched room produces no snapshot. The connection
    // handoff itself must still clear the previous room's screen before the
    // fresh room receives its first output.
    const freshRoom = `${room}-fresh`;
    await page1.evaluate((nextRoom) => {
      window.history.pushState({}, "", `/s/${encodeURIComponent(nextRoom)}/`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, freshRoom);
    await page1.waitForFunction((nextRoom) => {
      const url = new URL(window.location.href);
      const expectedPath = `/s/${encodeURIComponent(String(nextRoom))}/`;
      return url.pathname === expectedPath && document.querySelector(".footer-dot.connected");
    }, freshRoom);
    await page1.locator(".terminal-frame").click();
    await page1.keyboard.type("echo fresh");
    await page1.keyboard.press("Enter");
    await page1.waitForFunction(() => window.__hay?.getBufferText().includes("fresh"));
    const switchedBuffer = await page1.evaluate(() => window.__hay?.getBufferText() || "");
    assert.ok(!switchedBuffer.includes("shared"), `old room output survived session switch: ${JSON.stringify(switchedBuffer)}`);

    // A resize can collapse scrollback to y=base=0 without xterm emitting an
    // onScroll event. App follow-mode must reconcile that state before the
    // next real room output grows below a viewport parked at 0.
    const followAfterResize = await page1.evaluate(async () => {
      const terminal = window.__hay.terminal;
      const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
      terminal.reset();
      terminal.resize(20, 5);
      await write(Array.from({ length: 20 }, (_, i) => `old-${i}\r\n`).join(""));
      terminal.scrollLines(-2);
      const before = {
        y: terminal.buffer.active.viewportY,
        base: terminal.buffer.active.baseY
      };
      terminal.resize(20, 30);
      const afterResize = {
        y: terminal.buffer.active.viewportY,
        base: terminal.buffer.active.baseY
      };
      return { before, afterResize };
    });
    assert.ok(followAfterResize.before.y < followAfterResize.before.base, "follow-latch setup did not scroll above bottom");
    assert.deepEqual(followAfterResize.afterResize, { y: 0, base: 0 }, "resize did not collapse the test scrollback");

    // Deliver the new rows through the room, so this covers App's actual
    // output/follow path rather than xterm's behavior for a direct test write.
    await page1.evaluate(async ({ roomName, data }) => {
      const peer = new WebSocket(
        `ws://${location.host}/ws?room=${encodeURIComponent(roomName)}&name=FollowPeer&cols=20&rows=30`
      );
      await new Promise((resolve, reject) => {
        peer.onopen = resolve;
        peer.onerror = reject;
      });
      window.__followPeer = peer;
      peer.send(JSON.stringify({ type: "input", data }));
    }, {
      roomName: freshRoom,
      data: Array.from({ length: 15 }, (_, i) => `new-${i}\r\n`).join("")
    });
    await page1.waitForFunction(() => window.__hay.terminal.buffer.active.baseY > 0);
    followAfterResize.afterWrite = await page1.evaluate(() => ({
      y: window.__hay.terminal.buffer.active.viewportY,
      base: window.__hay.terminal.buffer.active.baseY
    }));
    await page1.evaluate(() => window.__followPeer?.close());
    assert.ok(followAfterResize.afterWrite.base > 0, "follow-latch test did not regrow scrollback");
    assert.equal(
      followAfterResize.afterWrite.y,
      followAfterResize.afterWrite.base,
      `terminal stopped following after resize: ${JSON.stringify(followAfterResize)}`
    );

    const roomLock = `e2e-${Date.now()}-lock`;
    const context2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page3 = await context2.newPage();
    const page4 = await context2.newPage();

    await joinRoom(page3, "Casey", roomLock);
    await joinRoom(page4, "Drew", roomLock);

    // Lock typing to page3: the Typing segmented control's "One user" option.
    await page3.getByRole("button", { name: "One user" }).evaluate((button) => button.click());
    await page3.waitForFunction(() => {
      return document.querySelector(".control-state")?.textContent?.includes("You have control");
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
