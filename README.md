# 🐰 hop

**Hop into your terminal from anywhere in the world.**

Access your Mac's terminal from your phone, tablet, or any browser — secured with 2FA, tunneled through Cloudflare.

> **🍎 macOS only** — Requires Homebrew for dependencies (ttyd, tmux, cloudflared)

```
           (\(\ 
           ( -.-)    "hop into your shell"
           o_(")(")
```

## ✨ Features

- 🔐 **2FA Authentication** — Scan QR with any authenticator app
- 🌍 **Access Anywhere** — Cloudflare tunnel, no port forwarding
- 📱 **Mobile Friendly** — Works on phone browsers
- 🪟 **Multi-Session** — Create and switch between named sessions
- 🎨 **Modern UI** — Clean, minimal design
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
```

**First time:**
1. Scan the QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.)
2. Note the URL displayed
3. Press Enter to start your local session

**From your phone:**
1. Open the URL in browser
2. Enter the 6-digit code from your authenticator
3. Pick or create a session
4. 🐰 You're in!

## 🪟 Sessions

Create multiple independent terminal sessions from the Session Picker:

- **Create**: Type a name and click Create
- **Join**: Click Join on any existing session
- **Sessions are shared**: Multiple devices can view the same session

## 🔧 Commands

| Command | Description |
|---------|-------------|
| `hop` | Start hop (or attach to existing tunnel) |
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

- **TOTP 2FA** — Industry-standard time-based codes
- **Session cookies** — 7-day expiry, httpOnly
- **Local binding** — ttyd only listens on localhost
- **Cloudflare Tunnel** — End-to-end encrypted

## 🐛 Troubleshooting

**QR code not working?**
Delete `.auth_secret` and restart hop to generate a new code.

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
