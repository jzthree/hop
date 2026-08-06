// Momentum ("flywheel") for MOUSE-wheel scrolling over terminal scrollback.
//
// Trackpads already glide: macOS/Windows synthesize a decaying stream of
// wheel events after the fingers lift, so adding our own inertia there would
// double it. A discrete mouse wheel gets no such stream — each notch is a
// fixed hop (scrollSensitivity lines) and paging through a long conversation
// means grinding the wheel. This adds the missing inertia: spin the wheel and
// the viewport keeps gliding, decaying exponentially, exactly like the native
// trackpad feel.
//
// Safety rules (why this is a util and not three lines):
// - Normal buffer only. On the alternate screen xterm translates wheel to
//   arrow keys / mouse reports for the app — inertia there would spray
//   keystrokes into vim/claude/less after the user stopped scrolling.
// - Discrete wheels only (see isDiscreteWheel) — trackpads keep native feel.
// - A single notch never glides: momentum engages only for a sustained spin
//   (3+ events in a burst), so precise one-line nudges stay precise.
// - Any keypress or click kills the glide instantly, and so does hitting
//   either end of the scrollback.

type TerminalLike = {
  scrollLines: (n: number) => void;
  buffer: { active: { type: string; viewportY: number } };
  modes?: { mouseTrackingMode?: string };
};

/** Lines this wheel event should move, mirroring xterm's own arithmetic. */
const wheelLines = (e: WheelEvent, opts: { linesPerNotch: number; lineHeightPx: () => number }) =>
  e.deltaMode === 1
    ? e.deltaY * opts.linesPerNotch
    : (e.deltaY / Math.max(1, opts.lineHeightPx())) * opts.linesPerNotch;

// WHO OWNS THE WHEEL. Momentum (and scrollback UI generally) is only honest
// when the TERMINAL owns scrolling: the normal buffer, with the app not
// tracking the mouse. Otherwise the app owns the wheel and we keep our hands
// off — xterm forwards the notch and the app scrolls its own view.
//
// Measured on the live fleet (2026-07-31): every Claude Code session runs
// ALT-SCREEN (?1049h) with mouse tracking on, so Claude is always in the
// app-owns-it branch — its transcript is its own to scroll, and there is no
// local scrollback behind it to move. Do not "improve" this by scrolling
// locally when tracking is on: a tracking app asked for wheel events, and
// stealing them breaks the very apps that requested them.
const terminalOwnsScrolling = (term: TerminalLike) =>
  term.buffer.active.type === "normal" && (term.modes?.mouseTrackingMode ?? "none") === "none";

/**
 * Classify a wheel event as a discrete mouse wheel (vs trackpad/magic mouse).
 * Line-mode deltas are always real wheels (Firefox). Pixel-mode heuristic:
 * wheel notches arrive as large integer deltas (multiples of the browser's
 * per-notch step, ~100px in Chrome); trackpad pans are small and/or
 * fractional and arrive in dense streams.
 */
export const isDiscreteWheel = (e: { deltaMode: number; deltaY: number }): boolean =>
  e.deltaMode === 1 || (Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));

export type FlywheelOptions = {
  /** Lines one wheel notch scrolls (mirror xterm's scrollSensitivity). */
  linesPerNotch: number;
  /** Pixel height of one terminal row (for pixel-mode delta → lines). */
  lineHeightPx: () => number;
  /**
   * Timestamp of the last output received from the session, when the caller
   * has one. Paces app-owned coasting: a tracking app repaints per wheel
   * step and each step costs a network round trip — a fixed-rate coast
   * outruns a distant app and queues repaints, which reads as scroll LAG.
   * With this signal each synthetic step waits for evidence the app kept up.
   */
  lastOutputAt?: () => number;
};

/**
 * Attach wheel-momentum to `el`, driving `getTerm()`'s viewport. The listener
 * is passive and never preventDefaults: xterm still performs its immediate
 * per-notch scroll, we only add the glide after the wheel stream goes idle.
 * Returns a dispose function.
 */
