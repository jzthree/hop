import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// A short build stamp (git short hash + date) baked in at build time, surfaced
// in the drawer so "which web bundle is this device running?" is readable at a
// glance instead of an unfalsifiable cache debate.
const buildStamp = (() => {
  let hash = "dev";
  try {
    hash = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    /* not a git checkout */
  }
  const date = new Date().toISOString().slice(0, 10);
  return `${hash} · ${date}`;
})();

export default defineConfig(() => ({
  plugins: [react()],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp)
  },
  server: {
    port: 5173
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
}));
