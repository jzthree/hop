// Assemble the product video from a storyboard: live clips, illustration
// stills with a slow push-in, title cards, and captions in the house style.
//
//   node demo/assemble-video.mjs --storyboard demo/storyboards/v3.json \
//        --out demo-output/hop-v3-rough.mp4 [--no-captions] [--only 11-panes]
//
// Why this exists: the homebrew ffmpeg has no drawtext, and the March-era
// stitcher could only concatenate clips. Captions and cards are rendered by
// the same Chromium the rig records with, so they use real CSS typography —
// the monospace kicker + sentence caption of the README illustrations — and
// are composited as transparent PNG overlays. Stills come from the SVGs in
// docs/, rendered at 2x so the push-in stays crisp.
//
// Storyboard shape (JSON):
//   { "width": 1920, "height": 1080, "fps": 30,
//     "segments": [
//       { "id": "00-wall", "type": "clip", "src": "demo-output/footage/live/00-wall.webm",
//         "start": 0, "duration": 12, "speed": 1,
//         "caption": { "kicker": "01 · THE WALL", "text": "Every terminal, one wall." } },
//       { "id": "04-mobile", "type": "still", "src": "docs/hero-mobile.svg", "duration": 8,
//         "push": 1.10, "caption": {...} },
//       { "id": "06-close", "type": "card", "duration": 4,
//         "title": "hop — terminals for humans + agents", "subtitle": "github.com/jzthree/hop" }
//     ] }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "../hay/node_modules/playwright/index.mjs";
import { parseArgs } from "./hop-demo-lib.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, "..");
const FFMPEG = process.env.HOP_CAPTURE_FFMPEG || "/opt/homebrew/bin/ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg$/, "ffprobe");

const args = parseArgs(process.argv.slice(2));
const storyboardPath = path.resolve(args.storyboard || path.join(HERE, "storyboards", "v3.json"));
const board = JSON.parse(fs.readFileSync(storyboardPath, "utf8"));
const W = Number(board.width || 1920);
const H = Number(board.height || 1080);
const FPS = Number(board.fps || 30);
const captions = args["no-captions"] === undefined && args.captions !== "false";
const only = typeof args.only === "string" ? args.only.split(",") : null;
const output = path.resolve(args.out || path.join(REPO, "demo-output", `${path.basename(storyboardPath, ".json")}.mp4`));
const work = path.join(os.tmpdir(), `hop-assemble-${Date.now()}`);
fs.mkdirSync(work, { recursive: true });

