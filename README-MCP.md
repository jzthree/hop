# Hop MCP Server

The Hop MCP server exposes hop’s terminal/session APIs over the Model Context Protocol (MCP), so agents can create terminals, stream output, and send input through Hop.

## Quick Start

1) Ensure Hop daemon is running locally (creates `~/.hop2/.tunnel-state`).

2) Auto-configure supported MCP clients:

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

3) Or configure your MCP client manually:

```json
{
  "mcpServers": {
    "hop": {
      "command": "hop-mcp"
    }
  }
}
```

4) Restart your MCP client.

The server auto-connects to the local Hop daemon via `~/.hop2/.tunnel-state`.

## One Subagent Terminal (Claude/Codex)

Recommended flow for driving one agent CLI safely:

1) Launch a dedicated terminal:

```
hop_create_terminal(name="subagent", cwd="/path/to/repo")
```

2) Start the agent CLI:

```
hop_write_terminal(data="claude\n")
# or
hop_write_terminal(data="codex\n")
```

3) Wait for a prompt before sending work:

```
hop_wait_terminal(until_prompt=true, start_from="latest")
```

4) Run a multi-turn loop:
- preferred: `hopx_send_and_wait(data="<task>", press_enter=true, capture="readable_raw")`
- helper alternative: `hopx_agent_turn(data="<task>", mode="auto")`
- manual split (if needed):
- send one instruction with `hop_write_terminal(data="<task>\n")`
- wait for output with `hop_wait_terminal(capture="readable_raw")` (defaults to `until_agent_done`)
- continue with cursor-deltas via `hop_read_terminal(start_from="cursor", cursor=...)`
- send the next instruction only after output is captured

5) Stop/cleanup:
- interrupt with `hop_send_key(key="ctrl_c")`
- close with `hop_close_terminal(killSession=false)`

Safety notes:
- Keep one subagent per terminal (no multiplexing multiple agent CLIs in one PTY).
- For existing user sessions, verify `agentPermitted` (or set with `hop_set_agent_permission`) before writing input.

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
- `connect_server`
- `hop_server_info`
- `hop_list_sessions`
- `hop_list_terminals`
- `hop_create_terminal`
- `hop_attach_terminal`
- `hop_write_terminal`
- `hop_send_key`
- `hop_wait_terminal`
- `hop_wait_start`
- `hop_wait_poll`
- `hop_resize_terminal`
- `hop_read_terminal`
- `hop_close_terminal`
- `hop_set_agent_permission`
- `hop_list_workspaces`
- `hop_save_workspace`
- `hop_load_workspace`
- `hop_use_workspace`

Helper tools (`hopx_`): convenience wrappers built on top of core tools.
- `hopx_send_and_wait` (single-call send + wait wrapper)
- `hopx_agent_turn` (single-turn send + wait + mode-aware output, default `mode="auto"`)

## Resources

- `hop://sessions`
- `hop://terminals`
- `hop://workspaces`

## Notes

- Agent access is gated by `agentPermitted` for sessions created by users.
- `terminal_id` is an ephemeral daemon attachment handle; underlying hop `sessionName` is the stable identity.
- On daemon restart, terminal-scoped tools auto-reattach once using stored session identity and retry transparently when possible.
- `hop_read_terminal` returns a cursor for incremental polling.
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
- `hop_wait_start` / `hop_wait_poll` provide explicit async wait orchestration for long-running conditions:
  - start with `hop_wait_start(...)` and poll with `hop_wait_poll(wait_id=..., wait=true)`
  - use `consume=true` on poll to remove completed jobs
- `hopx_send_and_wait` combines input send + optional enter/key + wait, and defaults to cursor-based delta capture from just before send.
  - helper defaults are token-thrifty for interactive loops: `capture_max_events=60`, `control_level=none`, `noise_filter=balanced`, `coalesce_ms=350` (unless overridden)
  - for `capture="readable_raw"`, `text_only` defaults to `true`; this condenses wait payloads by returning joined `wait.text`, setting `wait.events=[]`, `wait.eventCount=0`, and preserving prior count in `wait.originalEventCount` (set `text_only=false` to keep full events)
- `hop_read_terminal` supports deterministic delta reads:
  - `start_from`: `beginning` (default), `cursor`, or `latest`
  - response includes `cursorStart`, `cursorEnd`, and `next_cursor`
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
- Tool calls that fail at the Hop API layer now return MCP errors (`isError: true`) with normalized fields:
  - `ok`
  - `status`
  - `endpoint`
  - `error`
- Hop now isolates shell history per session and writes per-session NDJSON audit logs under `~/.hop2/workspaces/<workspace>/logs/<session>/audit.ndjson` with truncation metadata for large chunks.
- Audit logging auto-switches to diff-suppressed `tui_keyframe` snapshots when alternate-screen apps (vim/htop/agent TUIs) are detected, while still capturing all input events.
- Default fallback terminal size is `140x40` when no explicit `cols`/`rows` are provided.
- `hop_create_terminal` / `hop_attach_terminal` now do a short output warmup before returning, reducing first-command races in interactive shells.
