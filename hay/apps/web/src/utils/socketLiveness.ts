// A terminal socket can die without ever saying so: an upgrade that hangs in
// CONNECTING through a stalled tunnel, or an OPEN socket whose other end
// vanished while the laptop slept. Neither fires close, so a view waiting on
// close to reconnect stays stranded until someone refreshes or goes full
// screen. This watches one socket and, when it is dead, closes it and fires
// a close event at the view's own handlers — every view already knows how
// to reconnect from there.
//
// Call it right after `new WebSocket(...)`, before the view adds its own
// close handler: the real close that follows a synthetic one is swallowed,
// which only works from a listener registered first.

export const CONNECT_DEADLINE_MS = 8000;
// Quiet this long on an open socket → ask the server for a pong.
export const PING_AFTER_MS = 15000;
// No frame of any kind this long after the ping → the socket is dead.
export const PONG_DEADLINE_MS = 8000;
const TICK_MS = 2500;
// A tick this late means the machine slept (or the tab was frozen).
const WAKE_GAP_MS = 20000;

export const watchLiveness = (sock: WebSocket, now: () => number = Date.now) => {
  const started = now();
  let lastHeard = started;
  let pingSentAt = 0;
  let lastTick = started;
  let connectFrom = started;
  let faked = false;

  const stop = () => window.clearInterval(timer);
  const dead = () => {
    stop();
    faked = true;
    try { sock.close(); } catch { /* already closing */ }
    sock.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "liveness" }));
  };
  const ping = (t: number) => {
    pingSentAt = t;
    try { sock.send(JSON.stringify({ type: "ping", t })); } catch { dead(); }
  };

  sock.addEventListener("message", () => { lastHeard = now(); });
  sock.addEventListener("open", () => { lastHeard = now(); });
  // The first close after a fake is the fake; any later one is the
  // browser's own and must not reconnect a second time.
  let closesSeen = 0;
  sock.addEventListener("close", (e) => {
    stop();
    if (faked && ++closesSeen > 1) e.stopImmediatePropagation();
  });

  const timer = window.setInterval(() => {
    const t = now();
    const woke = t - lastTick > WAKE_GAP_MS;
    lastTick = t;
    if (sock.readyState === WebSocket.CONNECTING) {
      // A wake resets the clock: the handshake gets its full time on a
      // network that is back, not one that was asleep.
      if (woke) connectFrom = t;
      else if (t - connectFrom > CONNECT_DEADLINE_MS) dead();
      return;
    }
    if (sock.readyState !== WebSocket.OPEN) { stop(); return; }
    // After a sleep, check at once rather than trust a pre-sleep ping.
    if (woke) { ping(t); return; }
    if (pingSentAt && lastHeard < pingSentAt) {
      if (t - pingSentAt > PONG_DEADLINE_MS) dead();
      return;
    }
    if (t - lastHeard > PING_AFTER_MS) ping(t);
  }, TICK_MS);

  return stop;
};
