// Sanitized live-footage capture driver for the hop product video (dark theme).
// Usage: node demo/capture/capture.mjs <clip>   where clip in:
//   01-sessions | 02-agent-live | 02b-desktop-terminal | 03-phone-live |
//   04-phone-switcher | 05-presence | 06-math | 07-theme
//
// Run demo/capture/setup-sessions.mjs and demo/capture/spawn-aurora.mjs first
// (setup-04.mjs for the 04 clip). Paths and identity strings come from
// capture-env.mjs and its HOP_CAPTURE_* env overrides.
//
// Sanitization layers (both installed BEFORE first paint):
//  1. Network: /api/sessions GET responses are filtered to the demo session
//     set only (sessions, active, starting, aliases, order, folders).
//  2. DOM: a document-start MutationObserver rewrites the internal demo names
//     (Aurora2/Nebula2/Polaris2) to their display names (Aurora/Nebula/Polaris)
//     in every text node and title/aria-label/placeholder attribute.
//
// Recording discipline:
//  - DARK THEME everywhere: localStorage hay_theme=dark injected pre-load in
//    every context + colorScheme:'dark' (sessions.html follows
//    prefers-color-scheme). assertDark() verifies a real frame via ffmpeg
//    signalstats before the kept portion of each recording.
//  - Mobile on-screen keyboard is hidden (switcher header "Toggle keyboard")
//    before the kept portion of 03/04, and asserted hidden.
//  - Head-trimming: recording starts at page open, so each clip records a
//    marker timestamp and the head (page load, keyboard hiding, connect
//    handshakes) is trimmed off with ffmpeg on save. No idle/light/keyboard/
//    "Connecting" frames survive into the delivered clips.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getHopState, sleep } from "../hop-demo-lib.mjs";
import { chromium, devices } from "../../hay/node_modules/playwright/index.mjs";
import { NATIVE_CSS_INIT } from "./native-css.mjs";
import {
  CHROME, FFMPEG, OUT, VID_TMP, ALLOWED, SCREEN_FORBIDDEN, TERMINALS_PATH, loadTerminals
} from "./capture-env.mjs";

const state = getHopState();
const terminals = loadTerminals();
fs.mkdirSync(VID_TMP, { recursive: true });

function requireTerminalId(name) {
  const t = terminals[name];
  if (!t) {
    throw new Error(
      `session "${name}" not in ${TERMINALS_PATH} — run setup-sessions.mjs / spawn-aurora.mjs first`
    );
  }
  return t.terminalId;
}

const REWRITER = `(() => {
  const MAP = [["Aurora2","Aurora"],["Lyra2","Lyra"],["Nebula2","Nebula"],["Polaris2","Polaris"]];
  const fix = (s) => { let o = s; for (const [a,b] of MAP) o = o.split(a).join(b); return o; };
  const ATTRS = ["title","aria-label","placeholder"];
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  const fixText = (n) => {
    const p = n.parentNode;
    if (p && SKIP[p.nodeName]) return; // never touch executable/style content
    const v = fix(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v;
  };
  const fixEl = (el) => {
    if (!el.getAttribute) return;
    for (const a of ATTRS) { const v = el.getAttribute(a); if (v) { const f = fix(v); if (f !== v) el.setAttribute(a, f); } }
    if (el.tagName === "INPUT" && el.value) { const f = fix(el.value); if (f !== el.value) el.value = f; }
  };
  const walk = (root) => {
    if (!root) return;
    if (root.nodeType === 3) return fixText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) fixEl(root);
    const tw = document.createTreeWalker(root, 5 /* ELEMENT|TEXT */);
    let n; while ((n = tw.nextNode())) { n.nodeType === 3 ? fixText(n) : fixEl(n); }
  };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "characterData") fixText(m.target);
      else if (m.type === "attributes") fixEl(m.target);
      else m.addedNodes.forEach(walk);
    }
  });
  mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  if (document.documentElement) walk(document.documentElement);
  // Hide daemon-side API clients from the presence strip: every terminal
  // created/attached over /api/terminals keeps a persistent room client
  // (labelled "user"/"agent") that is rig plumbing, not demo cast.
  const GHOSTS = { user: 1, agent: 1 };
  setInterval(() => {
    document.querySelectorAll(".presence-chip:not(.self)").forEach((chip) => {
      const nm = chip.querySelector(".presence-name");
      if (nm && GHOSTS[nm.textContent.trim().toLowerCase()]) chip.style.display = "none";
    });
  }, 300);
})();`;

