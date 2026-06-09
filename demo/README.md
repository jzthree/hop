# Hop Demo Harness

Small reusable pieces for recording real Hop browser footage and driving real Hop terminals.

## What This Is

- `record-hop-view.mjs` records the Hop browser UI with Playwright
- `drive-hop-terminal.mjs` creates or attaches to a terminal over Hop's local API and sends input
- `director.mjs` runs the first single-agent 30s capture flow end to end
- `static-preview-server.mjs` serves the sanitized demo workspace for preview clips
- `stitch-demo-video.mjs` concatenates recorded WebM clips into one rough MP4
- `hop-demo-lib.mjs` holds the shared state, auth, browser, and API helpers

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

## Notes

- The current scripts are intentionally small. The new `director.mjs` is still a thin orchestrator, not a large demo framework.
- Desktop recording now defaults to `1920x1080`. Mobile clips are normalized onto the same canvas during stitching.
- The default showcase flow now records a filtered session picker, the live agent terminal, a follow-up redirect clip, a preview-app clip through a Hop port session, and a mobile clip.
- `stitch-demo-video.mjs` now overlays short captions by default. Use `--overlay-captions false` to disable that.
- For a deterministic product video, prefer recording short clips and stitching them together rather than relying on one perfect live take.
