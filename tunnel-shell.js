#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const httpProxy = require('http-proxy');
const { authenticator } = require('otplib');
const qrcode = require('qrcode-terminal');
const cookie = require('cookie');

// --- Configuration ---
const TTYD_PORT = Math.floor(Math.random() * (60000 - 10000 + 1) + 10000);
const PROXY_PORT = TTYD_PORT + 1;
const SESSION_NAME = `remote-${crypto.randomBytes(3).toString('hex')}`;
const AUTH_SECRET = authenticator.generateSecret();
const SESSION_COOKIE_NAME = 'tunnel_session';
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// Colors
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";

function log(msg, color = RESET) {
    console.log(`${color}${msg}${RESET}`);
}

async function runCommand(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { stdio: 'inherit', ...opts });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Command ${command} exited with code ${code}`));
        });
        proc.on('error', (err) => reject(err));
    });
}

// ... Dependency check unchanged ...
async function checkAndInstallDependencies() {
    log(`[1/5] Checking dependencies...`, BOLD);
    try { await runCommand('brew', ['--version'], { stdio: 'ignore' }); }
    catch (e) { log(`Error: Homebrew missing.`, RED); process.exit(1); }

    const deps = ['tmux', 'ttyd', 'cloudflared'];
    for (const dep of deps) {
        try {
            await runCommand('which', [dep], { stdio: 'ignore' });
            log(`  - ${dep} found.`, GREEN);
        } catch (e) {
            log(`  - ${dep} NOT found. Installing...`, YELLOW);
            try {
                await runCommand('brew', ['install', dep]);
                log(`  - ${dep} installed.`, GREEN);
            } catch (err) {
                log(`  - Failed to install ${dep}. Check Xcode license?`, RED);
                process.exit(1);
            }
        }
    }
}

function startTtyd() {
    log(`[2/5] Starting Secure Shell (ttyd) on port ${TTYD_PORT}...`, BOLD);
    const logFile = fs.openSync(path.join(__dirname, 'ttyd.log'), 'w');

    // ttyd listens on localhost only. No auth here (proxy handles it).
    // We bind to 127.0.0.1 to allow only the proxy to talk to it.
    const ttyd = spawn('ttyd', [
        '-p', TTYD_PORT.toString(),
        '-i', '127.0.0.1',
        '-W',
        'tmux', 'new-session', '-A', '-s', SESSION_NAME, 'zsh'
    ], {
        stdio: ['ignore', logFile, logFile],
        detached: false
    });

    ttyd.on('error', (err) => { log(`Failed TTYD: ${err.message}`, RED); process.exit(1); });
    return ttyd;
}

function startAuthProxy() {
    log(`[3/5] Starting Local 2FA Proxy on port ${PROXY_PORT}...`, BOLD);

    const proxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${TTYD_PORT}`, ws: true });

    const server = http.createServer((req, res) => {
        // Parse cookie
        const cookies = cookie.parse(req.headers.cookie || '');
        const isAuthenticated = cookies[SESSION_COOKIE_NAME] === SESSION_SECRET;

        // Login Page
        if (!isAuthenticated) {
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    const params = new URLSearchParams(body);
                    const token = params.get('token');

                    try {
                        if (authenticator.check(token, AUTH_SECRET)) {
                            res.setHeader('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, SESSION_SECRET, {
                                httpOnly: true,
                                maxAge: 60 * 60 * 24 * 7 // 1 week
                            }));
                            res.writeHead(302, { 'Location': '/' });
                            res.end();
                        } else {
                            res.writeHead(401, { 'Content-Type': 'text/html' });
                            res.end('Invalid Code. <a href="/">Try Again</a>');
                        }
                    } catch (e) {
                        res.writeHead(401);
                        res.end('Error verifying code');
                    }
                });
            } else {
                // Return Login HTML
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
                    <html>
                        <head>
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                            <style>
                                body { font-family: -apple-system, sans-serif; background: #111; color: #eee; display: flex; justify-content: center; align-items: center; height: 100vh; margin:0; }
                                .box { background: #222; padding: 2rem; border-radius: 8px; text-align: center; }
                                input { font-size: 2rem; width: 150px; text-align: center; margin-bottom: 1rem; border-radius: 4px; border: none; padding: 0.5rem; }
                                button { font-size: 1.2rem; padding: 0.5rem 2rem; background: #0070f3; color: white; border: none; border-radius: 4px; cursor: pointer; }
                            </style>
                        </head>
                        <body>
                            <div class="box">
                                <h2>Secure Shell Login</h2>
                                <form method="POST">
                                    <input type="text" name="token" pattern="[0-9]*" inputmode="numeric" placeholder="123456" autofocus autocomplete="one-time-code">
                                    <br>
                                    <button type="submit">Verify</button>
                                </form>
                            </div>
                        </body>
                    </html>
                `);
            }
            return;
        }

        // Authenticated -> Proxy to ttyd
        proxy.web(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
        const cookies = cookie.parse(req.headers.cookie || '');
        if (cookies[SESSION_COOKIE_NAME] === SESSION_SECRET) {
            proxy.ws(req, socket, head);
        } else {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
        }
    });

    server.listen(PROXY_PORT, '127.0.0.1');
    return server;
}

function startTunnel() {
    log(`[4/5] Opening Cloudflare Tunnel...`, BOLD);
    // Tunnel points to PROXY_PORT now, not TTYD_PORT
    const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PROXY_PORT}`]);
    let urlFound = false;

    return new Promise((resolve) => {
        tunnel.stderr.on('data', (data) => {
            if (urlFound) return;
            const output = data.toString();
            const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);

            if (match) {
                const publicUrl = match[0];
                if (publicUrl.includes('api.trycloudflare.com')) return;

                urlFound = true;

                console.clear();
                log(`\n==================================================`, GREEN);
                log(`            >>>  TUNNEL LIVE  <<<`, BOLD + GREEN);
                log(`==================================================\n`, GREEN);
                log(`1. Scan this QR Code with your Authenticator App:`, YELLOW);

                qrcode.generate(`otpauth://totp/TunnelShell?secret=${AUTH_SECRET}&issuer=TunnelShell`, { small: true });

                log(`\n2. Access your shell at:`, RESET);
                log(`   ${publicUrl}`, BOLD + CYAN);
                log(`\n--------------------------------------------------`, RESET);

                // Wait for user to scan
                const readline = require('readline');
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

                log(`\n[ACTION REQUIRED]`, YELLOW + BOLD);
                rl.question('Scan the QR code above, then press ENTER to launch your session...', () => {
                    rl.close();
                    resolve({ tunnel, publicUrl });
                });
            }
        });
    });
}

