# 🐰 hop

**Terminal access for humans and agents.**

Hop gives you secure browser access to local terminals and a built-in MCP server for creating, driving, and auditing agent sessions over the same runtime.

> **macOS/Linux** — Requires cloudflared for tunneling

```
           (\(\ 
           ( -.-)    "hop into your shell"
           o_(")(")
```

## Why Hop

- **Browser terminal from anywhere** — Tunnel through Cloudflare with no port forwarding
- **MCP-native terminal control** — Claude Code, Codex, Gemini, Cursor, and other MCP clients can create terminals, stream output, and send input through Hop
- **One runtime for humans and agents** — The browser UI, local CLI, and MCP server operate on the same sessions
- **Operationally useful primitives** — Named sessions, port sessions, auto-attach, and explicit workspace snapshots
- **Auditability built in** — Per-session logs, isolated agent history, and TUI-aware capture defaults
- **Security when you need it** — Password + 2FA, custom domains, and multi-user support

## 🚀 Quick Install

Most users only need the npm install. Source install is mainly for development or local hacking.

### From npm (easiest)

```bash
npm install -g hop2
```

This installs:
- `hop` — main CLI / daemon / browser terminal entrypoint
- `hop-mcp` — MCP server exposing Hop terminals and sessions
- `hop-mcp-setup` — MCP client auto-config helper

Then:
```bash
hop
```

If you want agent access too:

```bash
hop-mcp-setup
```

### From source (one-liner)

```bash
git clone https://github.com/jzthree/hop.git ~/.hop && \
cd ~/.hop && npm install && \
sudo ln -sf ~/.hop/hop /usr/local/bin/hop
```

### From source (manual)

```bash
# Clone the repo
git clone https://github.com/jzthree/hop.git ~/.hop

# Install dependencies
cd ~/.hop && npm install

# Add to PATH (pick one)
# Option A: Symlink (requires sudo)
sudo ln -sf ~/.hop/hop /usr/local/bin/hop

# Option B: Add to PATH
echo 'export PATH="$HOME/.hop:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Quick Start

### Browser access
```bash
hop
```

First run:
1. Optionally set a password with `hop password set`
2. Scan the authenticator QR code
3. Note the URL
4. Press Enter to start your first local terminal

Then open the URL from another device, sign in, and pick or create a session.

### MCP access

```bash
hop
hop-mcp-setup
```

Then restart your MCP client. `hop-mcp-setup` auto-detects and configures supported clients such as Claude Code, Claude Desktop, Cursor, Gemini CLI, Codex CLI, VS Code / Copilot, and Antigravity.

Typical use cases:
- Launch a dedicated Claude Code / Codex / Gemini terminal and drive it over multiple turns
- Create isolated agent sessions with per-session history and audit logs
- Read terminal output incrementally instead of screen-scraping a browser
- Build higher-level agent workflows on top of stable terminal/session primitives

For full MCP usage, tools, and subagent workflows, see [README-MCP.md](./README-MCP.md).

## Everyday Workflows

### Create and Reuse Sessions

Create multiple independent terminal sessions from the Session Picker (`/sessions`):

- Create a new named shell session
- Join any existing session
- Share a live session between multiple devices
- Save selected live terminal sessions into a named workspace when you want to reuse them later

Scratch sessions stay live-only unless you explicitly save them into a workspace. To save reusable definitions from the CLI:

```bash
hop session add workspace-shell --cwd ~/src/my-project --workspace dev
hop session add myapp --port 3000 --workspace dev
```

Use `hop workspace save <name>` to snapshot selected live terminal sessions, or `hop session add ... --workspace <name>` when you want to define a reusable terminal or port entry directly.

Inspect or remove saved workspace definitions with:

```bash
hop workspace show dev
hop workspace delete dev
```

### Drive a Subagent Over MCP

Use one dedicated terminal per subagent.

1. Create a terminal with `hop_create_terminal` and set `name` / `cwd`.
2. Start the agent CLI with `hop_write_terminal`.
3. Wait for readiness with `hop_wait_terminal(until_prompt=true)`.
4. Prefer `hopx_agent_turn(mode="auto")` or `hopx_send_and_wait(...)` for one turn at a time.
5. For long waits, use `hopx_agent_turn(async=true, ...)` or the lower-level `hop_wait_start(...)` / `hop_wait_poll(...)`.
6. Interrupt with `hop_send_key(key="ctrl_c")` and close with `hop_close_terminal`.

Safety tips:

- Keep one subagent per terminal.
- Do not queue a second instruction before reading the first response.
- For attached user sessions, confirm `agentPermitted` before sending input.

### Share a Local Web App

Expose a local HTTP or WebSocket service through your Hop tunnel:

```bash
hop session add myapp --port 3000
```

Result:

- local service stays on localhost
- Hop exposes it at `https://your-tunnel-url/s/myapp/`
- WebSocket apps work too

