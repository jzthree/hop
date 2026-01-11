# Hop + Termshare Integration Plan

This branch integrates [termshare](https://github.com/jzthree/termshare) to replace ttyd/tmux.

## Benefits

- **No ttyd/tmux dependencies** - Pure Node.js solution
- **Built-in presence** - See who's connected, typing indicators
- **Control modes** - Collaborative or locked single-controller
- **No injection hacks** - Direct control over web UI
- **Mobile-ready** - Responsive design built-in
- **CLI client** - Connect from real terminals too

## Architecture Change

### Before (ttyd)
```
Browser → Hop Auth Proxy → ttyd (per session) → tmux → shell
                ↓
        HTML/WebSocket injection for mobile keyboard
```

### After (termshare)
```
Browser → Hop Auth Proxy → Termshare WebSocket → node-pty → shell
                ↓
        Native termshare web UI (no injection needed)
```

## Implementation Steps

### 1. Add Dependencies
- [x] `node-pty-prebuilt-multiarch` - PTY handling
- [x] `ws` - WebSocket server
- [ ] Copy termshare room/pty logic into hop

### 2. Remove ttyd/tmux Code
- [ ] Remove `spawn('ttyd', [...])` in `getOrCreateSession()`
- [ ] Remove `HOP_TMUX_CONF`, `HOP_TMUX_WRAPPER` generation
- [ ] Remove `listTmuxSessions()`, `waitForTmuxSessionReady()`
- [ ] Remove ttyd dependency check
- [ ] Remove `keyboard.html` injection code
- [ ] Remove `getIOSKeyboardInjection()` WebSocket patching

### 3. Add Termshare Integration
- [ ] Port `Room` and `RoomManager` classes from termshare
- [ ] Port `createPty` function
- [ ] Create termshare WebSocket handler at `/ws` endpoint
- [ ] Map hop sessions to termshare rooms

### 4. Update Session Management
```javascript
// Before: activeSessions[name] = { ttyd: Process, port: number }
// After:  activeSessions[name] = { room: Room }
```

### 5. Serve Termshare Web UI
- [ ] Build termshare web client
- [ ] Serve static files from hop
- [ ] Or embed built assets

### 6. Keep Hop Features
- [x] Authentication (TOTP + cookies)
- [x] Cloudflare tunneling
- [x] Session URL routing (`/s/<name>/`)
- [x] Multi-user support

## Key Code Changes

### Replace ttyd spawn (lines ~1089-1114)

```javascript
// OLD: spawn ttyd process
const ttyd = spawn('ttyd', [...]);
activeSessions[sessionName] = { ttyd, port };

// NEW: create termshare room
const room = roomManager.getRoom(sessionName, { cols: 80, rows: 24 });
activeSessions[sessionName] = { room };
```

### Replace WebSocket proxy (lines ~2383)

```javascript
// OLD: proxy to ttyd WebSocket
proxy.ws(req, socket, head);

// NEW: handle with termshare
wss.handleUpgrade(req, socket, head, (ws) => {
  const room = activeSessions[sessionName].room;
  room.attachClient(clientInfo, socketAdapter(ws));
});
```

### Remove HTML injection (lines ~2283-2319)

```javascript
// OLD: intercept ttyd HTML, inject keyboard
const { hook, ui } = getIOSKeyboardInjection();
html = html.split('<head>').join('<head>' + hook);

// NEW: serve termshare web client directly (no injection)
res.sendFile(path.join(__dirname, 'web/index.html'));
```

## Testing

1. Start hop: `node hop`
2. Open browser to tunnel URL
3. Verify:
   - [ ] Login with TOTP works
   - [ ] Terminal session works
   - [ ] Multiple clients see same session
   - [ ] Presence indicators show
   - [ ] Control modes work
   - [ ] Mobile UI works without injection

## Migration Notes

- Sessions are not persistent (by design) - shell exits when all clients disconnect
- tmux scrollback replaced by termshare's output buffer
- iOS keyboard injection replaced by termshare's mobile UI
