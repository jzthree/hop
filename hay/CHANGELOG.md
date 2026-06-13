# Changelog

## [Unreleased]

### New Features

#### Web Client
- **Restyle to the hop identity**: the web client now shares the CLI bars' palette and language — accent session chip, semantic state dot, and keycap-style find control in a real status-bar footer; mono-led chrome (brand, presence names, session labels); refined light/dark themes; dot-grid join page. The hop session picker got the same treatment, including dark-mode support.
- **Drawer polish**: quick actions split into two clusters — utility icons (keyboard / share / find) then named actions (Fit / Manage) — and the drawer FAB now defaults to the top-right (clear of the status bar, mirroring the close button) instead of bottom-left. It stays draggable.
- **Autofit by default + fit on every session load**: the terminal fits the viewport on connect and on each session switch, on every platform. Autofit resizes the shared PTY, so other viewers follow this client; switch to Manual in the drawer to opt out.

### Bug Fixes

#### Web Client (mobile)
- **Drawer groups no longer collapse with a long session list**: the drawer is a flex column with a fixed viewport height on mobile, so a long "Switch session" list overflowed and the flex algorithm shrank the Control and Theme/Font/Copy groups (which have `overflow:hidden`) to empty slivers. Children are now pinned to their natural height, so the drawer scrolls instead of squeezing — the settings groups stay visible no matter how many sessions are live.
- **Mobile controls no longer disappear at narrow widths**: `isMobile` now tracks the viewport instead of being fixed at page load, so resizing a window narrow (or any narrow load) shows the full mobile drawer — keyboard toggle, Find, Touch mode, and the virtual keyboard — matching the CSS breakpoint. Previously a wide-then-narrow window stayed in "desktop mode" and dropped those controls.
- **Find no longer triggers Safari's auto-zoom**: every focusable field is floored at 16px on mobile, so focusing the find box (or any input) never zooms the page with no way back. The drawer's Find action is now an icon.
- **Drawer quick actions no longer clip**: buttons are content-width and wrap, so labels like "Manage" are never cut off; keyboard/share/find are compact icon buttons.
- **Copy is one tidy control** (`Screen | All`) instead of three loose buttons, matching the other drawer rows.
- **Calmer disconnect**: connecting/reconnecting/disconnected now read in a muted slate instead of alarm orange/red — a dropped connection should feel recoverable. Only a truly ended session shows red.
- **Haptics**: the key-tap vibration uses the Vibration API on Android/Chromium. (iOS Safari has no web haptic API — Apple removed the `<input switch>` trick in iOS 17.4 — so haptics are a no-op there.)

## [0.9.0] - 2026-06-12

### New Features

#### CLI Client
- **Scrollback search (Opt+F)**: incremental search over the buffer; all matches are highlighted (current match bright), `Enter`/`↓` jump to the next match and `↑` to the previous one.
- **Presence names + take/release control (Opt+C)**: peer names (with typing markers) in the status bar and exclusive-control parity with the web client.
- **Persistent reconnect indicator**: a banner with the failure reason, countdown to the next retry, and attempt count stays visible while disconnected (CLI and web); the CLI now exits with a clear error if the first ~5 connection attempts never succeed.
- **Kill confirmation**: `Ctrl+Q` must be pressed twice within 2s to kill the session; the end-of-session message names who killed it and includes the exit code/signal when relevant.
- **Scroll indicator**: when the viewport is detached from live output the status bar shows `scroll <pos>/<total> · Opt+0 live`; exiting search keeps your scrollback position and hints the way back.
- **Send-literal escape hatch (Opt+\\)**: forwards the next key verbatim so reserved keys (`Ctrl+Q`/`Ctrl+G`) can reach remote programs.
- **Hints toggle moved to Opt+T** (was `Ctrl+T`), matching the other Opt toggles; `Ctrl+T` now passes through to the remote terminal (readline transpose-chars, fzf, etc.).
- **Adaptive bar themes**: status/hint bars auto-detect light vs dark terminal backgrounds (OSC 11 query, `$COLORFGBG` fallback) with truecolor palettes; pin with `--theme light|dark|auto` or `{"hay-cli": {"theme": "dark"}}` in `.hop.json`.
- **Status bar redesign**: semantic state dot at the right edge (green connected / amber reconnecting / red disconnected / purple locked), session name as an accent chip at the left edge, dim cwd, `·` separators, `manual` shown only when autofit is off.
- **Bigger reattach scrollback**: the server now retains ~2MB of raw output per room for reattach snapshots (was 200KB, which TUI-heavy streams exhausted in a screenful); override with `HAY_SNAPSHOT_BUFFER_BYTES`. Client scrollback raised to 5000 lines (CLI and web).
- **Hint bar redesign**: keycap-style hints (`⌃G detach · ⌥F find …` on macOS) with keys at full strength and labels dim; notices render as toasts (`✓` confirmations, `!` warnings, accent edge for info); the hint line surface is one step fainter than the status line.
- **Clearer session feedback**: "Created new session" vs "Attached to (N participants)" notice on connect, named control-handoff notices ("alice took control…"), friendlier control-locked rejection with the controller's name, and a reattach hint on detach.
- **CLI argument validation**: unknown flags and extra positional arguments are rejected with an error instead of silently becoming the room name.

