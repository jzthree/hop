# Hop + Termshare Integration Plan

This branch integrates [termshare](https://github.com/jzthree/termshare) to replace ttyd/tmux.

## Benefits

- **No ttyd/tmux dependencies** - Pure Node.js solution
- **Built-in presence** - See who's connected, typing indicators
- **Control modes** - Collaborative or locked single-controller
- **No injection hacks** - Direct control over web UI
- **Mobile-ready** - Responsive design with iOS-style keyboard built-in
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
        Native termshare web UI (mobile keyboard built-in)
```

## Implementation Steps

### 1. Add Dependencies
- [x] `node-pty-prebuilt-multiarch` - PTY handling
- [x] `ws` - WebSocket server
- [x] Copy termshare room/pty logic into hop (`termshare.js`)

### 2. Remove ttyd/tmux Code
- [x] Remove `spawn('ttyd', [...])` in `getOrCreateSession()`
- [ ] Remove `HOP_TMUX_CONF`, `HOP_TMUX_WRAPPER` generation (still present but unused)
- [ ] Remove `listTmuxSessions()`, `waitForTmuxSessionReady()` (still present but unused)
- [ ] Remove ttyd dependency check (still present but unused)
- [x] Remove keyboard HTML injection code (now using termshare's built-in)
- [x] Remove `getIOSKeyboardInjection()` WebSocket patching (still present but unused)

### 3. Add Termshare Integration
- [x] Port `Room` and `RoomManager` classes from termshare
- [x] Port `createPty` function
- [x] Create termshare WebSocket handler at `/ws` endpoint
- [x] Map hop sessions to termshare rooms

### 4. Update Session Management
```javascript
// Before: activeSessions[name] = { ttyd: Process, port: number }
// After:  activeSessions[name] = { room: Room }
```
✅ Completed

### 5. Serve Termshare Web UI
- [x] Build termshare web client (with mobile keyboard)
- [x] Serve static files from hop (`termshare-web/` directory)
- [x] Inject room parameter for session routing

### 6. Keep Hop Features
- [x] Authentication (TOTP + cookies)
- [x] Cloudflare tunneling
- [x] Session URL routing (`/s/<name>/`)
- [x] Multi-user support

## Key Files Changed

- `hop` - Main server, updated `getOrCreateSession()` and WebSocket handler
- `termshare.js` - New module with Room, RoomManager, createPty
- `termshare-web/` - Built termshare web client with mobile keyboard

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
- tmux scrollback replaced by termshare's output buffer (200KB)
- iOS keyboard injection replaced by termshare's built-in mobile keyboard
- The old ttyd/tmux code paths are still present but no longer used; can be removed in a cleanup pass
