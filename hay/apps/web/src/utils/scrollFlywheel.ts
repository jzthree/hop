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
// - Normal buffer only for LOCAL momentum. On the alternate screen xterm
//   translates wheel to arrow keys / mouse reports for the app — local
//   inertia there would spray keystrokes into vim/claude/less after the
//   user stopped scrolling.
// - In LOCAL scrollback, discrete wheels only (see isDiscreteWheel) —
//   trackpads keep the OS's native glide; doubling it felt drunk.
// - In APP-OWNED scrolling the rule inverts for trackpads: the OS momentum
//   stream is hundreds of events, each of which xterm turns into a wire
//   mouse-report costing a network round trip. Forwarded 1:1 it floods a
//   remote app into scroll LAG (the transcript keeps moving long after the
//   fingers stop). So there we take ownership: coalesce the stream into
//   line-sized steps and pace them by the app's own acknowledgements —
//   instant when local, matched to the link when remote.
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
  const APP_MAX_RATE = 70; // steps/sec — fast, still ordered
  // Remote scrolling physics: every step is a round trip (report up, full
  // repaint down) and the app repaints ONCE per input batch it drains. So:
  // batch lines per dispatch in proportion to speed (one repaint moves
  // several lines instead of one), and keep a small window of unacked
  // bursts in flight to hide the RTT — serialized one-line-per-RTT was the
  // jerk. Slow speeds still step one line per burst: precision unharmed.
  const APP_ACK_WINDOW = 2;   // bursts in flight before we hold
  const APP_MAX_BURST = 5;    // lines per burst at full speed
  const burstFor = (vel: number) =>
    Math.max(1, Math.min(APP_MAX_BURST, Math.round(Math.abs(vel) / 20)));
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
    panPx = 0;
    panPending = 0;
    unacked = 0;
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
  let unacked = 0; // bursts dispatched with no output seen since
  const appGlide = (t: number) => {
    appRaf = 0;
    const term = getTerm();
    // Mode flipped (app exited, screen switched) or run out of speed.
    if (!term || terminalOwnsScrolling(term)) return stopApp();
    if (panPending === 0 && Math.abs(appVel) < coastMin()) {
      // Out of momentum — but a live finger stream may still be mid-gesture
      // with sub-line px accumulated (a slow precise drag has ~zero
      // velocity). Park the loop WITHOUT wiping that accumulation; the next
      // pan event restarts it, and the idle timer sweeps up if none comes.
      if (appIdle) { appRaf = 0; return; }
      return stopApp();
    }
    const dt = lastFrameAt ? Math.min(0.05, (t - lastFrameAt) / 1000) : 0.016;
    lastFrameAt = t;
    // ACK pacing: after each synthetic step, wait for the app to answer
    // (any output) before spending the next one — the coast then runs at
    // the link's real rhythm instead of flooding a slow one. 300ms cap so
    // an app that repaints invisibly (no bytes for us) can't stall the
    // glide forever.
    // Windowed ACK pacing: any output since the last burst clears the
    // window (the app is keeping up); otherwise up to APP_ACK_WINDOW bursts
    // may be in flight before we hold. The 300ms cap keeps an app that
    // repaints invisibly (no bytes for us) from stalling the glide forever.
    const ackAt = opts.lastOutputAt ? opts.lastOutputAt() : Infinity;
    if (ackAt > lastStepAt) unacked = 0;
    const waitingForAck = lastStepAt > 0 && unacked >= APP_ACK_WINDOW
      && performance.now() - lastStepAt < 300;
    if (!waitingForAck) {
      if (panPending !== 0) {
        // Finger-driven lines first: drain the coalesced pan queue in
        // speed-proportional bursts — the app repaints once per burst, so
        // a burst of 4 costs one round trip where 4 singles cost four.
        const spend = Math.sign(panPending)
          * Math.min(Math.abs(panPending), burstFor(appVel || panPending));
        panPending -= spend;
        if (spend !== 0) {
          lastStepAt = performance.now();
          unacked += 1;
          if (appProto) appProto.deltaY = Math.sign(spend) * 120;
          for (let i = 0; i < Math.abs(spend); i++) dispatchStep();
        }
      } else {
        appCarry += Math.min(APP_MAX_RATE, Math.abs(appVel)) * dt;
        const steps = Math.min(Math.trunc(appCarry), burstFor(appVel));
        if (steps > 0) {
          appCarry -= steps;
          lastStepAt = performance.now();
          unacked += 1;
          if (appProto) appProto.deltaY = Math.sign(appVel) * 120;
          for (let i = 0; i < steps; i++) dispatchStep();
        }
        appVel *= Math.exp(-dt / 0.24);
      }
    }
    appRaf = requestAnimationFrame(appGlide);
  };

  // ---- App-owned TRACKPAD panning -----------------------------------------
  // The finger stream is coalesced into whole-line steps and drained by the
  // same ACK-paced loop the wheel coast uses. panPx carries the sub-line
  // remainder, so slow precise drags still land exactly one step as they
  // cross each line boundary.
  let panPx = 0;
  let panPending = 0; // signed whole steps waiting to be dispatched
  let panLastAt = 0;
  let panMode = false; // last input was a finger stream, not a wheel
  // Trackpads NEVER self-coast: macOS keeps emitting decaying momentum
  // events after the fingers lift — that stream IS the coast, and it feeds
  // the pan queue. Adding our own decay on top gave every flick two glides
  // stacked, which read as overshoot. Only discrete wheels (no OS momentum)
  // earn a synthetic coast, from 4 steps/s past their burst gate.
  const coastMin = () => (panMode ? Infinity : 4);

  const trackpadPan = (e: WheelEvent) => {
    panMode = true;
    appTarget = e.target;
    // One line's worth of delta per synthetic event, in the pan's direction —
    // xterm emits one wire report per event regardless of magnitude.
    appProto = { deltaY: Math.sign(e.deltaY) * 120, clientX: e.clientX, clientY: e.clientY };

    const now = e.timeStamp || performance.now();
    const gap = now - panLastAt;
    panLastAt = now;
    const stepPx = Math.max(1, opts.lineHeightPx());
    const px = e.deltaMode === 1 ? e.deltaY * stepPx : e.deltaY;
    // Direction flip: dump everything queued the other way, instantly.
    if (Math.sign(px) !== Math.sign(panPx + panPending) && (panPx !== 0 || panPending !== 0)) {
      panPx = 0;
      panPending = 0;
      appVel = 0;
    }
    if (gap > 250) { panPx = 0; }
    panPx += px;
    const steps = Math.trunc(panPx / stepPx);
    if (steps !== 0) {
      panPx -= steps * stepPx;
      panPending += steps;
    }
    // Velocity for the post-stream coast, in steps/sec, from the px rate.
    const rate = (px / stepPx) / (Math.min(Math.max(gap, 8), 200) / 1000);
    appVel = Math.sign(rate) === Math.sign(appVel) ? 0.5 * rate + 0.5 * appVel : rate;
    appVel = Math.max(-APP_MAX_RATE, Math.min(APP_MAX_RATE, appVel));

    // Leading edge dispatches INLINE: a precise first movement must not
    // wait out an animation frame — latency is what precision feels like.
    // The rAF loop takes over for everything after, where pacing matters.
    if (panPending !== 0 && unacked < APP_ACK_WINDOW) {
      const spend = Math.sign(panPending)
        * Math.min(Math.abs(panPending), burstFor(appVel || panPending));
      panPending -= spend;
      lastStepAt = performance.now();
      unacked += 1;
      if (appProto) appProto.deltaY = Math.sign(spend) * 120;
      for (let i = 0; i < Math.abs(spend); i++) dispatchStep();
    }
    if (!appRaf) {
      lastFrameAt = 0;
      appRaf = requestAnimationFrame(appGlide);
    }
    if (appIdle) window.clearTimeout(appIdle);
    appIdle = window.setTimeout(() => {
      appIdle = 0;
      // The OS stream has ended. Whatever is queued keeps draining paced;
      // if the loop already parked itself (slow drag), sweep leftovers now.
      if (!appRaf && panPending === 0 && Math.abs(appVel) < coastMin()) stopApp();
    }, 120);
  };

  const appWheel = (e: WheelEvent) => {
    panMode = false;
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
    vel *= Math.exp(-dt / 0.24); // ~240ms decay: brisk, not a runaway
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
      // Pinch-zoom and sideways pans are not scrolling — leave them alone.
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (isDiscreteWheel(e)) {
        appWheel(e);
      } else {
        // Trackpad: take the stream over entirely. Without this, xterm
        // forwards every one of the OS's momentum events as its own wire
        // report and a remote app drowns (scroll lag, overshoot). We
        // preventDefault + stopPropagation the raw events and re-emit
        // line-sized, ACK-paced synthetic ones instead.
        e.preventDefault();
        e.stopPropagation();
        trackpadPan(e);
      }
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
    const CAP = 1400; // lines/s — fast, but never a teleport
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
  // CAPTURE phase. Capture is REQUIRED: when the app is tracking the
  // mouse, xterm's own handler calls stopPropagation() on the way out, so a
  // bubble-phase listener on this ancestor never runs at all — which is why
  // the app-scroll shaping below silently did nothing. Observing first lets
  // xterm do exactly what it always did, and lets us add steps around it.
  // capture (see below) and NON-passive: the app-owned trackpad branch
  // preventDefaults the raw stream it replaces. Every other path still never
  // cancels anything.
  el.addEventListener("wheel", onWheel, { capture: true, passive: false });
  el.addEventListener("mousedown", kill, true);
  window.addEventListener("keydown", kill, true);
  return () => {
    stop();
    el.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
    el.removeEventListener("mousedown", kill, true);
    window.removeEventListener("keydown", kill, true);
  };
};
