# Termshare

> **Looking for a complete remote terminal solution?** Check out [hop](https://github.com/jzthree/hop) - secure terminal access from anywhere with authentication, Cloudflare tunneling, and session management built-in.

A terminal sharing library designed as a **building block** for applications that need shared terminal access. Multiple clients (same user on different devices, or different users) can connect to the same terminal session with real-time synchronization.

**This is not a complete solution** - it provides the core terminal sharing functionality without authentication, tunneling, or session persistence. These are intentionally left to the embedding application.

## Features

**What it provides:**
- **Multi-client terminal** - Multiple clients share the same PTY session
- **Presence indicators** - See who's connected, who's typing, who's active
- **Control modes** - Collaborative (all can type) or locked (single controller)
- **Web and CLI clients** - Connect via browser or real terminal
- **Embeddable library** - `attachTermshare()` to add to any HTTP server
- **Auto-fit** - Terminal resizes to active client's screen
- **Mobile-ready** - Responsive web UI with slide-out drawer and haptic feedback

**What it doesn't provide (by design):**
- Authentication - bring your own (see hop for example)
- Tunneling/remote access - bring your own (Cloudflare, ngrok, etc.)
- User management - clients are identified by name parameter only

## Comparison with ttyd

| Feature | Termshare | ttyd |
|---------|-----------|------|
| Web terminal | Yes | Yes |
| Multiple viewers | Yes | Yes |
| Real-time presence | Yes | No |
| Typing indicators | Yes | No |
| Control lock/collab modes | Yes | No |
| CLI client | Yes | No |
| Embeddable library | Yes | No |
| External dependencies | node-pty | libwebsockets |

## Quick Start

### Standalone

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Open http://localhost:5173 and share the room link with collaborators.

### CLI Client

```bash
# Connect to a room from your terminal
npm -w @termshare/cli run dev -- -r my-room -n alice

# Or after building
npx termshare -r my-room -n alice
```

#### Keyboard Shortcuts

The CLI client provides keyboard shortcuts for navigation and control:

| Key | Action |
|-----|--------|
| `←` `→` `↑` `↓` | Pan viewport |
| `0` | Center on cursor |
| `A` | Auto-fit viewport to content |
| `M` | Toggle mouse mode |
| `Ctrl+T` | Toggle hints bar |
| `Ctrl+G` | Detach from session |
| `Ctrl+Q` | Kill session |

#### Configuration

The CLI client reads configuration from these locations (first found wins):

1. `.hay-cli.json` (local, legacy)
2. `.hop.json` → `hay-cli` key (local)
3. `~/.hay-cli.json` (global, legacy)
4. `~/.hop.json` → `hay-cli` key (global)

**Example `.hop.json`:**
```json
{
  "hay-cli": {
    "showHints": true,
    "scrollOff": 3
  }
}
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `showHints` | `true` | Show keyboard shortcut hints at bottom |
| `scrollOff` | `3` | Lines of context to keep above/below cursor when scrolling (vim-like) |

### Web Client

The web client provides a browser-based terminal interface with:

- **Touch-friendly keyboard** - Virtual keyboard with common terminal keys
- **Haptic feedback** - Tactile feedback on iOS (via switch element trick) and Android (Vibration API)
- **Slide-out drawer** - Access presence indicators and controls on mobile
- **Responsive layout** - Adapts to screen size

### Embedding in Your App

```typescript
import http from "http";
import { attachTermshare } from "@termshare/server";

const server = http.createServer((req, res) => {
  res.end("Hello");
});

const termshare = attachTermshare({
  server,
  path: "/ws",  // WebSocket endpoint
  onConnect: (clientId, roomId, name) => {
    console.log(`${name} joined ${roomId}`);
  },
  onDisconnect: (clientId, roomId) => {
    console.log(`${clientId} left ${roomId}`);
  }
});

server.listen(4001);
```

Connect clients to `ws://localhost:4001/ws?room=ROOM&name=NAME&cols=80&rows=24`

## Architecture

```
┌─────────────────┐
│   Web Client    │──┐
│   (xterm.js)    │  │
└─────────────────┘  │     WebSocket        ┌─────────────────┐
                     ├────────────────────▶│   Termshare     │
┌─────────────────┐  │   ?room=X&name=Y    │   Server        │──── node-pty ──── shell
│   CLI Client    │──┘                     │   (rooms.ts)    │
│   (raw term)    │                        └─────────────────┘
└─────────────────┘                               │
                                                  ▼
                                           ┌─────────────┐
                                           │    Room     │
                                           │  - clients  │
                                           │  - pty      │
                                           │  - collab   │
                                           └─────────────┘
```

### Protocol

Clients connect via WebSocket with query parameters:
- `room` - Room/session identifier
- `name` - Display name
- `cols` - Terminal columns
- `rows` - Terminal rows

#### Client → Server Messages

```typescript
{ type: "input", data: string }           // Terminal input
{ type: "resize", cols: number, rows: number }  // Terminal resize
{ type: "typing", active: boolean }       // Typing indicator
{ type: "toggle_collab", enabled: boolean }  // Toggle collab mode
{ type: "take_control" }                  // Request control (locked mode)
{ type: "release_control" }               // Release control
```

#### Server → Client Messages

```typescript
{ type: "hello", clientId, roomId, color, collabMode, controllerId }
{ type: "output", data: string }          // Terminal output
{ type: "snapshot", data: string }        // Full terminal buffer
{ type: "presence", clients: [...] }      // Connected users
{ type: "collab", enabled, controllerId } // Mode change
{ type: "input_rejected", reason: string } // Input denied
```

## Project Structure

```
termshare/
├── apps/
│   ├── server/     # WebSocket + PTY server (library + standalone)
│   ├── web/        # React + xterm.js web client
│   └── cli/        # Terminal client
└── packages/
    └── shared/     # Protocol types and utilities
```

## API Reference

### `attachTermshare(options)`

Attach termshare to an existing HTTP server.

```typescript
type TermshareServerOptions = {
  server: http.Server;      // HTTP server to attach to
  path?: string;            // WebSocket path (default: "/ws")
  ptyFactory?: PtyFactory;  // Custom PTY factory
  onConnect?: (clientId, roomId, name) => void;
  onDisconnect?: (clientId, roomId) => void;
};

const termshare = attachTermshare(options);

// Returns:
{
  wss: WebSocketServer;     // WebSocket server instance
  rooms: RoomManager;       // Room manager instance
  close: () => void;        // Cleanup function
}
```

### `RoomManager`

Manages terminal rooms/sessions.

```typescript
const rooms = new RoomManager(ptyFactory);
const room = rooms.getRoom(roomId, { cols: 80, rows: 24 });
```

### `Room`

A single terminal session with connected clients.

```typescript
room.attachClient(clientInfo, socketAdapter);
// Events: "empty" - emitted when last client leaves
```

### Custom PTY Factory

Provide your own PTY implementation:

```typescript
const customPtyFactory = ({ cols, rows, cwd }) => {
  // Return an object implementing IPty interface:
  // - onData(handler): Subscribe to output
  // - write(data): Send input
  // - resize(cols, rows): Resize terminal
  // - kill(): Terminate
};

attachTermshare({ server, ptyFactory: customPtyFactory });
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4001 | Server port |
| `PTY_MODE` | native | `native`, `auto`, or `mock` |
| `SERVE_WEB` | false | Serve web client from server |
| `WEB_DIST_PATH` | - | Path to web client dist |

## Production Build

```bash
# Build all packages
npm run build

# Run standalone server with embedded web client
PORT=4001 SERVE_WEB=true WEB_DIST_PATH=./apps/web/dist node apps/server/dist/index.js
```

## Testing

```bash
npm test                 # Run all tests
npm run test:unit       # Unit tests only
npm run test:e2e        # E2E tests (requires build)
```

Set `PTY_MODE=mock` for CI environments that can't spawn PTYs.

## License

MIT
