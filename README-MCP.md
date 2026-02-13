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

- `connect_server`
- `hop_server_info`
- `hop_list_sessions`
- `hop_list_terminals`
- `hop_create_terminal`
- `hop_attach_terminal`
- `hop_write_terminal`
- `hop_send_key`
- `hop_wait_terminal`
- `hop_resize_terminal`
- `hop_read_terminal`
- `hop_close_terminal`
- `hop_set_agent_permission`
- `hop_list_workspaces`
- `hop_save_workspace`
- `hop_load_workspace`
- `hop_use_workspace`

## Resources

- `hop://sessions`
- `hop://terminals`
- `hop://workspaces`

## Notes

- Agent access is gated by `agentPermitted` for sessions created by users.
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
  - regex match via `until_regex`
  - prompt match via `until_prompt` (optional custom `prompt_regex`)
  - quiet-period detection via `idle_ms`
  - bounded event capture in `raw` or `readable_raw`
  - for `capture="readable_raw"`, supports `control_level`, `coalesce_ms`, and `coalesce_max_chars`
- Tool calls that fail at the Hop API layer now return MCP errors (`isError: true`) with normalized fields:
  - `ok`
  - `status`
  - `endpoint`
  - `error`
- Default fallback terminal size is `140x40` when no explicit `cols`/`rows` are provided.
- `hop_create_terminal` / `hop_attach_terminal` now do a short output warmup before returning, reducing first-command races in interactive shells.