export const attachScrollFlywheel = (
  el: HTMLElement,
  getTerm: () => TerminalLike | null,
  opts: FlywheelOptions
): (() => void) => {
  let vel = 0; // lines/second, signed
  let carry = 0; // fractional-line remainder between frames
  let synthetic = false; // true while WE re-dispatch a wheel event
  let burst = 0; // wheel events in the current spin
  let lastWheelAt = 0;
  let lastFrameAt = 0;
  let raf = 0;
  let idleTimer = 0;

  const stopLocal = () => {
    if (raf) cancelAnimationFrame(raf);
    if (idleTimer) window.clearTimeout(idleTimer);
    raf = 0;
    idleTimer = 0;
    vel = 0;
    carry = 0;
    burst = 0;
  };

  // ---- App-owned scrolling (alt screen / mouse tracking) -------------------
  // The app scrolls itself, one step per wheel event. We re-dispatch wheel
  // events to give that stream a natural shape: a notch is worth a few steps,
  // and a spin coasts to a stop instead of halting dead. Re-dispatching (vs
  // encoding mouse reports ourselves) keeps xterm the single owner of the
  // wire format — whatever it sends for a real notch is exactly what it sends
  // for ours.
  const APP_STEPS_PER_NOTCH = 3;
  const APP_MAX_RATE = 90; // steps/sec — fast, still ordered
  let appVel = 0;
  let appCarry = 0;
  let appRaf = 0;
  let appIdle = 0;
  let appBurst = 0;
  let appLastAt = 0;
  let appTarget: EventTarget | null = null;
  let appProto: { deltaY: number; clientX: number; clientY: number } | null = null;

  const stopApp = () => {
    if (appRaf) cancelAnimationFrame(appRaf);
    if (appIdle) window.clearTimeout(appIdle);
    appRaf = 0;
    appIdle = 0;
    appVel = 0;
    appCarry = 0;
    appBurst = 0;
  };

  const stop = () => { stopLocal(); stopApp(); };

  const dispatchStep = () => {
    if (!appTarget || !appProto) return;
    synthetic = true;
    try {
      appTarget.dispatchEvent(new WheelEvent("wheel", {
        deltaY: appProto.deltaY,
        deltaMode: 0,
        clientX: appProto.clientX,
        clientY: appProto.clientY,
        bubbles: true,
        cancelable: true
      }));
    } catch {
      /* target detached mid-glide */
    } finally {
      synthetic = false;
    }
  };

  let lastStepAt = 0;
  const appGlide = (t: number) => {
    appRaf = 0;
    const term = getTerm();
    // Mode flipped (app exited, screen switched) or run out of speed.
    if (!term || terminalOwnsScrolling(term) || Math.abs(appVel) < 4) return stopApp();
    const dt = lastFrameAt ? Math.min(0.05, (t - lastFrameAt) / 1000) : 0.016;
    lastFrameAt = t;
    // ACK pacing: after each synthetic step, wait for the app to answer
    // (any output) before spending the next one — the coast then runs at
    // the link's real rhythm instead of flooding a slow one. 300ms cap so
    // an app that repaints invisibly (no bytes for us) can't stall the
    // glide forever.
    const ackAt = opts.lastOutputAt ? opts.lastOutputAt() : Infinity;
    const waitingForAck = lastStepAt > 0 && ackAt < lastStepAt && performance.now() - lastStepAt < 300;
    if (!waitingForAck) {
      appCarry += Math.abs(appVel) * dt;
      let steps = Math.trunc(appCarry);
      appCarry -= steps;
      if (steps > 0) lastStepAt = performance.now();
      while (steps-- > 0) dispatchStep();
      appVel *= Math.exp(-dt / 0.35);
    }
    appRaf = requestAnimationFrame(appGlide);
  };

  const appWheel = (e: WheelEvent) => {
    appTarget = e.target;
    appProto = { deltaY: e.deltaY, clientX: e.clientX, clientY: e.clientY };
    if (appRaf) { cancelAnimationFrame(appRaf); appRaf = 0; }

    const now = e.timeStamp || performance.now();
    const gap = now - appLastAt;
    appLastAt = now;
    if (gap > 250) appBurst = 0;
    appBurst += 1;

    // One notch already produced one step (the real event xterm just
    // forwarded); add the rest so a notch moves like a notch.
    for (let i = 1; i < APP_STEPS_PER_NOTCH; i++) dispatchStep();

    const rate = APP_STEPS_PER_NOTCH / (Math.min(Math.max(gap, 30), 200) / 1000);
    const signed = Math.sign(e.deltaY) * rate;
    appVel = Math.sign(signed) === Math.sign(appVel) ? 0.6 * signed + 0.4 * appVel : signed;
    appVel = Math.max(-APP_MAX_RATE, Math.min(APP_MAX_RATE, appVel));

    if (appIdle) window.clearTimeout(appIdle);
    appIdle = window.setTimeout(() => {
      appIdle = 0;
      if (appBurst >= 3 && Math.abs(appVel) >= 4) {
        lastFrameAt = 0;
        appRaf = requestAnimationFrame(appGlide);
      } else {
        stopApp();
      }
    }, 80);
  };

  const glide = (t: number) => {
    raf = 0;
    const term = getTerm();
    if (!term || !terminalOwnsScrolling(term) || Math.abs(vel) < 8) return stop();
    const dt = lastFrameAt ? Math.min(0.05, (t - lastFrameAt) / 1000) : 0.016;
    lastFrameAt = t;
    carry += vel * dt;
    const lines = Math.trunc(carry);
    if (lines !== 0) {
      carry -= lines;
      const before = term.buffer.active.viewportY;
      term.scrollLines(lines);
      if (term.buffer.active.viewportY === before) return stop(); // hit an edge
    }
    vel *= Math.exp(-dt / 0.35); // ~350ms decay time-constant
    raf = requestAnimationFrame(glide);
  };

  const onWheel = (e: WheelEvent) => {
    if (synthetic) return; // our own re-dispatch — never feed it back in
    const term = getTerm();
    if (!term) return;
    // App owns the wheel (alt screen, or mouse tracking on — i.e. every
    // Claude session). We must not scroll locally, but a terminal app moves
    // one step per wheel event, so a discrete wheel crawls a row at a time.
    // Give it the SAME feel a native scroll has: amplify each notch into a
    // few events, then coast with a decaying stream after the spin. The app
    // still does all the scrolling; we only shape the event rate.
    if (!terminalOwnsScrolling(term)) {
      stopLocal();
      if (isDiscreteWheel(e)) appWheel(e);
      else stopApp(); // trackpad: the OS already sends a dense glide
      return;
    }
    stopApp();
    // Trackpad: native inertia already glides; never double it.
    if (!isDiscreteWheel(e)) return stop();
    if (raf) { cancelAnimationFrame(raf); raf = 0; } // wheel resumes: rebuild, don't glide yet

    const now = e.timeStamp || performance.now();
    const gap = now - lastWheelAt;
    lastWheelAt = now;
    if (gap > 250) burst = 0;
    burst += 1;

    const notchLines = wheelLines(e, opts);
    const rate = notchLines / (Math.min(Math.max(gap, 30), 200) / 1000);
    // Same direction: blend toward the new rate. Direction flip: hard reset.
    vel = Math.sign(rate) === Math.sign(vel) ? 0.6 * rate + 0.4 * vel : rate;
    const CAP = 2500; // lines/s — fast, but never a teleport
    vel = Math.max(-CAP, Math.min(CAP, vel));

    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      // Momentum only for a sustained spin — a lone notch stays a fixed hop.
      if (burst >= 3 && Math.abs(vel) >= 8) {
        lastFrameAt = 0;
        raf = requestAnimationFrame(glide);
      } else {
        stop();
      }
    }, 80);
  };

  const kill = () => stop();
  // CAPTURE phase, but strictly observational (passive: we never
  // preventDefault). Capture is REQUIRED: when the app is tracking the
  // mouse, xterm's own handler calls stopPropagation() on the way out, so a
  // bubble-phase listener on this ancestor never runs at all — which is why
  // the app-scroll shaping below silently did nothing. Observing first lets
  // xterm do exactly what it always did, and lets us add steps around it.
  el.addEventListener("wheel", onWheel, { capture: true, passive: true });
  el.addEventListener("mousedown", kill, true);
  window.addEventListener("keydown", kill, true);
  return () => {
    stop();
    el.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
    el.removeEventListener("mousedown", kill, true);
    window.removeEventListener("keydown", kill, true);
  };
};