// Force dark theme before any app script runs. The terminal app reads
// localStorage hay_theme; sessions.html follows prefers-color-scheme (handled
// by context colorScheme below).
const DARK_INIT = `(() => { try {
  localStorage.setItem("hay_theme", "dark");
  localStorage.setItem("hay-syskb-seen", "1"); // suppress first-run KB hint overlay (it eats taps)
} catch (e) {} })();`;

async function sanitizeContext(context) {
  await context.addInitScript(DARK_INIT);
  await context.addInitScript(REWRITER);
  await context.route(
    (url) => url.pathname === "/api/sessions",
    async (route) => {
      try {
        if (route.request().method() !== "GET") return await route.continue();
        const resp = await route.fetch();
        let json;
        try { json = await resp.json(); } catch { return await route.fulfill({ response: resp }); }
        json.sessions = (json.sessions || []).filter((s) => ALLOWED.includes(s.name));
        json.active = (json.active || []).filter((n) => ALLOWED.includes(n));
        json.starting = (json.starting || []).filter((n) => ALLOWED.includes(n));
        json.aliases = {};
        json.folders = [];
        if (json.order) json.order = { folders: [], sessions: { root: [] } };
        return await route.fulfill({ response: resp, json });
      } catch {
        try { await route.abort(); } catch {}
      }
    }
  );
}

function cookie() {
  return {
    name: "tunnel_session", value: state.sessionSecret, domain: "127.0.0.1",
    path: "/", httpOnly: true, secure: false, sameSite: "Lax"
  };
}

// Returns { ctx, page, t0 } — t0 approximates the recording start (first
// video frame is captured when the page opens).
async function newRecordedPage(browser, { mobile = false, record = true, viewport = null, css = null } = {}) {
  const desktopVp = viewport || { width: 1920, height: 1080 };
  const opts = mobile
    ? { ...devices["iPhone 14"], colorScheme: "dark" }
    : { viewport: desktopVp, colorScheme: "dark" };
  if (record) {
    // Mobile size MUST match the device viewport (390x664) or the video gets
    // letterboxed with a gray band.
    opts.recordVideo = { dir: VID_TMP, size: mobile ? { width: 390, height: 664 } : desktopVp };
  }
  const ctx = await browser.newContext(opts);
  await ctx.addCookies([cookie()]);
  await sanitizeContext(ctx);
  if (css) await ctx.addInitScript(css); // e.g. NATIVE_CSS_INIT, installed pre-paint
  const page = await ctx.newPage();
  const t0 = Date.now();
  return { ctx, page, t0 };
}

// Verify an actual rendered frame is dark (mean luma) before recording the
// kept portion of a clip. Light theme frames average YAVG ~180-230; dark ~15-60.
async function assertDark(page, label) {
  const shot = path.join(VID_TMP, "dark-check.png");
  await page.screenshot({ path: shot });
  const r = spawnSync(FFMPEG, [
    "-i", shot, "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"
  ], { encoding: "utf8" });
  const m = (r.stdout + "\n" + r.stderr).match(/signalstats\.YAVG=([\d.]+)/);
  if (!m) throw new Error(`assertDark(${label}): could not measure YAVG`);
  const yavg = Number(m[1]);
  console.log(`assertDark(${label}): YAVG=${yavg.toFixed(1)}`);
  if (yavg > 100) throw new Error(`ABORT ${label}: frame is NOT dark (YAVG=${yavg.toFixed(1)})`);
}