const BG = "#101116";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const run = (bin, argv, label) => {
  const r = spawnSync(bin, argv, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${label} failed (${r.status}):\n${(r.stderr || "").slice(-1500)}`);
  }
  return r;
};
const probeDuration = (file) => {
  const r = run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], "ffprobe");
  return Number(String(r.stdout).trim()) || 0;
};
const resolveSrc = (p) => (path.isAbsolute(p) ? p : path.resolve(REPO, p));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Chromium renders: stills, cards, caption overlays ──────────────────
let browser = null;
const page = async (opts) => {
  if (!browser) browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, ...opts });
  return { ctx, page: await ctx.newPage() };
};
const shoot = async (html, out, { transparent = false } = {}) => {
  const { ctx, page: p } = await page({});
  await p.setContent(html, { waitUntil: "load" });
  await p.waitForTimeout(150);
  await p.screenshot({ path: out, omitBackground: transparent, type: "png" });
  await ctx.close();
};

// An SVG (or PNG) centred on the dark canvas, filling the frame's height
// with a little breathing room, rendered at 2x for the push-in.
const renderStill = async (seg, out) => {
  const src = resolveSrc(seg.src);
  const data = fs.readFileSync(src);
  const mime = src.endsWith(".svg") ? "image/svg+xml" : "image/png";
  const uri = `data:${mime};base64,${data.toString("base64")}`;
  const inset = Number(seg.inset ?? 0.94);
  await shoot(`<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:${BG};display:flex;align-items:center;justify-content:center;">
    <img src="${uri}" style="height:${Math.round(H * inset)}px;max-width:${Math.round(W * inset)}px;width:auto;display:block;"/>
  </body></html>`, out);
};

// Title / end card: the March cut's look — one monospace line, a muted
// second line, nothing else.
const renderCard = async (seg, out) => {
  await shoot(`<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:${BG};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;font-family:${MONO};">
    ${seg.kicker ? `<div style="font-size:22px;letter-spacing:0.16em;color:#8d909b;">${esc(seg.kicker)}</div>` : ""}
    <div style="font-size:${seg.titleSize || 56}px;color:#e6e6e9;">${esc(seg.title || "")}</div>
    ${seg.subtitle ? `<div style="font-size:28px;color:#93939b;">${esc(seg.subtitle)}</div>` : ""}
  </body></html>`, out);
};

// Caption overlay: transparent frame with a kicker (small, purple, spaced
// capitals — the illustration kicker) over one sentence in a dark pill,
// bottom-centre, clear of the terminal's own footer.
const renderCaption = async (cap, out) => {
  // A portrait clip (the phone) sits in the middle of the frame: its caption
  // goes BESIDE it (cap.side = "left" | "right"), not across it.
  const pill = `font-size:${cap.size || 33}px;color:#e6e6e9;background:rgba(23,24,29,0.97);border:1px solid #2e3038;border-radius:12px;padding:14px 26px;box-shadow:0 8px 30px rgba(0,0,0,.45);line-height:1.35;`;
  const kicker = cap.kicker ? `<div style="font-size:17px;letter-spacing:0.18em;color:#a78bfa;text-shadow:0 1px 2px rgba(0,0,0,.8);">${esc(cap.kicker)}</div>` : "";
  const body = cap.side
    ? `<div style="position:absolute;top:50%;transform:translateY(-50%);${cap.side === "right" ? "right" : "left"}:${Math.round(W * 0.06)}px;width:${Math.round(W * 0.30)}px;display:flex;flex-direction:column;align-items:flex-start;gap:12px;">
        ${kicker}
        <div style="${pill}text-align:left;">${esc(cap.text)}</div>
      </div>`
    : `<div style="position:absolute;left:0;right:0;bottom:${cap.bottom ?? 64}px;display:flex;flex-direction:column;align-items:center;gap:10px;">
        ${kicker}
        <div style="${pill}max-width:${Math.round(W * 0.8)}px;text-align:center;">${esc(cap.text)}</div>
      </div>`;
  await shoot(`<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;background:transparent;position:relative;font-family:${MONO};">${body}</body></html>`, out, { transparent: true });
};

// ── Segment normalisation: every piece becomes W×H, FPS, yuv420p, no audio ──
const filtersFit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:0x101116,fps=${FPS},format=yuv420p`;

const encodeArgs = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart"];

const withOverlay = (overlayPng, dur) => {
  if (!overlayPng) return { inputs: [], chain: "" };
  return {
    inputs: ["-loop", "1", "-t", dur.toFixed(3), "-i", overlayPng],
    // Fade the caption in over the first 0.35s and out over the last 0.5s.
    chain: `[ov]scale=${W}:${H},format=rgba,fade=t=in:st=0:d=0.35:alpha=1,fade=t=out:st=${Math.max(0, dur - 0.5).toFixed(2)}:d=0.5:alpha=1[ovf];[v][ovf]overlay=0:0:shortest=1`
  };
};

const normalizeSegment = async (seg, index) => {
  const id = seg.id || `seg-${index}`;
  const out = path.join(work, `${String(index + 1).padStart(2, "0")}-${id}.mp4`);
  const captionPng = captions && seg.caption?.text ? path.join(work, `${id}-caption.png`) : null;
  if (captionPng) await renderCaption(seg.caption, captionPng);

  if (seg.type === "clip") {
    const src = resolveSrc(seg.src);
    if (!fs.existsSync(src)) throw new Error(`clip not found: ${src}`);
    const start = Number(seg.start || 0);
    const speed = Number(seg.speed || 1);
    const avail = Math.max(0, (probeDuration(src) - start) / speed);
    const dur = Math.min(Number(seg.duration || avail), avail || Number(seg.duration || 0));
    const ov = withOverlay(captionPng, dur);
    const vchain = `[0:v]${speed !== 1 ? `setpts=PTS/${speed},` : ""}${filtersFit}[v]`;
    const fc = ov.chain ? `${vchain};[1:v]copy[ov];${ov.chain}` : `${vchain}`;
    run(FFMPEG, [
      "-y", "-ss", start.toFixed(3), "-i", src, ...ov.inputs,
      "-filter_complex", fc, ...(ov.chain ? [] : ["-map", "[v]"]),
      "-t", dur.toFixed(3), ...encodeArgs, out
    ], `normalize ${id}`);
    return { id, path: out, duration: dur };
  }

  if (seg.type === "still" || seg.type === "card") {
    const png = path.join(work, `${id}-frame.png`);
    if (seg.type === "still") await renderStill(seg, png);
    else await renderCard(seg, png);
    const dur = Number(seg.duration || 6);
    const frames = Math.round(dur * FPS);
    // The push-in: a slow zoom from 1.0 to `push` (1.0 = static card),
    // centred, evaluated on the 2x render so it never goes soft.
    const push = seg.type === "still" ? Number(seg.push ?? 1.08) : Number(seg.push ?? 1);
    const zoomExpr = push > 1
      ? `zoompan=z='1+(${(push - 1).toFixed(4)})*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`
      : `scale=${W}:${H},fps=${FPS}`;
    const ov = withOverlay(captionPng, dur);
    const vchain = `[0:v]${zoomExpr},format=yuv420p[v]`;
    const fc = ov.chain ? `${vchain};[1:v]copy[ov];${ov.chain}` : vchain;
    run(FFMPEG, [
      "-y", "-loop", "1", "-framerate", String(FPS), "-i", png, ...ov.inputs,
      "-filter_complex", fc, ...(ov.chain ? [] : ["-map", "[v]"]),
      "-t", dur.toFixed(3), ...encodeArgs, out
    ], `render ${id}`);
    return { id, path: out, duration: dur };
  }
  throw new Error(`unknown segment type for ${id}: ${seg.type}`);
};

