# Hop + Hay Architecture

This document describes the current Hop terminal architecture.

The historical `ttyd`/`tmux` backend has been removed from the active runtime.
Hop now uses Hay, a local terminal-sharing stack built on WebSocket plus
`node-pty`, with browser, CLI, and MCP clients all operating on the same
session model.

## Current Stack

```
Browser / Hay CLI / Hop MCP
            |
            v
        Hop daemon
            |
            v
     local hay-host process
            |
            v
      Hay room manager
            |
            v
         node-pty
            |
            v
           shell
```

Key properties:

- No `ttyd` dependency
- No `tmux` dependency
- Shared session model across browser, CLI, and MCP
- Session-aware audit logging and history isolation
- Native mobile UI and virtual keyboard support
- Local host process survives hop daemon restarts

## Main Components

- `hop`
  - user-facing CLI and daemon
  - auth, Cloudflare tunnel management, session metadata, workspace handling
  - serves the built Hay web client from `hay-web/`
- `scripts/hay-host.js`
  - persistent local host process for active Hay rooms
  - isolates PTY/runtime ownership from the daemon lifecycle
- `hay/apps/server`
  - room manager, PTY lifecycle, websocket protocol handling
- `hay/apps/web`
  - browser terminal client
- `hay/apps/cli`
  - local terminal client used by Hop for direct attach flows
- `mcp/hop-mcp.js`
  - MCP server exposing Hop terminal/session primitives

## Session Model

- Terminal sessions are identified by stable Hop session names.
- MCP attaches to daemon-scoped terminal handles, but can recover across daemon
  restart by reattaching through the stable session identity.
- Active PTYs live in Hay rooms managed by the host process.
- Browser users, local CLI attaches, and agents all talk to the same underlying
  room runtime.

## Build Outputs

- `hay/apps/web/dist/` is the source web build output.
- `hay-web/` is the synced bundle served by `hop`.
- `npm run build` from the repo root rebuilds Hay and syncs `hay-web/`.

## Operational Notes

- Hop always uses the external Hay host runtime.
- `HOP_TERMINAL_BACKEND` is accepted only for compatibility and ignored.
- Session history and audit logging are per-session and workspace-aware.
- Alternate-screen/TUI applications are captured with TUI-aware audit behavior.

## Legacy Notes

The earlier `ttyd`/`tmux` approach is now only historical context.
If you see older references in commit history or archived notes, treat them as
obsolete unless the current code still uses them explicitly.
