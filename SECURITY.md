# Security

Hop puts a shell on the public internet on purpose. This page says exactly what
stands between the internet and that shell, what an attacker who gets past it
can do, and how to report a hole.

## Reporting

Email **jianzhou@uchicago.edu** with "hop security" in the subject. Please do
not open a public issue for anything exploitable. You will get an
acknowledgement within a few days and a fix or a plan within two weeks for
anything confirmed.

## Threat model

- **In scope:** an attacker on the internet reaching your tunnel URL; a
  stranger who obtained a device's cookie; a lab member on a shared landing
  host trying to reach another member's instance; an agent (yours or a
  prompt-injected one) doing more than you meant through the MCP surface.
- **Out of scope:** an attacker who already has your local user account, your
  Cloudflare account, or root on the machine. Hop runs as you; it cannot
  protect you from you.

## How a request gets in

1. **TLS and the tunnel.** The daemon binds `127.0.0.1` only. Cloudflare
   Tunnel terminates TLS at Cloudflare and connects to the daemon over
   loopback. Nothing listens on a public port.
2. **Login.** One of:
   - password (scrypt, salted) **plus** a TOTP code (`otplib`, 30-second
     steps), or
   - a passkey (WebAuthn; Touch ID, Face ID, security key), enrolled from an
     already-authenticated session and bound to the hostname.
   Failed attempts back off per IP: 5 failures → 30 s, doubling.
3. **Per-device sessions.** A successful login mints a random 256-bit token
   for *that device* (stored only as a SHA-256 hash in
   `~/.hop2/.auth-sessions.json`, mode 0600), set as an `httpOnly`, `Secure`,
   `SameSite=Lax`, host-scoped cookie valid for **30 days**
   (`HOP_SESSION_TTL_DAYS`). `hop auth` lists devices; `hop auth revoke <id>`
   logs one out; `hop auth revoke --all` logs everyone out. Logging out
   revokes the session server-side.
4. **Local processes.** The hop CLI, MCP server and hay talk to the daemon
   with a per-install secret (`~/.hop2/.session_secret`, 0600) as an
   `Authorization: Bearer` header. That secret is **never** accepted as a
   cookie, and in a WebSocket `?token=` query only on a direct loopback
   connection (never through the tunnel). `hop auth token` mints a
   revocable device token for apps and scripts instead.

## Password is required for remote access

TOTP alone is one factor. Hop will not open the public tunnel until a
password is set (`hop password set`). If you genuinely want
authenticator-only login — say, behind Cloudflare Access — opt out with
`hop config totp-only on`; `hop status` shows the policy in force.

## What an authenticated user can do

Everything you can do in a terminal on that machine, as your user. There is
no sandbox between the browser and the PTY. Treat the login page as the only
boundary, and treat MCP access the same way: an MCP client that can reach the
daemon can run `hopx_exec`.

## Agents

`hopx_spawn_agent` launches Claude Code with `--permission-mode
bypassPermissions` by default so delegated work never parks on a prompt.
Cap that on any host you do not fully trust with
`hop config agent-ceiling <mode>` (for example `acceptEdits`); requests above
the ceiling are clamped and the clamp is reported in the tool result. The
Codex preset drops its approval bypass and runs `--full-auto` (sandboxed)
under any ceiling below the top. This is a safety rail against agent
accidents, not a security boundary: MCP access already means shell access.

## Audit logs

Every session's input and output is recorded to
`~/.hop2/**/logs/<session>/audit.ndjson`. It is a plaintext record of
everything typed, including anything pasted into the terminal. The daemon
rotates each file at 64 MB (`HOP_SESSION_AUDIT_MAX_MB`), keeps 5 rotations
(`HOP_SESSION_AUDIT_KEEP`), and deletes a *dead* session's log directory 90
days after its last write (`HOP_SESSION_AUDIT_RETENTION_DAYS`; 0 disables).
Live sessions are never swept. If you need shorter retention for compliance,
lower the day count; if you need none, set it to 0 and manage the directory
yourself.

## Multi-user hosts and self-service signup

Each lab member runs their own daemon on their own machine. The admin's
daemon only issues subdomains and tunnels. Cookies are host-scoped (no
`Domain=`), so one member's session never reaches another's host. Signup is
off by default, requires an explicit allowed email domain
(`hop registration domain <d>`), and gates identity through either a mailed
confirmation link or a verified Cloudflare Access JWT. An approved user can
serve anything they like at their subdomain; only approve people you would
give a subdomain of your own domain to.

## Files that are secrets

Under `~/.hop2/` (all 0600): `.auth_secret` (TOTP seed), `.password_hash`,
`.session_secret` (local IPC), `.auth-sessions.json` (session hashes),
`.passkeys.json` (public keys only), tunnel credentials/tokens, and the
`workspaces/**/logs` audit trail. Back them up like passwords.
