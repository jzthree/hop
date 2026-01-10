# 🐰 hop

**Hop into your terminal from anywhere in the world.**

Access your Mac's terminal from your phone, tablet, or any browser — secured with password + 2FA, tunneled through Cloudflare.

> **🍎 macOS only** — Requires Homebrew for dependencies (ttyd, tmux, cloudflared)

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
npm install -g hop-shell
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

# Use iTerm control mode for local session
hop --iterm
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
npm install -g hop-shell
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

## 🖥️ iTerm Integration

```bash
hop --iterm
```

Uses tmux control mode (`-CC`) for native scrolling, copy/paste, splits, and search. Session remains accessible via web.

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
| `hop` | Start hop (or attach to existing tunnel) |
| `hop --iterm` | Use iTerm tmux control mode for local session |
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
| `hop wipe` | Kill all hop tmux sessions |
| `quit` | Type at exit prompt to shutdown tunnel |

## 📦 Dependencies

Installed automatically via Homebrew:
- `tmux` — Terminal multiplexer
- `ttyd` — Web terminal
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
- **Local Binding** — ttyd only listens on 127.0.0.1
- **End-to-End TLS** — Cloudflare Tunnel encryption

**Passwords:** Recommended for any public URL; required for custom domains.

**Secrets:** Stored in `~/.hop-shell/` (treat like `~/.ssh/`)

## 🐛 Troubleshooting

**QR code not working?**
Delete `.auth_secret` and restart hop to generate a new code.

**Client reset (user mode)?**
Delete `~/.hop-shell/clients/<tunnel-id>/` and run `hop client` again.

**Tunnel not starting?**
Make sure `cloudflared` is installed: `brew install cloudflared`

**Stuck processes?**
```bash
pkill ttyd; pkill cloudflared; tmux kill-server
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
