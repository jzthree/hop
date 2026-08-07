# Changelog

## [Unreleased]

### New Features

#### Tooling
- **Deterministic turn-completion signal for agent driving**: the Claude hook installed by `hop claude-hook install` now also registers a `Stop` hook that bumps a per-turn counter at `<HOP_HOME>/claude-sessions/<HOP_SESSION>.turn` (`{ sessionId, count, at }`) each time Claude finishes a turn. Re-run `hop claude-hook install` to add it to an existing SessionStart-only install; it's a no-op outside hop and never disrupts Claude.
- **MCP `until_agent_done` uses that counter when available**: `hopx_agent_turn` captures the session's turn count before sending and treats a counter advance as the authoritative "turn done" — exact completion instead of screen-scraping for a busy footer (which can read a paused agent as idle). When no marker is present (hook not installed, a non-Claude agent, or no local filesystem access) it falls back to the existing busy-line heuristic unchanged, so there's no behavior change without the hook.
- **Verified submit catches a swallowed Enter**: in `mode:"ui"`, after `hopx_agent_turn` sends your text and presses Enter it re-reads the agent's input box and, if your prompt is still sitting there un-submitted (a known TUI race when the app isn't ready for input), re-sends Enter — up to twice — so a driver never waits forever on a turn that never started. The box is read with a dim-ghost/border-aware scrape (below), so an empty box showing only placeholder text counts as cleared. Reported under `submit` in the result (`verified`, `reason`, `resends`). On by default for UI turns; pass `verify_submit:false` to disable, or tune `verify_submit_retries` / `verify_submit_delay_ms`. No-op (and safe) when no input box is on screen, so it never double-submits to a plain shell.
- **Composer scrape distinguishes typed text from ghost placeholder**: the MCP now reads a TUI input box straight from the virtual screen, locating it by its box-drawing frame and dropping the dim placeholder text using the per-cell SGR *dim* attribute (rather than stripping `\e[2m` from a string, which is ambiguous when color payloads follow). This is what lets verified-submit tell "my prompt is still in the box" from "the box is empty".
- **Capture any TUI's scrollback through Hop with `hopx_capture_scrollback`**: the Hop-native counterpart to `hop_read_trajectory` — obtain an alternate-screen TUI's history *the way a user would*, by driving it to scroll up and stitching the rendered frames. It sends a scroll key (default PageUp), waits for the screen to actually redraw (`screenRevision` change), and stitches newly-revealed rows, detecting and excluding the app's fixed footer/composer chrome (so Claude's input box isn't duplicated through the transcript). Restores the live view afterward (PageDown per captured page) and caps output (`max_chars`). Works for any scrollable TUI — including non-Claude agents (codex/gemini) and when no transcript file is reachable. Verified end-to-end: full lossless reconstruction of a 300-line file under `less` (0 gaps, restored to bottom), and a live Claude session (PageUp scrolls, fixed composer not duplicated, view restored). Best-effort and lossy for wrapped/redrawn content — prefer `hop_read_trajectory` when a Claude transcript is available.
- **Read a Claude session's real history with `hop_read_trajectory`**: the terminal only shows the current frame for an alternate-screen TUI, so the scrolled-off conversation is invisible to a driver. This MCP tool resolves a hop session name to its Claude transcript (`~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl`, via the SessionStart-hook record, falling back to the newest transcript in the project dir — which it flags as ambiguous when several sessions share a cwd) and returns the **actual** turn history. It is **context-safe by design**: it stream-parses the file (a 21 MB / 6900-line transcript reduces in ~70 ms at ~150 MB RSS) and never returns the raw transcript — output is capped (`max_chars`, default 8000) with a truncation hint. The default `digest` mode is a **reduced conversation view** (ported self-contained from the agent-migration tool): per-turn User text + Assistant text + one-line tool-call summaries (`[Bash] …`, `[Read] path`, `[WebSearch] query=…`), with transcript noise dropped (tool-result bodies, thinking, system/hook lines, `<system-reminder>`/`<command-name>`-style injected text) and the most-recent turns kept within budget. Other modes: `summary` (metadata + per-type counts + token totals), `list` (paginated compact records), `get` (one turn by index/uuid), `tail` (last N turns' full text). **Gated by the same per-session agent permission as attaching** — reading a session's history requires `hop_set_agent_permission(name, allowed=true)` (or `hop session permit <name>`); unknown/unverifiable sessions are denied. Reads on the MCP host today, behind a seam so a daemon endpoint can serve it for agent-remote-from-sessions setups later.
- **Busy-line completion settles before declaring done, and reports a three-state verdict**: on the heuristic path (no Stop-hook marker), the `hopx_agent_turn` busy guard now requires N consecutive idle reads (`settle_checks`, default 2) before calling a turn done — a single idle read can be a lull between an agent's bursts (thinking → tool call), and the settle avoids that stale-idle false "done". The guard's `uiBusyGuard` summary now carries `state: "done" | "busy" | "unknown"` (plus `settledIdle` and a compact `composer` snapshot) so a driver can tell a confirmed completion from a still-working turn from an ambiguous timeout. The turn-counter marker stays authoritative and needs no settle.
- **`hop session list` shows attached client counts**: each live session now reports how many clients are connected (e.g. `Solstice [TERMINAL, LIVE] · 1 client`, or `· 0 clients` for a live-but-detached session) instead of only whether it's alive. Counts come from the host's per-room client tally; non-live sessions still only appear with `--all`.
- **`hop` starts a new session by default; `hop attach` reuses one.** Bare `hop` (and `hop new` / `hop --new`) now always start a fresh session instead of reattaching to this directory's session. `hop attach` with no name attaches to an **unattached** session (one with no client connected) — preferring the current directory, else the most recently active — and if every session is already attached it reports "No unattached session" and lists them. `hop attach <name>` and `hop attach all` are unchanged.
- **Clearer "couldn't reserve a session" note**: when the daemon can't hand out a session atomically, the fallback message now explains it's non-fatal and that a bare `status 200` typically means the running daemon is older than the CLI — with the fix (`hop stop && hop start`, which keeps sessions running). Previously it read as a cryptic "Could not claim session atomically (status 200)".
- **`hop math '<latex>'`** — render a LaTeX formula in the terminal as a **2D Unicode layout**, dependency-free. The box-layout engine handles stacked fractions, `√` with an overline, big-operator limits stacked over/under, super/subscripts (Unicode glyphs with `^`/`_` fallback), Greek + operator symbols, and combining-mark accents like `\vec`/`\hat`/`\bar`. Reads from an argument or stdin. Inline-image rendering (Kitty/iTerm/Sixel) is deferred until graphics support lands in the web client (xterm.js), since the real payoff is images that render *inside* a shared hop session — until then math is Unicode everywhere.

