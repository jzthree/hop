#!/usr/bin/env node
// lib/markdown.js is GENERATED from the web app's parser,
// hay/apps/web/src/utils/markdown.ts — one set of markdown rules for the
// web app's prose (Answers, the digest, the pulse) and the daemon's
// markdown views. Edit the .ts, then run:
//
//   node scripts/gen-markdown-lib.mjs
//
// The banner carries the source's hash; a web test fails when the two drift.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcPath = join(root, "hay/apps/web/src/utils/markdown.ts");
const outPath = join(root, "lib/markdown.js");
const esbuild = createRequire(join(root, "hay/apps/web/package.json"))("esbuild");

const src = readFileSync(srcPath, "utf8");
const hash = createHash("sha256").update(src).digest("hex").slice(0, 16);
const { code } = esbuild.transformSync(src, { loader: "ts", format: "cjs", target: "node16", platform: "node" });
const banner = [
  "// GENERATED from hay/apps/web/src/utils/markdown.ts — do not edit here.",
  "// Edit the .ts and run `node scripts/gen-markdown-lib.mjs`.",
  `// source-sha256: ${hash}`,
  ""
].join("\n");
writeFileSync(outPath, banner + code);
console.log(`wrote lib/markdown.js (source ${hash})`);