// Save the context's recording, trimming trimSec off the head (page load,
// keyboard hiding, connect handshakes) via a VP9 re-encode.
async function saveVideo(page, clipName, trimSec = 0) {
  const video = page.video();
  try { await page.context().unrouteAll({ behavior: "ignoreErrors" }); } catch {}
  await page.context().close();
  const src = await video.path();
  const dest = path.join(OUT, `${clipName}.webm`);
  fs.mkdirSync(OUT, { recursive: true });
  if (trimSec > 0.05) {
    const r = spawnSync(FFMPEG, [
      "-y", "-ss", trimSec.toFixed(2), "-i", src,
      "-c:v", "libvpx-vp9", "-crf", "20", "-b:v", "0",
      "-cpu-used", "4", "-row-mt", "1", "-an", dest
    ], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg trim failed for ${clipName}: ${(r.stderr || "").slice(-500)}`);
  } else {
    fs.copyFileSync(src, dest);
  }
  fs.rmSync(src, { force: true });
  console.log(`saved ${dest} (head trimmed ${trimSec.toFixed(2)}s)`);
}

const trimFor = (t0, markerMs, padSec = 0.4) => Math.max(0, (markerMs - t0) / 1000 + padSec);

async function gotoSession(page, name, extraQuery = "") {
  await page.goto(`${state.localUrl}/s/${encodeURIComponent(name)}${extraQuery}`, {
    waitUntil: "networkidle", timeout: 30000
  });
  // Hard safety check: the page must be attached to the intended demo session.
  const room = await page.evaluate(() => window.__HOP_SESSION__ && window.__HOP_SESSION__.room);
  if (room !== name) {
    throw new Error(`SAFETY ABORT: page attached to room "${room}", expected "${name}"`);
  }
}

// Raw terminal write over the hop API (used to type into Lyra for the math clip).
async function apiWrite(terminalId, data) {
  await fetch(`${state.localUrl}/api/terminals/${encodeURIComponent(terminalId)}/write`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.sessionSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data })
  });
}
async function typeSlow(terminalId, text, delayMs = 55) {
  for (const ch of text) { await apiWrite(terminalId, ch); await sleep(delayMs); }
}

async function apiResize(terminalId, cols, rows) {
  await fetch(`${state.localUrl}/api/terminals/${encodeURIComponent(terminalId)}/resize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.sessionSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cols, rows })
  });
}

async function previewText(name) {
  const r = await fetch(`${state.localUrl}/api/sessions/preview?name=${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${state.sessionSecret}` }
  });
  try { return (await r.json()).text || ""; } catch { return ""; }
}

// Whitespace-insensitive matching: terminal wrapping inserts arbitrary line
// breaks (mid-word at narrow widths), so collapse all whitespace first.
const normalize = (s) => s.replace(/\s+/g, "");

async function sendTask(taskText) {
  const aurora = requireTerminalId("Aurora2");
  await apiWrite(aurora, taskText);
  await sleep(500);
  await apiWrite(aurora, "\r");
}

// Wait until visible screen content has grown by deltaChars over the given
// baseline — i.e. the agent is actually producing output.
async function waitOutputGrowth(baselineLen, deltaChars = 250, timeoutMs = 60000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const len = normalize(await previewText("Aurora2")).length;
    if (len > baselineLen + deltaChars) return true;
    await sleep(1000);
  }
  console.error("WARN: output growth gate timed out");
  return false;
}

// Natural-sounding tasks: the prompt echo is briefly on screen in 02, so the
// text must read like a real dev request, not staging directions. Each task
// asks for a long narration so the turn comfortably outlasts the streaming
// gates plus the kept dwell.
const TASK_02 =
  "Take a look around this workspace and give me the full tour: read README.md, index.html, and everything under scripts/ " +
  "and server/, then lay out what this project is and a concrete 6-step roadmap to make it production-ready. Narrate as you " +
  "go, one short paragraph per file, and keep the commentary flowing while you read — at least 1200 words before you wrap up.";

// 02b is dispatched as a FOLLOW-UP turn: the fresh-session welcome banner
// contains the real account email (canvas-rendered — the DOM rewriter cannot
// touch it), so the identity gates below require it to have scrolled off
// before anything is kept. Run a first narration turn (dispatch-task.mjs)
// if the agent session is fresh.
const TASK_02B =
  "Love it. Now the director's cut: narrate the full story of a day of real work inside hop — morning attach, " +
  "agents running in their rooms, a teammate dropping in from a phone, a restore after a laptop reboot — all in " +
  "the same flowing prose, at least 1100 words, no lists, don't stop to summarize, just keep the narration rolling.";

