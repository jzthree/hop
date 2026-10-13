// Same-machine fast path. On the Mac hop runs on, a page opened through the
// public hostname still sent every keystroke and scroll tick through
// Cloudflare and back (70–240 ms, spikes past 1 s) to a daemon a
// millisecond away. The daemon hands this login a ticket over the tunnel
// (/api/local-link); if a WebSocket to 127.0.0.1 accepts it, terminal
// sockets attach there instead. Everything else (API calls, the page itself)
// stays on the public hostname. Anywhere but that Mac the probe fails and
// nothing changes.

// Chrome asks once before a public page may reach this machine ("apps and
// services on this device"); the probe waits while that prompt is up. It runs
// beside the tunnel connection, so waiting costs nothing.
const PROBE_TIMEOUT_MS = 120_000;
const RETRY_AFTER_FAILURE_MS = 30_000;
const OPT_OUT_KEY = "hop.localLink"; // "off" disables the fast path in this browser

let localBase: string | null = null;
let probing = false;
let retryTimer = 0;
let onFound: (() => void) | null = null;

export const isLocalLinkUrl = (url: string) => /^ws:\/\/127\.0\.0\.1:\d+\//.test(url);

// The ws base terminal sockets should use instead of the page's own host,
// or null to use the page's host.
export const localWsBase = () => localBase;

export function localLinkEligible(
  loc: { protocol: string; hostname: string } = window.location,
  ua: string = navigator.userAgent,
  touchPoints: number = navigator.maxTouchPoints || 0
) {
  if (loc.protocol !== "https:") return false; // already local, or a dev server
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(loc.hostname)) return false;
  // Phones and tablets are never the machine hop runs on (iPadOS reports
  // itself as a Mac, but with touch points).
  if (/iPhone|iPad|Android|Mobile/i.test(ua)) return false;
  if (/Macintosh/.test(ua) && touchPoints > 1) return false;
  try { if (localStorage.getItem(OPT_OUT_KEY) === "off") return false; } catch { /* storage blocked */ }
  return true;
}

function probe(port: number, ticket: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let sock: WebSocket;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(ticket)}&probe=1`);
    } catch {
      finish(false);
      return;
    }
    sock.onmessage = (ev) => finish(ev.data === "ok");
    sock.onerror = () => finish(false);
    sock.onclose = () => finish(false);
  });
}

async function attempt() {
  if (probing || localBase) return;
  probing = true;
  try {
    const res = await fetch("/api/local-link", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json()) as { port?: number; ticket?: string };
    if (!Number.isInteger(body.port) || typeof body.ticket !== "string") return;
    if (!(await probe(body.port as number, body.ticket))) return;
    localBase = `ws://127.0.0.1:${body.port}/ws?token=${encodeURIComponent(body.ticket)}`;
    onFound?.();
  } catch {
    /* no fast path; the tunnel works as before */
  } finally {
    probing = false;
  }
}

// Probe once; `found` runs when terminal sockets should reconnect to use the
// fast path.
export function startLocalLink(found: () => void) {
  onFound = found;
  if (!localLinkEligible()) return;
  void attempt();
}

// A terminal socket to the fast path closed before it opened (the daemon
// restarted and forgot the ticket, or it stopped): use the tunnel, and look
// again a little later with a fresh ticket.
export function localLinkFailed() {
  if (!localBase) return;
  localBase = null;
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => void attempt(), RETRY_AFTER_FAILURE_MS);
}
