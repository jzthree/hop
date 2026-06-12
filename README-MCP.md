# Hop MCP Server

The Hop MCP server exposes Hop terminal and session APIs over MCP so agents can
create terminals, stream output, send input, and recover cleanly across daemon
restarts.

## Quick Start

1. Ensure the Hop daemon is running locally by running `hop` (interactive) or `hop start` (daemon only).

2. Auto-configure supported MCP clients:

```bash
hop-mcp-setup
```

If you are running from source in this repo:

```bash
npm run setup-mcp
```

Supported auto-detected clients:
- Claude Code
- Claude Desktop
- Cursor IDE
- Gemini CLI
- Codex CLI
- VS Code / GitHub Copilot (workspace via `.vscode/mcp.json`)
- Antigravity

3. Or configure your MCP client manually:

```json
{
  "mcpServers": {
    "hop": {
      "command": "hop-mcp"
    }
  }
}
```

4. Restart your MCP client.

The server auto-connects to the local Hop daemon via `~/.hop2/.tunnel-state`.

## Recommended Flow: One Agent Terminal

Recommended flow for driving one Claude/Codex/Gemini terminal safely:

1. Launch a dedicated terminal (the returned `id` is the `terminal_id` used by every other tool):

```
hop_create_terminal(name="subagent", cwd="/path/to/repo")
```

2. Start the agent CLI:

```
hop_write_terminal(terminal_id=<id>, data="claude\n")
# or
hop_write_terminal(terminal_id=<id>, data="codex\n")
```

3. Wait for a prompt before sending work:

```
hop_wait_terminal(terminal_id=<id>, until_prompt=true, start_from="latest")
```

4. Run a multi-turn loop:
- Preferred: `hopx_agent_turn(terminal_id=<id>, data="<task>", mode="auto")`
- Good lower-level helper: `hopx_send_and_wait(terminal_id=<id>, data="<task>", press_enter=true, capture="readable_raw")`
- Manual split only when needed:
- send with `hop_write_terminal(terminal_id=<id>, data="<task>\n")`
- wait with `hop_wait_terminal(terminal_id=<id>, capture="readable_raw")`
- continue via cursor deltas from `hop_read_terminal(terminal_id=<id>, start_from="cursor", cursor=...)`

5. Stop or clean up:
- interrupt with `hop_send_key(terminal_id=<id>, key="ctrl_c")`
- close with `hop_close_terminal(terminal_id=<id>, killSession=false)`

Safety notes:
- Keep one subagent per terminal (no multiplexing multiple agent CLIs in one PTY).
- For existing user sessions, verify `agentPermitted` (or set with `hop_set_agent_permission`) before writing input.

## Shell Commands: `hopx_exec`

For plain shell work (not interactive TUIs), `hopx_exec` behaves like a Bash
tool on a persistent terminal: it sends the command, waits for the next shell
prompt, and returns clean plain-text output.

Worked example:

```
hop_create_terminal(name="builder", cwd="/path/to/repo")   # returns id
hopx_exec(terminal_id=<id>, command="npm test")
# -> { "ok": true, "exit_code": 0, "stdout": "...", "next_cursor": ... }
hopx_exec(terminal_id=<id>, command="ls /nope")
# -> { "ok": true, "exit_code": 1, "stdout": "ls: /nope: No such file or directory", ... }
```

Semantics:
- `ok` means the shell prompt returned within `timeout_ms` — NOT that the command succeeded.
- `exit_code` is the command's real exit status, captured by appending a POSIX sentinel (`<cmd>; printf '\n__HOPX_RC_<nonce>=%d\n' "$?"`). It is `null` when the sentinel was never observed (timeout, or a shell without POSIX `$?` semantics) — in that case behavior degrades gracefully to prompt-based capture.
- The sentinel line, the echoed command, the trailing prompt, and ANSI codes are stripped from `stdout`.
- On timeout, `timed_out: true` is set and `ok` is `false`.
- For SSH sessions or unusual prompts, pass `prompt_regex`; for commands with non-standard output endings, pass `idle_ms` as a fallback condition.

## Remote Hop

To connect to a remote hop instance, set env vars or use `connect_server`:

```bash
HOP_API_URL="https://hop2.example.com" HOP_TOKEN="<token>" hop-mcp
```

Or from tools:

```
connect_server(base_url="https://hop2.example.com", token="<token>")
```

Optional verification:

```
connect_server(base_url="https://hop2.example.com", token="<token>", verify=true, verify_endpoint="/api/sessions")
```

## Tools