#### CLI Client
- **Rename the session from inside it (`Opt+R`)**: type a new name in the status bar (`Enter` to save, `Esc` to cancel). The new name persists to the daemon, so it shows everywhere — the session manager, `hop session list`, and on reattach. (Posts to the local hop daemon's rename API; available wherever a local daemon is reachable.)
- **You're told when another client reshapes the shared terminal**: with autofit on (the default), a peer's window can resize the shared PTY for everyone. When that happens the status bar shows a `⇄ <name>` indicator (who's driving the current size), and a one-off notice — `<name> resized the terminal to <cols>×<rows>` — explains the reshape so a sudden change of shape (including on connect, when a peer already sized it) isn't a surprise.
- **Status bar / hints toggles are session-only**: `Opt+B` (status bar) and `Opt+T` (hints) no longer persist to `.hop.json`, so an in-session toggle can't silently become your permanent default. The default is taken from `.hop.json` (`showStatusBar`/`showHints`, both default `true`); toggles affect only the current session and the notice now says so. (Other toggles like mouse capture and sync-size still persist.)

#### Web Client
- **One size rule everywhere — the last user action owns the terminal size**: the server-side size election (typing-recency plus 60s/2.5s idle windows) is replaced by a single ownership rule: whoever acted last — opened the session or pressed a key — owns the PTY size, and their refits (window drag, rotation, keyboard) flow straight through. A keystroke transfers ownership and snaps the PTY to the typist's declared fit immediately. `active_size` is now interpreted by **identity** (the owner's clientId) instead of by comparing sizes. When a peer owns the size, the web terminal in Auto-fit now **follows the owner's grid** — rendered at the PTY's true geometry, scaled and letterboxed to the viewport — instead of rewrapping the buffer at its own width; typing (or the drawer's Fit button) takes the size back. Scrolling doesn't count: wheel/mouse reports never transfer ownership, so reading a session on the phone no longer steals the size from a desk. Resize sends are debounced (150ms) and the stale pre-switch resize on reconnect is gone, so a session switch reshapes the PTY once, not twice.
- **Restyle to the hop identity**: the web client now shares the CLI bars' palette and language — accent session chip, semantic state dot, and keycap-style find control in a real status-bar footer; mono-led chrome (brand, presence names, session labels); refined light/dark themes; dot-grid join page. The hop session picker got the same treatment, including dark-mode support.
- **Drawer polish**: quick actions split into two clusters — utility icons (keyboard / share / find) then named actions (Fit / Manage) — and the drawer FAB now defaults to the top-right (clear of the status bar, mirroring the close button) instead of bottom-left. It stays draggable.
- **Autofit by default + fit on every session load**: the terminal fits the viewport on connect and on each session switch, on every platform. Autofit resizes the shared PTY, so other viewers follow this client; switch to Manual in the drawer to opt out.

#### Server
- **Plain-shell restore replays the last screen**: on a graceful shutdown the host now persists each room's tail buffer to `<HOP_HOME>/session-buffers/<id>.raw`; `hop restore` seeds a recreated plain-shell session with that buffer plus a dim `──── session restored ────` separator, then starts a fresh shell in the same dir — so reopening a shell session picks up where it left off (claude sessions still resume via `claude --resume`, so they aren't seeded). The buffer is consumed (deleted) on restore so a later normal recreate never replays a stale screen. The first restart after upgrading has no persisted buffers yet (nothing to replay).

### Bug Fixes

#### Web terminal
- **Claude screens render completely on attach without a scroll**: Hop now starts its authoritative screen grid when a session enters alternate-screen or mouse-reporting TUI mode, before startup rows can fall out of a bounded replay tail. Full-screen attaches use that serialized screen, and direct snapshot paints re-arm one delayed repaint in case the browser misses the first WebGL frame.
- **Resizing another desktop view no longer leaves a terminal unable to reach the live bottom**: Wall/watch tiles now resize only unattended sessions instead of overriding an open desktop's Claude grid, Hop reconciles xterm's follow state after local geometry changes, and authoritative screen resizes stay ordered behind the output that preceded them.

#### Session restore
- **`hop restore` actually restores now (Claude conversations included), from the SessionStart-hook records**: restore built its candidate list from the workspace-scoped session store, which is only populated when a workspace is active — and no workspace is ever activated in normal use, so `restore` found nothing and silently restored zero sessions. It now sources candidates directly from the durable per-session records the SessionStart hook writes (`~/.hop2/claude-sessions/<name>.json` = `{ sessionId, cwd }`), which survive a crash/reboot and carry the exact conversation id. So after a restart, `hop restore` recreates each session in its directory and resumes its Claude conversation with `claude --resume <id>` — no manual capture step. Sessions already live are skipped (idempotent), and `hop restore` now starts the daemon itself if it isn't running, so post-reboot recovery is a single command. `--dry-run` previews the plan. Records are pruned when a session is deleted, so restore never resurrects a session you intentionally closed (and if an unwanted one does come back, deleting it once keeps it gone).
- **`hopx_agent_turn` no longer runs non-UI input twice**: in `readable_raw` mode (and `auto` resolving to it — i.e. a plain shell or any non-alternate-screen agent), a synchronous turn pre-sent the input and *then* sent it again via the combined send+wait, so a command driven through `hopx_agent_turn` executed twice. The pre-send is now done only for the paths that need it (the `ui` branch and async turns, which return before the combined call); non-UI synchronous turns let the single send+wait do the send. UI and async turns are unchanged.

#### Session manager
- **Workdir now shows the live directory, not the creation directory**: a session that's both running and saved had its working dir clobbered by the saved definition's cwd when the session list was assembled — so a session you'd `cd`'d into a subdir of (e.g. `~/Code/hop2`) showed its original dir (`~`) in the web/mobile session manager, even though the CLI status bar showed the right one. The live runtime cwd (the room's tracked `liveCwd`) now wins over the saved config cwd.

#### CLI Client
- **See every shortcut when the hint bar is too narrow (`Opt+?`)**: a full-screen help overlay lists all shortcuts grouped by purpose (`↑↓` scroll, `Esc` close), so keys aren't lost when the window can't show the whole hint bar. The bar now keeps a `⌥? help` entry near the front (so it survives right-edge truncation) and ends with a `…` when there are more hints than fit.
- **Scroll wheel reaches mouse-aware remotes as a real wheel event (not arrow keys)**: when the remote program had mouse tracking on, clicks/drags were forwarded as mouse events but the wheel was converted to `↑`/`↓` arrow keys — so scrolling in a mouse-aware TUI behaved wrong even in mouse mode. The wheel is now passed through (like clicks) whenever the remote is tracking the mouse; arrow-key emulation is reserved for fullscreen apps that *don't* grab the mouse (a pager, `man`, etc.), and the normal screen still scrolls the local viewport.
- **Duplicated / lost text during scrolling output (e.g. Claude Code)**: the dirty-line render diff compared screen rows positionally but only forced a full repaint on resize — so when the buffer scrolled (or you panned), rows that shifted could be skipped (lost text) or left behind (duplicated). The renderer now forces a full repaint whenever the buffer scrolls (xterm `onScroll`) or the viewport offset changes, and clears its frame cache on snapshot replay. The in-place diff still applies for typing (no scroll), keeping that fast.

#### Web Client (mobile)
- **Touch scrolling works again in fullscreen TUIs (Claude Code, vim, less)**: an alternate-screen app has no local scrollback, so the mobile touch handler's `terminal.scrollLines()` was a silent no-op — dragging did nothing once Claude entered fullscreen (and recent Claude versions scroll their own transcript rather than the terminal's buffer). The web client now tracks the remote's alternate-screen state (seeded from the server snapshot, kept live via xterm `?h/?l` CSI handlers for modes 47/1047/1049) and, while it's active, translates a touch-drag into the app's own paging keys — PageUp/PageDown (`\e[5~`/`\e[6~`), which Claude Code, `less`, and `man` all scroll on — instead of the dead local scroll. Drag up pages toward newer output, drag down toward older; momentum is disabled on the alternate screen so a flick can't fire a burst of page keys. Normal-screen scrolling (local viewport + momentum) is unchanged. Verified the alt-screen detection against the real xterm parser (modes flip the flag and the buffer still switches; unrelated modes like cursor-hide/bracketed-paste don't) and the drag→key direction/threshold mapping.
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
- **Session panel (Opt+S)**: a file-manager-style overlay — session list on the left, a live screen preview of the highlighted session on the right. `↑`/`↓` (or `j`/`k`) fly through sessions with no perceived latency (previews are fetched from the host and cached), `Enter` switches the live terminal to the selected session, `Esc` closes. The footer shows the selected session's working dir, running program, and viewer count.
- **Scrollback search (Opt+F)**: incremental search over the buffer; all matches are highlighted (current match bright), `Enter`/`↓` jump to the next match and `↑` to the previous one.
- **Presence names + take/release control (Opt+C)**: peer names (with typing markers) in the status bar and exclusive-control parity with the web client.
- **Persistent reconnect indicator**: a banner with the failure reason, countdown to the next retry, and attempt count stays visible while disconnected (CLI and web); the CLI now exits with a clear error if the first ~5 connection attempts never succeed.
- **Kill confirmation**: `Ctrl+Q` must be pressed twice within 2s to kill the session; the end-of-session message names who killed it and includes the exit code/signal when relevant.
- **Scroll indicator**: when the viewport is detached from live output the status bar shows `scroll <pos>/<total> · Opt+0 live`; exiting search keeps your scrollback position and hints the way back.
- **Send-literal escape hatch (Opt+\\)**: forwards the next key verbatim so reserved keys (`Ctrl+Q`/`Ctrl+G`) can reach remote programs.
- **Hints toggle moved to Opt+T** (was `Ctrl+T`), matching the other Opt toggles; `Ctrl+T` now passes through to the remote terminal (readline transpose-chars, fzf, etc.).
- **Adaptive bar themes**: status/hint bars auto-detect light vs dark terminal backgrounds (OSC 11 query, `$COLORFGBG` fallback) with truecolor palettes; pin with `--theme light|dark|auto` or `{"hay-cli": {"theme": "dark"}}` in `.hop.json`.
- **Status bar redesign**: semantic state dot at the right edge (green connected / amber reconnecting / red disconnected / purple locked), session name as an accent chip at the left edge, dim cwd, `·` separators, `manual` shown only when autofit is off.
- **Much bigger scroll buffer**: client scrollback is now 50000 lines (CLI and web), and the server retains ~20MB of raw output per room for reattach snapshots (override with `HAY_SNAPSHOT_BUFFER_BYTES`). The full snapshot is replayed and parsed on reattach, so this trades memory + reattach-parse time for deeper restored history.
- **Hint bar redesign**: keycap-style hints (`⌃G detach · ⌥F find …` on macOS) with keys at full strength and labels dim; notices render as toasts (`✓` confirmations, `!` warnings, accent edge for info); the hint line surface is one step fainter than the status line.
- **Clearer session feedback**: "Created new session" vs "Attached to (N participants)" notice on connect, named control-handoff notices ("alice took control…"), friendlier control-locked rejection with the controller's name, and a reattach hint on detach.
- **CLI argument validation**: unknown flags and extra positional arguments are rejected with an error instead of silently becoming the room name.

#### Server
- Every session's PTY env now carries `HOP_SESSION=<room id>`, so a Claude Code SessionStart hook can map a running conversation back to its hop session (enables `hop restore` to resume the exact conversation per session).
- Room summaries now report the foreground process name (node-pty's process getter, read fresh per summary), live cwd, and last-activity timestamp, so the session manager can show what each session is running, where, and when it was last active.
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