const TASK_03 =
  "Give the phone-reader's tour: re-read README.md, index.html, and each file under scripts/ and server/ one at a time, and " +
  "between reads narrate in short flowing paragraphs what each piece does and how they fit together — then close with the " +
  "three fixes you would ship first. At least 1300 words of narration, keep it flowing the whole way.";

// Two consecutive polls must each show the screen TAIL changing: a full
// screen scrolls at constant length, so compare content, not length. Detects
// steady streaming (not an API-retry stall, not a finished static screen).
async function waitSteadyStream(timeoutMs = 120000) {
  const t = Date.now();
  let prevTail = normalize(await previewText("Aurora2")).slice(-400);
  let hits = 0;
  while (Date.now() - t < timeoutMs) {
    await sleep(1500);
    const txt = await previewText("Aurora2");
    const tail = normalize(txt).slice(-400);
    if (txt.includes("Waiting for API response")) { hits = 0; }
    else if (tail !== prevTail) { hits += 1; if (hits >= 2) return true; }
    else hits = 0;
    prevTail = tail;
  }
  throw new Error("ABORT 03: agent never streamed steadily (stall or early finish)");
}

// CDP touch swipe for genuine mobile touch scrolling.
async function swipe(page, x, y0, y1, steps = 14, stepMs = 16) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    const y = y0 + ((y1 - y0) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await sleep(stepMs);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

// Swallow the synthetic click that follows a FAB touch tap so it cannot hit
// whatever renders beneath the FAB once the switcher overlay opens.
async function swallowNextClick(page) {
  await page.evaluate(() => {
    const swallow = (e) => {
      e.stopPropagation();
      e.preventDefault();
      document.removeEventListener("click", swallow, true);
    };
    document.addEventListener("click", swallow, true);
  });
}

async function tapFab(page) {
  const fab = await page.locator(".drawer-toggle").boundingBox();
  await swallowNextClick(page);
  await page.touchscreen.tap(fab.x + fab.width / 2, fab.y + fab.height / 2);
}

// Hide the mobile on-screen keyboard: FAB -> full-screen switcher -> header
// "Toggle keyboard" action (which hides the keyboard and closes the switcher).
// Asserts the keyboard is really gone afterwards.
async function hideKeyboard(page) {
  await tapFab(page);
  const toggle = page.locator('button[aria-label="Toggle keyboard"]');
  await toggle.waitFor({ state: "visible", timeout: 8000 });
  await sleep(700);
  await toggle.tap(); // plain tap: the button acts on its click event
  await sleep(1400);
  const hasKb = await page.evaluate(() =>
    !!document.querySelector(".session.has-keyboard") ||
    !!document.querySelector(".switcher-overlay"));
  if (hasKb) throw new Error("ABORT: keyboard (or switcher) still visible after toggle");
  console.log("keyboard hidden");
}

const clip = process.argv[2];
const browser = await chromium.launch({ headless: true, executablePath: CHROME });

try {
  if (clip === "02-agent-live") {
    // Recording rolls from page-open; the task is dispatched AFTER the desktop
    // client attaches, and the kept portion starts ~3s after fresh output is
    // visibly streaming (echo scrolled off). Head is trimmed away.
    const { page, t0 } = await newRecordedPage(browser, {});
    await gotoSession(page, "Aurora2");
    await sleep(1500);
    const baseline = normalize(await previewText("Aurora2")).length;
    await sendTask(TASK_02);
    await waitOutputGrowth(baseline, 250); // agent visibly producing output
    await sleep(3000); // ~3s of live streaming before the kept portion starts
    await assertDark(page, "02-agent-live");
    const marker = Date.now();
    await sleep(18000); // kept content; short enough to precede any usage banner
    await saveVideo(page, "02-agent-live", trimFor(t0, marker));

  } else if (clip === "02b-desktop-terminal") {
    // "Native local terminal" clip: 1600x1000 (16:10), ALL web chrome hidden
    // via document-start CSS (topbar/controls/footer/FAB), terminal frame
    // full-bleed. PTY pre-sized to the client's fit (185x46), and re-claimed
    // via REST right after the task write (API client is then the latest
    // typer, so the resize wins the election). Kept portion starts once fresh
    // output is visibly streaming; ~12s dwell, stops before any usage banner.
    const { page, t0 } = await newRecordedPage(browser, {
      viewport: { width: 1600, height: 1000 }, css: NATIVE_CSS_INIT
    });
    await gotoSession(page, "Aurora2");
    await sleep(1800);
    // Hard gate: no web chrome may be visible in the frame.
    const chromeVisible = await page.evaluate(() =>
      [".topbar", ".controls", ".terminal-footer", ".drawer-toggle", ".connection-banner"]
        .filter((sel) => {
          const el = document.querySelector(sel);
          return el && getComputedStyle(el).display !== "none";
        }));
    if (chromeVisible.length) throw new Error(`ABORT 02b: chrome visible: ${chromeVisible.join(", ")}`);
    const frameBox = await page.evaluate(() => {
      const r = document.querySelector(".terminal-frame").getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (frameBox.x !== 0 || frameBox.y !== 0 || frameBox.w !== 1600 || frameBox.h !== 1000) {
      throw new Error(`ABORT 02b: terminal not full-bleed: ${JSON.stringify(frameBox)}`);
    }
    // Pre-dispatch identity gate: the welcome banner (real email) must already
    // be scrolled off the visible screen before we even send the task.
    const preScreen = await previewText("Aurora2");
    for (const bad of SCREEN_FORBIDDEN) {
      if (preScreen.includes(bad)) throw new Error(`ABORT 02b: "${bad}" visible on screen pre-dispatch`);
    }
    await sendTask(TASK_02B);
    await apiResize(requireTerminalId("Aurora2"), 185, 46); // re-claim size election post-write
    // Streaming gate: the agent TUI footer shows "esc to interrupt" for the
    // whole active turn, and the screen tail must be visibly moving. (Length-
    // based growth gates are useless on a full screen — it scrolls at constant
    // length.) Marker fires as soon as prose is flowing so the 12.5s dwell
    // finishes well before the turn does.
    {
      const tGate = Date.now();
      let prevTail = normalize(await previewText("Aurora2")).slice(-600);
      let hits = 0, streaming = false;
      while (Date.now() - tGate < 90000) {
        await sleep(900);
        const txt = await previewText("Aurora2");
        const tail = normalize(txt).slice(-600);
        const active = txt.includes("esc to interrupt");
        if (active && tail !== prevTail) { hits += 1; } else { hits = 0; }
        prevTail = tail;
        if (hits >= 2) { streaming = true; break; }
      }
      if (!streaming) throw new Error("ABORT 02b: turn never streamed (stall or instant finish)");
    }
    // Final identity gate right before the kept portion.
    const liveScreen = await previewText("Aurora2");
    for (const bad of SCREEN_FORBIDDEN) {
      if (liveScreen.includes(bad)) throw new Error(`ABORT 02b: "${bad}" visible on screen pre-marker`);
    }
    await assertDark(page, "02b-desktop-terminal");
    const marker = Date.now();
    await sleep(12500); // kept content (~12s)
    // Still-streaming + identity check BEFORE saving: if the turn ended or a
    // forbidden string surfaced during the dwell, the take is bad — abort.
    const postScreen = await previewText("Aurora2");
    for (const bad of SCREEN_FORBIDDEN) {
      if (postScreen.includes(bad)) throw new Error(`RESHOOT 02b: "${bad}" appeared during kept portion`);
    }
    if (!postScreen.includes("esc to interrupt")) {
      throw new Error("RESHOOT 02b: turn ended during the kept portion (static tail frames)");
    }
    await saveVideo(page, "02b-desktop-terminal", trimFor(t0, marker));

  } else if (clip === "03-phone-live") {
    // The phone client's own fit never claims the PTY size in headless
    // capture, so force phone dimensions through the terminal API instead:
    // a REST resize issued right after an API write always wins the size
    // election (the API client is then the most recent typer). With the pty
    // at 46x40 the echo AND all narration render at clean phone width.
    const { page, t0 } = await newRecordedPage(browser, { mobile: true });
    await gotoSession(page, "Aurora2");
    await sleep(2000);
    await hideKeyboard(page); // must be hidden before the kept portion
    await sleep(1500);
    await sendTask(TASK_03);
    await apiResize(requireTerminalId("Aurora2"), 46, 40);
    // Gate only on steady live streaming and start the kept portion early:
    // waiting for the echo to scroll off a 40-row screen can eat the whole
    // turn with a fast model, leaving a finished static screen. The echo is a
    // real user message in natural language — fine if briefly visible.
    await waitSteadyStream();
    await sleep(3000);
    await assertDark(page, "03-phone-live");
    const marker = Date.now();
    await sleep(8000); // streaming dwell at phone width
    // Bounded touch scroll (keyboard hidden, so full height is usable):
    try {
      await swipe(page, 195, 250, 480); // scroll up ~230px (older output)
      await sleep(1500);
      await swipe(page, 195, 480, 250); // back toward bottom
      await sleep(900);
    } catch (e) {
      console.error("touch swipe failed, wheel fallback: " + e.message);
      await page.mouse.move(195, 400);
      await page.mouse.wheel(0, -300); await sleep(1800); await page.mouse.wheel(0, 300);
    }
    await sleep(3500);
    await saveVideo(page, "03-phone-live", trimFor(t0, marker));

  } else if (clip === "04-phone-switcher") {
    const { page, t0 } = await newRecordedPage(browser, { mobile: true });
    await gotoSession(page, "Lyra2");
    await sleep(2000);
    await hideKeyboard(page); // stays hidden through FAB -> switcher -> switch
    await sleep(800);
    // Phone-fit EVERY demo session's pty AFTER the recorded client attached
    // (the REST client is then the latest typer, so its size wins the
    // election — same trick as clip 03). Prevents the mobile view panning
    // and cropping the left text edge on a wide pty.
    for (const k of Object.keys(terminals)) {
      await apiResize(terminals[k].terminalId, 46, 40);
    }
    await sleep(2200);
    // Hard gate: every demo pty must actually report 46 cols.
    const sess = await (await fetch(`${state.localUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${state.sessionSecret}` }
    })).json();
    for (const k of Object.keys(terminals)) {
      const s = (sess.sessions || []).find((x) => x.name === k);
      if (!s || s.cols !== 46) {
        throw new Error(`ABORT 04: ${k} pty is ${s ? s.cols + "x" + s.rows : "missing"}, expected 46 cols`);
      }
    }
    await assertDark(page, "04-phone-switcher");
    const marker = Date.now();
    await sleep(2500); // settle on Lyra before the flow starts
    await tapFab(page);
    await sleep(3800); // hero previews load + refresh
    // Dismiss a stray long-press action sheet if one opened.
    if (await page.locator(".switcher-sheet-backdrop").isVisible().catch(() => false)) {
      const bd = await page.locator(".switcher-sheet-backdrop").boundingBox();
      await page.touchscreen.tap(bd.x + bd.width / 2, bd.y + 60);
      await sleep(800);
    }
    const card = page.locator(".switcher-card, .switcher-row", { hasText: "Aurora" }).first();
    const box = await card.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + Math.min(60, box.height / 2));
    await sleep(4500); // instant switch: agent TUI now visible
    const kbAfter = await page.evaluate(() => !!document.querySelector(".session.has-keyboard"));
    if (kbAfter) throw new Error("ABORT 04: keyboard reappeared after switch");
    await saveVideo(page, "04-phone-switcher", trimFor(t0, marker));

  } else if (clip === "05-presence") {
    const { page, t0 } = await newRecordedPage(browser, {});
    await gotoSession(page, "Lyra2", "?name=you");
    const { page: pageB, ctx: ctxB } = await newRecordedPage(browser, { record: false });
    await gotoSession(pageB, "Lyra2", "?name=Vega");
    // Gate: BOTH clients connected, EXACTLY the demo cast chips (you + Vega)
    // visible on the recorded page (ghost API chips hidden by the sanitizer),
    // and no Connecting/Reconnecting text anywhere in the recorded frame.
    const connected = async (p, needChips) => p.evaluate((need) => {
      const txt = document.body.innerText || "";
      if (txt.includes("Connecting") || txt.includes("Reconnecting")) return false;
      if (!need) return true;
      const chips = [...document.querySelectorAll(".presence-chip")]
        .filter((c) => getComputedStyle(c).display !== "none")
        .map((c) => (c.querySelector(".presence-name")?.textContent || "").trim());
      return chips.length === 2 && chips.includes("you") && chips.includes("Vega");
    }, needChips);
    const tGate = Date.now();
    while (Date.now() - tGate < 30000) {
      if ((await connected(page, true)) && (await connected(pageB, false))) break;
      await sleep(400);
    }
    if (!(await connected(page, true)) || !(await connected(pageB, false))) {
      throw new Error("ABORT 05: clients not both connected with chips within 30s");
    }
    await sleep(1200); // stability margin
    await assertDark(page, "05-presence");
    const marker = Date.now();
    await sleep(1500);
    await pageB.mouse.click(960, 500); // focus terminal on Vega's client
    await pageB.keyboard.type("echo hi from the train — Vega", { delay: 110 });
    await sleep(500);
    await pageB.keyboard.press("Enter");
    await sleep(1200);
    await pageB.keyboard.type("ls -1", { delay: 130 });
    await sleep(400);
    await pageB.keyboard.press("Enter");
    await sleep(3200);
    try { await ctxB.unrouteAll({ behavior: "ignoreErrors" }); } catch {}
    await ctxB.close();
    await saveVideo(page, "05-presence", trimFor(t0, marker));

  } else if (clip === "06-math") {
    const lyra = requireTerminalId("Lyra2");
    const { page, t0 } = await newRecordedPage(browser, {});
    await gotoSession(page, "Lyra2");
    await sleep(2200);
    await assertDark(page, "06-math");
    const marker = Date.now();
    await sleep(1200);
    await typeSlow(lyra, "./hop math 'e^{i\\pi} + 1 = 0'");
    await sleep(300); await apiWrite(lyra, "\r");
    await sleep(2200);
    await typeSlow(lyra, "./hop math '\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}'");
    await sleep(300); await apiWrite(lyra, "\r");
    await sleep(3500);
    await saveVideo(page, "06-math", trimFor(t0, marker));

  } else if (clip === "07-theme") {
    const { page, t0 } = await newRecordedPage(browser, {});
    await gotoSession(page, "Aurora2");
    await sleep(2500);
    await assertDark(page, "07-theme"); // starts dark
    const themeRow = page.locator(".drawer-row", { hasText: "Theme" });
    if (!(await themeRow.first().isVisible().catch(() => false))) {
      await page.click(".drawer-toggle");
      await sleep(1800);
    }
    const marker = Date.now();
    await sleep(1200);
    // Dark -> Light -> Dark: shows the flip both ways, starts AND ends dark.
    await themeRow.getByRole("button", { name: "Light" }).click();
    await sleep(2200);
    await themeRow.getByRole("button", { name: "Dark" }).click();
    await sleep(2400);
    await saveVideo(page, "07-theme", trimFor(t0, marker));

  } else if (clip === "01-sessions") {
    const { page, t0 } = await newRecordedPage(browser, {});
    await page.goto(`${state.localUrl}/sessions`, { waitUntil: "networkidle", timeout: 30000 });
    await sleep(2800);
    await assertDark(page, "01-sessions"); // sessions.html via colorScheme dark
    const marker = Date.now();
    await sleep(1000);
    // The rename dialog prefills the INPUT's .value with the internal name
    // ("Lyra2"); property writes bypass the MutationObserver rewriter, so shim
    // promptModal to show the display name. The rename POST still uses the
    // real oldName ("Lyra2") from renameSession's own argument.
    await page.evaluate(() => {
      const orig = window.promptModal;
      window.promptModal = (opts) =>
        orig({ ...opts, value: opts.value === "Lyra2" ? "Lyra" : opts.value });
    });
    const row = page.locator(".session-item-wrapper", { hasText: "Lyra" });
    await row.hover();
    await sleep(700);
    await row.locator('.row-action[title="Rename"]').click();
    await sleep(1200);
    await page.keyboard.type("Vega", { delay: 140 });
    await sleep(700);
    await page.click("#modalConfirmBtn");
    await sleep(3200);
    await saveVideo(page, "01-sessions", trimFor(t0, marker));

  } else {
    console.error("unknown clip: " + clip);
    process.exit(1);
  }
} finally {
  await browser.close();
}
