# Changelog

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