### Reattach Locally

Attach your local terminal client to an existing terminal session:

```bash
hop attach <session>
```

This is useful when you want a browser, an MCP client, and a local shell to converge on the same named session.
Local terminal sessions are persistent by default: they keep running in the Hay host if the local CLI detaches or the Hop daemon restarts. The local CLI status line shows `persists`; use `Ctrl+Q` inside the local Hop view to kill the session.

### Use Hop on Mobile

Hop’s mobile UI includes:

- a terminal-oriented accessory row with `Esc`, `Tab`, `Ctrl`, `Alt`, and arrows
- a native keyboard button for dictation, spellcheck, and autocomplete
- a floating menu for keyboard toggle and session switching
- draggable controls designed for one-handed use

## Operations

### Logging and History

Hop always writes per-session audit logs.

Default behavior:

- agent-created sessions get isolated shell history files
- user-created sessions keep normal shell history unless you opt into isolation
- TUI apps switch to diff-suppressed keyframe capture automatically

Paths:

- scratch sessions: `~/.hop2/runtime/history/<internal-session>.history`
- scratch audit logs: `~/.hop2/runtime/logs/<internal-session>/audit.ndjson`
- workspace-backed sessions: `~/.hop2/workspaces/<workspace>/history/<internal-session>.history`
- workspace-backed audit logs: `~/.hop2/workspaces/<workspace>/logs/<internal-session>/audit.ndjson`

Key tunables:

- `HOP_SESSION_HISTORY_SIZE`
- `HOP_AGENT_HISTORY_ISOLATION`
- `HOP_USER_HISTORY_ISOLATION`
- `HOP_AGENT_POST_START_HISTORY_INIT`
- `HOP_POST_START_HISTORY_INIT`
- `HOP_SESSION_AUDIT_INLINE_MAX_BYTES`
- `HOP_SESSION_TUI_KEYFRAME_INTERVAL_MS`
- `HOP_SESSION_TUI_KEYFRAME_TAIL_CHARS`
- `HOP_SESSION_TUI_KEYFRAME_MAX_LINES`

### Users, Domains, and Sharing

Admin flow:

1. Set a password with `hop password set`.
2. Configure a hostname with `hop domain hop.yourdomain.com`.
3. Add a user with `hop user add alice`.
4. Export credentials with `hop user export alice`.

User flow:

```bash
npm install -g hop2
hop client ./credentials.json
```

First run prompts for password setup and TOTP enrollment, then the user logs in at their assigned URL such as `https://alice.hop.yourdomain.com`.

### Security

- Password + TOTP is supported; password is required for custom domains
- Login cookies are `httpOnly`, `secure`, and `sameSite=lax`
- Browser sessions persist across `hop stop/start` by default through a stable session secret
- The local server binds only to `127.0.0.1`
- Cloudflare Tunnel provides end-to-end TLS

