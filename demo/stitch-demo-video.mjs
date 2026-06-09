import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "./hop-demo-lib.mjs";

const DEFAULT_CAPTIONS = {
  "01-sessions": "Terminal access for humans and agents",
  "02-agent-live": "Watch the agent work live",
  "03-agent-redirect": "Interrupt. Redirect. Continue.",
  "04-preview": "Preview through the same tunnel",
  "04-mobile": "Reconnect from anywhere",
  "05-mobile": "Reconnect from anywhere"
};

function findClipFiles(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const clips = [];
  for (const entry of entries) {
    const dir = path.join(rootDir, entry.name);
    const file = fs.readdirSync(dir)
      .find((name) => name.endsWith(".webm"));
    if (!file) continue;
    clips.push({
      name: entry.name,
      path: path.join(dir, file)
    });
  }
  return clips;
}

function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,");
}

const args = parseArgs(process.argv.slice(2));
const clipsDir = path.resolve(args.in || args.input || path.join("demo-output"));
const output = path.resolve(args.out || path.join(clipsDir, "hop-demo-rough.mp4"));
const ffmpeg = args.ffmpeg || "/opt/homebrew/bin/ffmpeg";
const targetWidth = Number(args.width || 1920);
const targetHeight = Number(args.height || 1080);
const overlayCaptions = args["overlay-captions"] === "false" ? false : true;
const clips = findClipFiles(clipsDir);

if (clips.length === 0) {
  throw new Error(`No .webm clips found under ${clipsDir}`);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
const tempRoot = path.join(os.tmpdir(), `hop-demo-stitch-${Date.now()}`);
fs.mkdirSync(tempRoot, { recursive: true });
const normalized = [];

for (let index = 0; index < clips.length; index += 1) {
  const clip = clips[index];
  const normalizedPath = path.join(tempRoot, `${String(index + 1).padStart(2, "0")}-${clip.name}.mp4`);
  const filterParts = [
    `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease`,
    `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black`,
    "fps=30"
  ];
  const caption = DEFAULT_CAPTIONS[clip.name];
  if (overlayCaptions && caption) {
    filterParts.push(
      `drawtext=text='${escapeDrawtext(caption)}':fontcolor=white:fontsize=48:box=1:boxcolor=0x00000088:boxborderw=18:x=(w-text_w)/2:y=h-120`
    );
  }
  const normalize = spawnSync(ffmpeg, [
    "-y",
    "-i", clip.path,
    "-vf",
    filterParts.join(","),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-an",
    normalizedPath
  ], {
    stdio: "inherit"
  });
  if (normalize.status !== 0) {
    throw new Error(`ffmpeg normalization failed for ${clip.path}`);
  }
  normalized.push({
    name: clip.name,
    path: normalizedPath
  });
}

const concatFile = path.join(tempRoot, "concat.txt");
fs.writeFileSync(
  concatFile,
  `${normalized.map((clip) => `file '${clip.path.replace(/'/g, "'\\''")}'`).join("\n")}\n`
);

const result = spawnSync(ffmpeg, [
  "-y",
  "-f", "concat",
  "-safe", "0",
  "-i", concatFile,
  "-c", "copy",
  "-movflags", "+faststart",
  output
], {
  stdio: "inherit"
});

if (result.status !== 0) {
  throw new Error(`ffmpeg failed with exit code ${result.status}`);
}

console.log(JSON.stringify({
  ok: true,
  output,
  clips: normalized,
  canvas: {
    width: targetWidth,
    height: targetHeight
  },
  overlayCaptions
}, null, 2));