// ── Main ───────────────────────────────────────────────────────────────
const segments = board.segments.filter((s) => !only || only.includes(s.id));
if (!segments.length) throw new Error("no segments selected");
const pieces = [];
for (let i = 0; i < segments.length; i += 1) {
  const seg = segments[i];
  process.stdout.write(`[${i + 1}/${segments.length}] ${seg.id} (${seg.type}) … `);
  const piece = await normalizeSegment(seg, i);
  console.log(`${piece.duration.toFixed(1)}s`);
  pieces.push(piece);
}
if (browser) await browser.close();

// Concatenate (identical encodes → stream copy), then one pass for the
// fade-in / fade-out so the cut opens and closes on the canvas colour.
const concatList = path.join(work, "concat.txt");
fs.writeFileSync(concatList, pieces.map((p) => `file '${p.path.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
const joined = path.join(work, "joined.mp4");
run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", joined], "concat");
const total = pieces.reduce((a, p) => a + p.duration, 0);
fs.mkdirSync(path.dirname(output), { recursive: true });
run(FFMPEG, [
  "-y", "-i", joined,
  "-vf", `fade=t=in:st=0:d=0.6,fade=t=out:st=${Math.max(0, total - 0.9).toFixed(2)}:d=0.9`,
  ...encodeArgs, output
], "final");

console.log(JSON.stringify({
  ok: true,
  output,
  duration: Number(total.toFixed(2)),
  segments: pieces.map((p) => ({ id: p.id, duration: Number(p.duration.toFixed(2)) })),
  captions,
  work
}, null, 2));