Secrets are stored in `~/.hop2/`. Set `HOP_PERSIST_SESSION_SECRET=0` if you want login cookies invalidated on every daemon restart.

### Runtime and Recovery

Hop uses the external Hay host runtime for PTY hosting and session recovery.

- active PTYs live in a separate local hay-host process
- the host survives daemon restarts
- host state is tracked in `~/.hop2/.hay-host-state`
- startup reconciles already-running Hay sessions before applying workspace state
- `HOP_TERMINAL_BACKEND` is accepted only for compatibility and ignored

## Reference

### Related Docs

- [README-MCP.md](./README-MCP.md) for MCP tools, helper wrappers, and agent-driving patterns
- [INTEGRATION.md](./INTEGRATION.md) for the current Hop/Hay architecture
- [hay/README.md](./hay/README.md) for the vendored Hay workspace

### Commands

| Command | Description |
|---------|-------------|
| `hop` | Start hop daemon/tunnel if needed, then launch a local terminal. Unnamed launches do not reuse a session that already has a local CLI attached. |
| `hop attach all` | Attach sequentially to all terminal sessions |
| `hop local [session]` | Start a daemonless local terminal (`[session]` attaches if it exists) |
| `hop url` | Print current tunnel URL |
| `hop qr` | Show QR code for current tunnel URL |
| `hop qr auth` | Show QR code for authenticator app setup |
| `hop domain <hostname>` | Set custom domain (named tunnel) |
| `hop domain-clear` | Remove custom domain, use random URLs |
| `hop password set` | Set/change password |
| `hop password clear` | Remove password protection |
| `hop user list` | List users |
| `hop user add <name>` | Add user + subdomain |
| `hop user remove <name>` | Remove user |
| `hop user export <name>` | Export user credentials |
| `hop session list` | List live terminal sessions |
| `hop session list --all` | Include saved definitions from all workspaces alongside live sessions |
| `hop session add <name> [--cwd P] --workspace W` | Save a terminal session definition to a named workspace |
| `hop session add <name> --port N --workspace W` | Save a port session definition to a named workspace |
| `hop workspace create <name>` | Create an empty workspace |
| `hop workspace show <name>` | Show saved definitions in a workspace |
| `hop workspace save <name>` | Save selected live terminal sessions into a workspace |
| `hop workspace load <name>` | Start sessions defined in a workspace |
| `hop workspace delete <name>` | Delete a workspace |
| `hop session rename <old> <new>` | Rename a session |
| `hop session remove <name>` | Remove a session |
| `hop client <credentials>` | Run hop with exported credentials |
| `hop wipe [--all]` | Remove workspace-defined sessions (`--all` also kills live sessions) |
| `quit` | Type at exit prompt to shut down the tunnel |

Local CLI mouse capture is off by default so terminal-native selection and context menus keep working. Use Option+M / Alt+M inside the local Hop view to toggle Hop mouse selection when needed. Use Option+B / Alt+B to toggle the status bar. CLI defaults live under `hay-cli` in `~/.hop.json`.

### Development

The Hay source is vendored in `./hay`. Hop serves `hay/apps/web/dist` when present.

```bash
npm run build
npm test
```

This rebuilds Hay and syncs `hay/apps/web/dist` into `hay-web/`. `npm test` runs a basic syntax sanity check on the main `hop` entrypoint. If `./hay` exists and the dist folder is missing, `hop` auto-builds Hay on startup.

## Troubleshooting

- Authenticator QR again: run `hop qr auth`
- Reset TOTP entirely: delete `.auth_secret` and restart Hop
- Reset a client install: delete `~/.hop2/clients/<tunnel-id>/` and run `hop client` again
- Tunnel not starting: install `cloudflared` with `brew install cloudflared`
- Tunnel returning `502` after a network change: run `hop health --restart`
- Stuck tunnel processes:

```bash
pkill cloudflared
```

## License

MIT
