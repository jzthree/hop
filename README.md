# 🐰 hop

**Hop into your terminal from anywhere in the world.**

Access your Mac's terminal from your phone, tablet, or any browser — secured with password + 2FA, tunneled through Cloudflare.

> **🍎 macOS/Linux** — Requires cloudflared for tunneling

```
           (\(\ 
           ( -.-)    "hop into your shell"
           o_(")(")
```

## ✨ Features

- 🔐 **Password + 2FA** — Optional password plus TOTP (required for custom domains)
- 🌍 **Access Anywhere** — Cloudflare tunnel, no port forwarding
- 🌐 **Custom Domains + Multi‑User** — Share subdomains with per‑user credentials
- 📱 **Mobile Virtual Keyboard** — Custom keyboard with Esc, Ctrl, Alt, arrows, and more
- ⌨️ **Native Keyboard Support** — Tap the blue button for dictation, spellcheck & autocomplete
- 🪟 **Multi-Session** — Create and switch between named sessions
- 🔌 **Port Sessions** — Proxy a local HTTP/WS service via hop
- 🔄 **Quick Session Switching** — Floating menu to switch sessions without leaving the terminal
- 🎨 **Modern UI** — Clean, minimal iOS-style design
- ⚡ **Auto-Attach** — Multiple terminals share the same tunnel

## 🚀 Quick Install

### From npm (easiest)

```bash
npm install -g hop2
```

Then just run:
```bash
hop
```

### One-liner from source

```bash
git clone https://github.com/jzthree/hop.git ~/.hop && \
cd ~/.hop && npm install && \
sudo ln -sf ~/.hop/hop /usr/local/bin/hop
```

### Manual Install from source

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

## 🐰 Usage

```bash
# Start hopping!
hop
```

**First time:**
1. (Optional) Set a password: `hop password set`
2. Scan the QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.)
3. Note the URL displayed
4. Press Enter to start your local session

**From your phone:**
1. Open the URL in your browser
2. Enter your password (if enabled) and 6‑digit code
3. Pick or create a session
4. 🐰 You're in! Use the virtual keyboard for terminal keys, or tap the blue button for native input

## 🪟 Sessions

Create multiple independent terminal sessions from the Session Picker (`/sessions`):

- **Create**: Type a name and click Create
- **Join**: Click Join on any existing session
- **Sessions are shared**: Multiple devices can view the same session

You can also create **Port Sessions** that proxy to a local HTTP/WS service on your machine.
Use the Session Picker or:
```bash
hop session add myapp --port 3000
```

## 🧾 Session History & Audit Logs

Hop always writes per-session audit logs.
Shell history isolation is role-based by default:

- Agent-created terminal sessions: isolated history file per session
- User-created terminal sessions: keep your shell default history file (opt-in isolation available)

- Isolated history file path: `~/.hop2/workspaces/<workspace>/history/<internal-session>.history`
- Audit log (NDJSON): `~/.hop2/workspaces/<workspace>/logs/<internal-session>/audit.ndjson`
- Audit events include `session_start`, `input`, `resize`, `session_end`, plus:
- `audit_mode` / `pty_state` transitions (auto-switches between `stream` and `tui_keyframe`)
- `tui_keyframe` snapshots (diff-suppressed; emitted only when content changes)
- `command_launch` metadata (captures launched command token and detected agent CLI type)
- Large input/output chunks are truncated with metadata (`bytes`, `omittedBytes`, `dataHead`, `dataTail`)

Tunable defaults:

- `HOP_SESSION_HISTORY_SIZE` (default `5000`)
- `HOP_AGENT_HISTORY_ISOLATION` (default `1`)
- `HOP_USER_HISTORY_ISOLATION` (default `0`)
- `HOP_AGENT_POST_START_HISTORY_INIT` (default `1`)
- `HOP_POST_START_HISTORY_INIT` (default `0`, forces post-start history init for all sessions)
- `HOP_SESSION_AUDIT_INLINE_MAX_BYTES` (default `4096`)
- `HOP_SESSION_TUI_KEYFRAME_INTERVAL_MS` (default `750`)
- `HOP_SESSION_TUI_KEYFRAME_TAIL_CHARS` (default `20000`)
- `HOP_SESSION_TUI_KEYFRAME_MAX_LINES` (default `80`)

## 🌐 Custom Domains & Multi‑User

### Admin (your machine)
1. Set a password (required for custom domains):
   ```bash
   hop password set
   ```
2. Configure your domain:
   ```bash
   hop domain hop.yourdomain.com
   ```
3. Add a user + export credentials:
   ```bash
   hop user add alice
   hop user export alice
   ```
4. Send the exported folder to the user.

### User (their machine)
```bash
npm install -g hop2
hop client ./credentials.json
```
First run prompts them to set a password + scan a TOTP QR code.  
They then log in at their URL, e.g. `https://alice.hop.yourdomain.com`.

## 📱 Mobile Keyboard

On mobile devices, Hop provides a custom virtual keyboard designed for terminal use:

**Accessory Row:**
- `Esc` `Tab` `Ctrl` `Alt` — Essential terminal keys
- `← ↓ ↑ →` — Arrow keys for navigation
- 🔵 **Blue keyboard button** — Opens native iOS keyboard for dictation, spellcheck & autocomplete

**Floating Menu (top-right button):**
- **Toggle Keyboard** — Show/hide the virtual keyboard
- **Session List** — Quick-switch between sessions
- **All Sessions** — Return to session picker

**Tips:**
- The floating button is draggable — move it anywhere
- First-time users will see a tooltip pointing to the native keyboard button
- Use the native keyboard for longer text input with autocomplete

## 🖥️ Local Attach

```bash
hop attach <session>
```

Attach your local terminal client to an existing hop terminal session.