#### Server
- Room summaries now report the foreground process name (node-pty's process getter, read fresh per summary) and live cwd, so the session manager can show what each session is running and where.
- Rooms expose a bounded preview source (size + output tail) for on-demand screen previews in the session manager (`GET /rooms/:id/preview`).
- Optional `created` flag on `hello` and `by` attribution on `session_ended` (both backwards compatible).
- Invalid client messages are rejected with the message type and offending field (e.g. `Invalid resize message: rows …`) instead of a bare "Invalid message".

### Performance

- CLI rendering uses dirty-line diffing with a ~60fps frame throttle, repainting only rows that changed.

### Bug Fixes

- Fixed the mobile terminal layout so the virtual keyboard anchors to the viewport bottom and no longer leaves a large gap above the screen edge.
- `Ctrl+Q` while disconnected no longer falsely prints "Session terminated."; it now explains the server is unreachable and that the session may still be running.
- Tiny terminal windows no longer send `resize` messages below the protocol minimum (2x2), which the server used to reject.
- Reserved `Ctrl` keys pressed in the brief post-connect grace window are swallowed instead of being forwarded to the remote shell.
- Mouse-copy notice hedges to "Sent N line(s) to clipboard (OSC 52)" since terminal support for OSC 52 varies.
- README/`--help` keyboard documentation corrected (all viewport shortcuts require Opt/Alt) and completed (Opt+0, Opt+F, Opt+C, Opt+H/J/K/L, Shift fast-pan, Opt+\\).

## [0.8.0] - 2025-01-25

### Major Changes

- **Replaced ttyd/tmux with hay/node-pty**: Terminal sessions are now managed directly via node-pty instead of ttyd+tmux. This removes external dependencies and provides native multi-client support, presence indicators, and better web/CLI integration.

### Breaking Changes

- **RoomManager.getRoom() signature changed**: Now accepts optional third `cwd` parameter
  ```typescript
  // Before
  getRoom(roomId: string, initialSize: { cols: number; rows: number })

  // After
  getRoom(roomId: string, initialSize: { cols: number; rows: number }, cwd?: string)
  ```
  The per-room `cwd` takes precedence over the RoomManager constructor's default cwd.

### New Features

#### CLI Client
- **Keyboard shortcuts**: Pan (arrows), center on cursor (0), auto-fit (A), mouse toggle (M), hints (Ctrl+T), detach (Ctrl+G), kill (Ctrl+Q)
- **Configuration file support**: Reads from `.hop.json` (under `hay-cli` key) or legacy `.hay-cli.json`
- **Config hierarchy**: Local config takes precedence over global (`~/.hop.json`)
- **scrollOff setting**: Vim-like scroll margin (default: 3 lines) keeps context visible around cursor
- **showHints setting**: Toggle keyboard shortcut hints bar

#### Web Client
- **Haptic feedback**: Tactile feedback on mobile keyboard (iOS via switch element trick, Android via Vibration API)
- **Improved mobile layout**: Responsive drawer and keyboard

### Bug Fixes

- Fixed sessions always starting in daemon's directory instead of caller's pwd
- Fixed cursor scroll behavior to match regular terminals (only scroll when cursor exits viewport)
- Fixed initial viewport positioning on session start

## [0.1.0] - Initial Release

- Multi-client terminal sharing
- Web and CLI clients
- Presence indicators and typing status
- Collaborative and locked control modes
- Embeddable server library
