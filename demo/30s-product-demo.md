# 30s Product Demo Runbook

This is the first concrete demo built on top of the small Hop demo harness.

## Goal

Show that Hop can:

1. host a visible subagent terminal
2. let the human watch and steer it live
3. expose the resulting app through the same runtime
4. reconnect cleanly on mobile

## Recommended Structure

### Clip 1: Session picker

Duration: 2 to 3 seconds

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/record-hop-view.mjs \
  --out demo-output/clip-01-sessions \
  --duration 2500
```

Use this under the caption:

`Terminal access for humans and agents`

### Clip 2: Start a dedicated agent terminal

Create or attach a named session that will hold the agent:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/drive-hop-terminal.mjs \
  --name demo-agent \
  --cwd "$PWD"
```

Then launch `codex` in that session with your preferred flags. For now this is still better driven explicitly rather than hidden behind another wrapper.

### Clip 3: Record live terminal work

Once Codex is working in `demo-agent`, record the session page:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/record-hop-view.mjs \
  --session demo-agent \
  --out demo-output/clip-03-agent \
  --duration 8000
```

Suggested caption:

`Watch every step in real time`

### Clip 4: Redirect mid-run

Send a second instruction into the same session while it is still running, then record a short follow-up clip.

Suggested caption:

`Interrupt. Redirect. Continue.`

### Clip 5: Record mobile view

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/node demo/record-hop-view.mjs \
  --session demo-agent \
  --mobile true \
  --out demo-output/clip-05-mobile \
  --duration 4000
```

Suggested caption:

`Check progress from anywhere`

### Clip 6: Optional second agent tease

Repeat the same flow with a second session such as `demo-reviewer` and end on a very short two-agent tease.

Keep this to 2 to 3 seconds. It should feel like a promise, not a second full story.

## Editing Notes

- Prefer 5 to 8 second source clips, then trim aggressively
- Use hard cuts, not slow transitions
- Do not show login unless the login flow itself is the product being demoed
- Keep text overlays short and concrete
- Avoid dense terminal text overlays; let the UI and motion carry the demo

## Current State

- Browser recording works
- Mobile recording works
- Local API terminal creation works
- The current driver is good enough to bootstrap sessions, but it is not yet a full turn-by-turn subagent director
