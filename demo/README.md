# Hop Demo Harness

Small reusable pieces for recording real Hop browser footage and driving real Hop terminals.

## What This Is

- `record-hop-view.mjs` records the Hop browser UI with Playwright
- `drive-hop-terminal.mjs` creates or attaches to a terminal over Hop's local API and sends input
- `director.mjs` runs the first single-agent 30s capture flow end to end
- `static-preview-server.mjs` serves the sanitized demo workspace for preview clips
- `stitch-demo-video.mjs` concatenates recorded WebM clips into one rough MP4
- `hop-demo-lib.mjs` holds the shared state, auth, browser, and API helpers
- `capture/` holds the sanitized product-video capture rig (see [Capture Rig](#capture-rig-democapture) below)

The harness uses the local Hop daemon port from `~/.hop2/.tunnel-state` and injects the Hop session cookie directly into Playwright. That avoids interactive login during capture while still exercising the real Hop UI.

For production demos, `director.mjs` now uses a sanitized workspace and filters non-demo sessions out of the captured UI so the recording does not show your normal session list, username, hostname, or personal directory path. Starting from an isolated Hop home is supported as an opt-in experiment with `--start-daemon true`.

## Prerequisites

- Hop daemon is running
- `codex` or another terminal program is already installed if you want to demo an agent
- Homebrew Node is available at `/opt/homebrew/bin/node`
- Playwright is available from the vendored Hay workspace

## Basic Examples

Create or attach a terminal and run a command:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/drive-hop-terminal.mjs \
  --name demo-agent \
  --cwd "$PWD" \
  --exec "printf 'hello from hop demo\\n'"
```

Wait for output after starting a program:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/drive-hop-terminal.mjs \
  --name demo-agent \
  --cwd "$PWD" \
  --exec "codex" \
  --wait-timeout 15000
```

Record the session picker:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/record-hop-view.mjs \
  --out demo-output/sessions \
  --duration 3000
```

Record one terminal session:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/record-hop-view.mjs \
  --session demo-agent \
  --out demo-output/demo-agent \
  --duration 8000
```

Record a mobile-sized view:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/record-hop-view.mjs \
  --session demo-agent \
  --mobile true \
  --out demo-output/demo-agent-mobile \
  --duration 5000
```

Run the first end-to-end single-agent capture flow:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/director.mjs \
  --name demo-agent \
  --preset landing-page \
  --launch "codex" \
  --out demo-output/run-01
```

Stitch the recorded clips into a rough cut:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/stitch-demo-video.mjs \
  --in demo-output/run-01 \
  --out demo-output/run-01/hop-demo-rough.mp4
```

## Suggested 30s Demo Flow

1. Record `/sessions`
2. Start a dedicated `codex` terminal with `drive-hop-terminal.mjs`
3. Record the live session page while Codex works
4. Send a second instruction into the same terminal
5. Record a mobile view of the same session
6. Stitch the clips with `ffmpeg`

## Capture Rig (`demo/capture/`)

The capture rig records the sanitized, dark-theme live-footage clips used in the Hop product video. It drives the real Hop UI in headless Chrome with two sanitization layers installed before first paint: `/api/sessions` responses are filtered down to the demo session cast, and a document-start MutationObserver rewrites the internal session names (`Aurora2` → `Aurora`, `Lyra2` → `Lyra`, …) in every text node and attribute. Before the kept portion of each clip it asserts a genuinely dark rendered frame (ffmpeg signalstats) and that no identity strings (account email banner, home directory, username) are visible; it aborts rather than save a bad take. Recording starts at page open and the setup head is trimmed off with ffmpeg on save.

### Files

- `capture/capture.mjs` — the clip driver. `node demo/capture/capture.mjs <clip>` with `<clip>` one of `01-sessions`, `02-agent-live`, `02b-desktop-terminal`, `03-phone-live`, `04-phone-switcher`, `05-presence`, `06-math`, `07-theme`
- `capture/setup-sessions.mjs` — creates the sanitized shell cast (`Lyra2`, `Nebula2`, `Polaris2`) with a clean `env -i` bash, wiped scrollback, and live ticker output, and seeds the demo workspace tree
- `capture/setup-04.mjs` — recreates all four demo sessions phone-fit (46x40) for the `04-phone-switcher` clip, with a scripted agent-lookalike ticker in `Aurora2` instead of a real agent
- `capture/spawn-aurora.mjs` — spawns a real coding agent (default `claude`, override with `HOP_CAPTURE_AGENT`) in session `Aurora2` via the Hop MCP server
- `capture/dispatch-task.mjs` — sends a narration task to the `Aurora2` agent and waits until the identity banner has scrolled off the visible screen
- `capture/capture-env.mjs` — shared configuration: paths, env overrides, the demo cast, forbidden identity strings, and `terminals.json` helpers
- `capture/mcp-client.mjs` — minimal stdio MCP client for `mcp/hop-mcp.js`
- `capture/native-css.mjs` — document-start CSS that hides all web chrome for the `02b-desktop-terminal` "native terminal" clip
- `capture/tools/*.sh` — endless sanitized ticker scripts (build, metrics, agent-lookalike) that keep switcher preview cards alive

### Prerequisites

Same as above (running Hop daemon, Google Chrome, vendored Playwright, Homebrew Node), plus `ffmpeg` and — for the live-agent clips — a `claude`-style agent CLI on `PATH`.

### Configuration

Everything machine-specific is an env override with a macOS default (see `capture/capture-env.mjs`):

- `HOP_HOME` — hop state directory (default `~/.hop2`)
- `HOP_CAPTURE_ROOT` — sanitized demo tree: workspace, ticker scripts, fake `$HOME`, raw recordings, `terminals.json` (default `/tmp/hop-demo`)
- `HOP_CAPTURE_OUT` — where finished clips land (default `demo-output/footage/live` in the repo)
- `HOP_CAPTURE_CHROME`, `HOP_CAPTURE_FFMPEG` — binary paths
- `HOP_CAPTURE_AGENT` — command launched in `Aurora2` by `spawn-aurora.mjs` (default `claude`)
- `HOP_CAPTURE_FORBIDDEN` — extra comma-separated strings that must never appear in a kept frame, on top of the built-in home-directory/username/welcome-banner checks

### Typical run

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/capture/setup-sessions.mjs
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/capture/spawn-aurora.mjs

PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/capture/capture.mjs 01-sessions
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/capture/capture.mjs 02-agent-live
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/capture/capture.mjs 03-phone-live
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/capture/capture.mjs 05-presence
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/capture/capture.mjs 06-math
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/capture/capture.mjs 07-theme

# Clip 04 uses its own phone-fit session setup:
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/capture/setup-04.mjs
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/capture/capture.mjs 04-phone-switcher
```

Notes on ordering: `02b-desktop-terminal` must run against an agent session whose welcome banner has already scrolled off — dispatch a first narration turn with `dispatch-task.mjs` (or run `02-agent-live` first). A clip that would show a leak, a light frame, or a finished/static screen aborts with `ABORT`/`RESHOOT` instead of saving; rerun it. Rerunning `setup-sessions.mjs` after `setup-04.mjs` restores the desktop-width cast, but `Aurora2` needs `spawn-aurora.mjs` again since `setup-04.mjs` replaces the real agent with a ticker.

## Notes

- The current scripts are intentionally small. The new `director.mjs` is still a thin orchestrator, not a large demo framework.
- Desktop recording now defaults to `1920x1080`. Mobile clips are normalized onto the same canvas during stitching.
- The default showcase flow now records a filtered session picker, the live agent terminal, a follow-up redirect clip, a preview-app clip through a Hop port session, and a mobile clip.
- `stitch-demo-video.mjs` now overlays short captions by default. Use `--overlay-captions false` to disable that.
- For a deterministic product video, prefer recording short clips and stitching them together rather than relying on one perfect live take.