Core tools (`hop_`): stable atomic operations.
- `connect_server` — connect to a Hop API base_url (optional token); use for remote hop instances
- `hop_server_info` — hop-mcp runtime diagnostics (version, script path, read-mode capabilities)
- `hop_list_sessions` — list Hop sessions and metadata
- `hop_list_terminals` — list terminal API sessions (created via `hop_create_terminal` / `hop_attach_terminal`)
- `hop_create_terminal` — create a terminal session and optionally run a startup command; returns the `id` used as `terminal_id` everywhere else
- `hop_attach_terminal` — attach to an existing terminal session by name or internalName
- `hop_write_terminal` — write raw input to a terminal session
- `hop_send_key` — send a named keypress (enter, esc, tab, shift_tab, arrows, f1-f12, ctrl+[a-z], ...)
- `hop_wait_terminal` — wait for output conditions (regex, prompt, idle, agent_done); `async=true` returns a `wait_id`
- `hop_wait_start` — deprecated legacy alias for `hop_wait_terminal(async=true)`
- `hop_wait_poll` — poll or await completion of a background wait job
- `hop_resize_terminal` — resize the terminal PTY
- `hop_read_terminal` — read terminal output events (default `mode="readable_raw"`); returns a cursor for incremental reads
- `hop_close_terminal` — detach the terminal API session; optionally kill the underlying hop session
- `hop_set_agent_permission` — allow or block agent access for a session
- `hop_list_workspaces` — list available workspaces
- `hop_create_workspace` — create an empty workspace by name
- `hop_show_workspace` — show saved definitions in a workspace
- `hop_save_workspace` — save a workspace snapshot from live sessions
- `hop_delete_workspace` — delete a workspace by name
- `hop_load_workspace` — load a workspace and optionally start sessions

Helper tools (`hopx_`): convenience wrappers built on top of core tools.
- `hopx_send_and_wait` — single-call send + wait wrapper
- `hopx_exec` — Bash-tool-style shell execution: command in, clean stdout + `exit_code` out (see section above)
- `hopx_agent_turn` — single-turn send + wait + mode-aware output, default `mode="auto"`

## Resources

- `hop://sessions`
- `hop://terminals`
- `hop://workspaces`

## Notes

- Agent access is gated by `agentPermitted` for sessions created by users.
- `terminal_id` is an ephemeral daemon attachment handle; underlying hop `sessionName` is the stable identity.
- On daemon restart, terminal-scoped tools auto-reattach once using stored session identity and retry transparently when possible.
- `hop_read_terminal` returns a cursor for incremental polling.
- Default fallback terminal size is `140x40` when no explicit `cols`/`rows` are provided.
- `hop_create_terminal` and `hop_attach_terminal` do a short output warmup before returning, reducing first-command races.
- Hop isolates shell history per session and writes per-session NDJSON audit logs under `~/.hop2/workspaces/<workspace>/logs/<session>/audit.ndjson`.
- Audit logging automatically switches to diff-suppressed `tui_keyframe` snapshots for alternate-screen/TUI apps while still capturing all input.

### `hop_read_terminal`

- Defaults are token-thrifty:
  - `mode` defaults to `"readable_raw"` (pass `"raw"` or `"ui"` explicitly when needed)
  - `maxEvents` defaults to `200` and `maxBytes` to `65536`; pass `0` explicitly for unlimited (the buffer keeps the last 2000 events)
  - when these caps truncate a read, the payload includes `truncated: true` plus a `hint`; continue with `start_from="cursor"`, `cursor=<next_cursor>`
  - `start_from` defaults to `cursor` when `cursor` is provided, otherwise `beginning`
- `hop_read_terminal` supports `mode: "ui"` for structured terminal snapshots:
  - `ui.lines`: visible screen lines
  - `ui.cursor`: cursor position
  - `ui.window.strategy`: `cursor_centered` with auto fallback to `densest_nonempty` when needed
  - `rawTail`: optional lossless tail of recent raw events (for transient output)
- Hop server now replays buffered terminal events on stream connect, so late attaches get immediate context instead of an empty first read.
- `hop_read_terminal` supports `mode: "readable_raw"`:
  - preserves printable text in `events[].text`
  - includes compact control hints in `events[].controls` (cursor, erase, alt-screen, visibility)
  - `control_level` tunes control noise:
  - `full`
  - `structural` (cursor/edit/screen controls; omits CR/LF noise)
  - `none` (default; text only)
  - `noise_filter` tunes status/spinner suppression:
  - `balanced` (default; suppresses CR/erase rewrite bursts, commits stable lines, strips spinner-prefix/dot animation for dedupe)
  - in `balanced`, recent shell echo lines for agent-sent input (prompt + command) and prompt-padding artifacts are compacted
  - `off` (raw parsed text; useful for parser debugging)
  - in default `none`, empty output frames are dropped to reduce event noise
  - `coalesce_ms` and `coalesce_max_chars` can merge adjacent output frames for cleaner streaming text
  - defaults: `coalesce_ms=250`, `coalesce_max_chars=32768`
  - parses incrementally across chunk boundaries to avoid split ANSI artifacts
  - reconstructs common inline edits (backspace/cursor rewrites) so text is cleaner for agent parsing
  - avoids full ANSI noise while retaining interaction structure