async function main() {
    await checkAndInstallDependencies();
    const ttydProc = startTtyd();
    const proxyServer = startAuthProxy();
    const { tunnel: tunnelProc, publicUrl } = await startTunnel();

    log(`[5/5] Attaching to local session...`, BOLD);

    const tmux = spawn('tmux', ['new-session', '-A', '-s', SESSION_NAME, 'zsh'], { stdio: 'inherit' });

    setTimeout(() => {
        spawn('tmux', ['set-option', '-t', SESSION_NAME, 'status', 'on']);
        spawn('tmux', ['set-option', '-t', SESSION_NAME, 'status-right-length', '200']);
        spawn('tmux', ['set-option', '-t', SESSION_NAME, 'status-right', ` #[fg=black,bg=green]  REMOTE: ${publicUrl}  #[default] `]);
        spawn('tmux', ['set-option', '-t', SESSION_NAME, 'mouse', 'on']);
    }, 1000);

    tmux.on('close', () => {
        log(`\nLocal session ended. Shutting down tunnel...`, YELLOW);
        ttydProc.kill();
        tunnelProc.kill();
        proxyServer.close();
        process.exit(0);
    });

    const cleanup = () => {
        ttydProc.kill();
        tunnelProc.kill();
        proxyServer.close();
        process.exit();
    }
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

main().catch(err => {
    log(`Fatal: ${err.message}`, RED);
    process.exit(1);
});
