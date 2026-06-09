# Hay

> Looking for the full remote-terminal product? See [hop](https://github.com/jzthree/hop).

Hay is the terminal-sharing stack that powers Hop. It provides the local room
manager, browser client, CLI client, and shared protocol layer used for
multi-client terminal sessions.

This workspace is primarily internal to the Hop repo. It is useful on its own
for development and architecture work, but it is not documented here as a
published standalone npm product.

## What Hay Provides

- Shared PTY-backed terminal rooms
- Browser and local CLI clients
- Presence and collaboration state
- Mobile-oriented web terminal UI
- A reusable WebSocket + PTY server layer for embedding

Hay intentionally does not provide:

- Authentication
- Tunneling / remote exposure
- User management
- Hop session/workspace metadata

Those concerns live at the Hop layer.

## Workspace Layout

```text
hay/
├── apps/
│   ├── server/     # Room manager, PTY lifecycle, websocket integration
│   ├── web/        # React + xterm.js browser client
│   └── cli/        # Local terminal client
└── packages/
    └── shared/     # Shared protocol types and utilities
```

## Development

From `hay/`:

```bash
npm install
npm run dev
```

Useful commands:

- `npm run build`
- `npm run test`
- `npm -w apps/web run test:e2e`

## CLI Client

Run the local CLI client from the workspace:

```bash
npm -w apps/cli run dev -- -r my-room -n alice
```

After building:

```bash
node apps/cli/dist/index.js -r my-room -n alice
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` `→` `↑` `↓` | Pan viewport |
| `0` | Center on cursor |
| `A` | Auto-fit viewport to content |
| `B` | Toggle status bar |
| `M` | Toggle mouse capture (off by default, so terminal context menus keep working) |
| `Ctrl+T` | Toggle hints bar |
| `Ctrl+G` | Detach from session; the session keeps running |
| `Ctrl+Q` | Kill session |

Local sessions are persistent by default: they keep running in the Hay host if
the local CLI detaches or the Hop daemon restarts. Use `Ctrl+Q` to end the
session itself.

When the viewport is at the bottom, the CLI follows new output automatically.
If you pan upward to inspect scrollback, incoming output no longer forces the
viewport back down until you return to the bottom, center on the cursor, or
send new input.

### Configuration

The CLI reads configuration from these locations, first found wins:

1. `.hay-cli.json` (local, legacy)
2. `.hop.json` under `hay-cli` (local)
3. `~/.hay-cli.json` (global, legacy)
4. `~/.hop.json` under `hay-cli` (global)

Example `.hop.json`:

```json
{
  "hay-cli": {
    "showHints": true,
    "showStatusBar": true,
    "mouseCapture": false,
    "syncSize": true,
    "scrollOff": 3
  }
}
```

Configuration options:

| Option | Default | Description |
|--------|---------|-------------|
| `showHints` | `true` | Show keyboard shortcut hints at the bottom |
| `showStatusBar` | `true` | Show the session/status bar |
| `mouseCapture` | `false` | Capture mouse events for Hop selection and local wheel scrolling |
| `syncSize` | `true` | Auto-fit the remote terminal size to the local viewport |
| `scrollOff` | `3` | Lines of context to keep above/below the cursor |

## Web Client

The web client provides:

- xterm-based terminal rendering
- mobile virtual keyboard support
- touch scrolling and selection mode
- session presence and collaboration controls

During local development, the web client is built from `apps/web/` and later
synced into Hop’s served `hay-web/` bundle at the repo root.

## Architecture

```text
┌─────────────────┐
│   Web Client    │──┐
│   (xterm.js)    │  │
└─────────────────┘  │     WebSocket       ┌─────────────────┐
                     ├────────────────────▶│   Hay Server    │──── node-pty ──── shell
┌─────────────────┐  │   ?room=X&name=Y    │   (rooms.ts)    │
│    CLI Client   │──┘                     └─────────────────┘
└─────────────────┘                              │
                                                 ▼
                                          ┌─────────────┐
                                          │    Room     │
                                          │  - clients  │
                                          │  - pty      │
                                          │  - collab   │
                                          └─────────────┘
```

## Embedding Notes

The server library still exposes some legacy termshare-flavored API names such
as `attachTermshare` and `TermshareServerOptions`. Those names reflect the
history of the codebase; the workspace and packages in this repo are now named
Hay.

Example:

```ts
import http from "node:http";
import { attachTermshare } from "../apps/server/dist/lib.js";

const server = http.createServer();
const hay = attachTermshare({ server });

server.listen(4001, () => {
  console.log("Server running on http://localhost:4001");
});
```

WebSocket clients connect with:

- `room`
- `name`
- `cols`
- `rows`

## Protocol Summary

Client to server:

```ts
{ type: "input", data: string }
{ type: "resize", cols: number, rows: number }
{ type: "typing", active: boolean }
{ type: "toggle_collab", enabled: boolean }
{ type: "take_control" }
{ type: "release_control" }
```

Server to client:

```ts
{ type: "hello", clientId, roomId, color, collabMode, controllerId }
{ type: "output", data: string }
{ type: "snapshot", data: string }
{ type: "presence", clients: [...] }
{ type: "collab", enabled, controllerId }
{ type: "input_rejected", reason: string }
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4001` | Standalone server port |
| `PTY_MODE` | `native` | PTY backend mode: `native`, `auto`, or `mock` |
| `SERVE_WEB` | `false` | Serve the built web client from the standalone server |
| `WEB_DIST_PATH` | unset | Path to web client dist when `SERVE_WEB=true` |
| `CWD` | current directory | Default working directory for new PTY sessions |

## Production Build

```bash
npm run build
PORT=4001 SERVE_WEB=true WEB_DIST_PATH=./apps/web/dist node apps/server/dist/index.js
```

## Testing

```bash
npm test
npm run test:unit
npm run test:e2e
```

Set `PTY_MODE=mock` for CI environments that cannot spawn PTYs.

## License

MIT