### `hop_wait_terminal`

- `hop_send_key` sends normalized named keys (for example `enter`, `esc`, `up`, `ctrl_c`) to improve interactive TUI control without raw escape-string handling.
- `hop_wait_terminal` blocks on output conditions without client polling loops:
  - `start_from` controls where matching begins:
  - `latest` (default): stream tail / new output only
  - `cursor`: requires `cursor` argument
  - `beginning`: oldest buffered event
  - if no explicit condition is provided, it defaults to `until_agent_done=true`
  - `async=true` starts a background wait job and returns `wait_id` immediately
  - `until_agent_done` matches when output has started, terminal becomes quiet, and interactive cursor is visible (agent-friendly completion)
  - regex match via `until_regex`
  - prompt match via `until_prompt` (optional custom `prompt_regex`)
  - quiet-period detection via `idle_ms`
  - bounded event capture in `raw` or `readable_raw`
  - for `capture="readable_raw"`, supports `control_level`, `noise_filter`, `coalesce_ms`, `coalesce_max_chars`, and optional `includeMetaEvents`

### Async wait helpers

- For long-running conditions, start a background wait with `hop_wait_terminal(terminal_id=<id>, async=true, ...)` (returns `wait_id` immediately) and poll with `hop_wait_poll(wait_id=..., wait=true)`
  - use `consume=true` on poll to remove completed jobs
- `hop_wait_start` is a deprecated legacy alias for `hop_wait_terminal(async=true)`; prefer the latter

### `hopx_send_and_wait`

- `hopx_send_and_wait` combines input send + optional enter/key + wait, and defaults to cursor-based delta capture from just before send.
  - helper defaults are token-thrifty for interactive loops: `capture_max_events=60`, `control_level=none`, `noise_filter=balanced`, `coalesce_ms=350` (unless overridden)
  - for `capture="readable_raw"`, `text_only` defaults to `true`; this condenses wait payloads by returning joined `wait.text`, setting `wait.events=[]`, `wait.eventCount=0`, and preserving prior count in `wait.originalEventCount` (set `text_only=false` to keep full events)
- `hop_read_terminal` supports deterministic delta reads:
  - `start_from`: `beginning` (default), `cursor`, or `latest`
  - response includes `cursorStart`, `cursorEnd`, and `next_cursor`

### `hopx_agent_turn`

- `hopx_agent_turn` is a helper wrapper (not a core primitive):
  - default `mode="auto"` chooses `ui` when terminal is in alternate-screen, otherwise `readable_raw`
  - in `mode="auto"`, if alternate-screen starts during the same turn, it auto-promotes to `ui` for that response
  - wait-only continuation is supported: omit `data`/`message` and use `control="wait"` to keep waiting on a terminal without sending new input
  - `async=true` starts the turn wait in the background and returns `wait_id` immediately; continue polling or controlling that turn with `hopx_agent_turn(wait_id=..., wait=true|false, control=...)`
  - `control="interrupt"` / `control="terminate"` send an explicit interrupt key (default `esc`); `terminate_message` can send a final follow-up after the interrupt
  - `mode="ui"` returns a UI snapshot payload after wait
  - for readable modes, `text_only` defaults to `true` and condenses waits the same way as `hopx_send_and_wait` (set `text_only=false` to keep full wait events)
  - `text_only` is ignored for `mode="ui"` output snapshots
  - `mode="ui"` defaults `includeRawTail=false` to reduce noisy tail payloads (opt in with `includeRawTail=true`)
  - `mode="ui"` defaults wait capture to `capture_max_events=0` (override when you need readable wait-event diagnostics)
  - when using default `until_agent_done` semantics in `mode="ui"`, hopx applies a short UI busy-guard pass to avoid returning while status lines still indicate active work (`esc to interrupt`, `working`, `waiting for process`, etc.)
  - `mode="readable_raw"` / `mode="raw"` returns the same wait payload shape as `hopx_send_and_wait`

### Error model

- Tool calls that fail at the Hop API layer return MCP tool errors (`isError: true`) with normalized fields:
  - `ok`
  - `status`
  - `endpoint`
  - `error`
  - `hint` (when a remedy is known)
- Connection-level failures (daemon not running, unreachable host, timeouts) also come back as normalized tool errors with `status: null` and a `hint` explaining how to start the daemon (`hop` or `hop start`) or reconnect via `connect_server(base_url=...)` — not as raw JSON-RPC protocol errors.
- A `403` "Agent access not permitted" error includes a hint to enable access with `hop_set_agent_permission(name=..., allowed=true)` or `hop session permit <name>`.