## 🔌 Port Sessions

Expose local HTTP/WebSocket services through your tunnel:

```bash
hop session add myapp --port 3000
# Access at: https://your-tunnel-url/s/myapp/
```

Works with dev servers, Jupyter, APIs — anything on localhost. Supports WebSocket.

## 🔧 Commands

| Command | Description |
|---------|-------------|
| `hop` | Start hop daemon/tunnel if needed, then launch a local terminal |
| `hop attach all` | Attach sequentially to all terminal sessions |
| `hop local [session]` | Start a daemonless local terminal (`[session]` attaches if it exists) |
| `hop url` | Print current tunnel URL |
| `hop qr` | Show QR code for current URL |
| `hop domain <hostname>` | Set custom domain (named tunnel) |
| `hop domain-clear` | Remove custom domain, use random URLs |
| `hop password set` | Set/change password |
| `hop password clear` | Remove password protection |
| `hop user list` | List users |
| `hop user add <name>` | Add user + subdomain |
| `hop user remove <name>` | Remove user |
| `hop user export <name>` | Export user credentials |
| `hop session list` | List sessions |
| `hop session add <name>` | Create a terminal session |
| `hop session add <name> --port N` | Create a port session (proxy) |
| `hop session remove <name>` | Remove a session |
| `hop client <credentials>` | Run hop with exported credentials |
| `hop wipe` | Remove all hop sessions |
| `quit` | Type at exit prompt to shutdown tunnel |

Startup behavior:
- Hop reconciles already-running external Hay sessions first, then applies the default workspace as additional startup state.

## 🧪 Terminal Backend

Hop always uses the `external` terminal runtime (PTYs in a separate local hay host process).

- The host persists across hop daemon restarts.
- Host state is tracked in `~/.hop2/.hay-host-state`.
- On startup and session listing, Hop discovers live hay-host processes and adopts the one(s) that still own runtime rooms if the state file is stale.
- Local CLI transport is direct to hay-host; daemon restarts do not terminate local terminal sessions.
- Bare `hop` prompts on cwd match (`Attach existing` vs `Create new`, default `Create new`); non-interactive runs always create new.
- `HOP_TERMINAL_BACKEND` is accepted for compatibility but ignored.

## 📦 Dependencies

Installed automatically via Homebrew:
- `cloudflared` — Cloudflare tunnel

Node.js packages:
- `http-proxy` — Request proxying
- `otplib` — TOTP authentication
- `qrcode-terminal` — QR code display
- `cookie` — Session cookies

## 🛡️ Security

- **Password + TOTP** — Password optional, but required for custom domains
- **Rate Limiting** — Exponential backoff on failed attempts
- **Secure Cookies** — `httpOnly`, `secure`, `sameSite=lax`
- **Random URL** — Unguessable tunnel URL for quick tunnels
- **Fixed URL** — Custom domains keep a stable URL
- **Local Binding** — Server only listens on 127.0.0.1
- **End-to-End TLS** — Cloudflare Tunnel encryption

**Passwords:** Recommended for any public URL; required for custom domains.

**Secrets:** Stored in `~/.hop2/` (treat like `~/.ssh/`)

## 🛠 Development (Hay)

The hay source is vendored in `./hay`. Hop will serve `hay/apps/web/dist` when present.

```bash
npm run build
```

This builds hay (web + cli) and syncs `hay/apps/web/dist` into `hay-web/` for Hop to serve.
If `./hay` exists and the dist folder is missing, `hop` will auto-build hay on startup.

## 🤖 Hop MCP (One Subagent Terminal)

Use one dedicated terminal when driving a subagent CLI through Hop MCP.

1. Create a terminal with `hop_create_terminal` (set `name` and `cwd`).
2. Start the agent CLI with `hop_write_terminal` (`claude` or `codex`).
3. Wait for readiness with `hop_wait_terminal(until_prompt=true)`.
4. Send one instruction at a time via `hopx_send_and_wait` (or `hop_write_terminal` + `hop_wait_terminal`).
5. Optional helper path: use `hopx_agent_turn(mode="auto")` for a single send+wait turn with mode-aware output (`ui` for TUI screens, `readable_raw` otherwise); it auto-promotes to `ui` if alternate-screen starts mid-turn and uses lean capture defaults (`capture_max_events=60` for readable modes, `0` for `ui` unless overridden, plus `text_only=true` by default for readable waits).
6. For long waits, prefer `hopx_agent_turn(async=true, ...)` and continue with `hopx_agent_turn(wait_id=..., wait=true, control="wait")`; fall back to `hop_wait_start(...)` / `hop_wait_poll(...)` when you want the lower-level primitives directly.
7. After each turn, collect output with `hop_wait_terminal` or incremental `hop_read_terminal` cursor reads.
8. Interrupt with `hop_send_key(key="ctrl_c")` and close using `hop_close_terminal`.

Safety tips:
- Keep one subagent per terminal.
- Do not queue a second instruction before reading the first response.
- For attached user sessions, confirm `agentPermitted` before sending input.

## 🐛 Troubleshooting

**QR code not working?**
Delete `.auth_secret` and restart hop to generate a new code.

**Client reset (user mode)?**
Delete `~/.hop2/clients/<tunnel-id>/` and run `hop client` again.

**Tunnel not starting?**
Make sure `cloudflared` is installed: `brew install cloudflared`

**Tunnel returns 502 or died after network changes?**
Run `hop health --restart`. Hop now waits for the public URL to become healthy again instead of only sending a fire-and-forget restart request.

**Stuck processes?**
```bash
pkill cloudflared
```

## 📝 License

MIT

---

Made with 🐰 for hopping around

```
   ____
  /    \
 | ^  ^ |     hop hop hop
 |  ..  |
  \ -- /
   ||||
```
