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
  let burst = 0; // wheel events in the current spin
  let lastWheelAt = 0;
  let lastFrameAt = 0;
  let raf = 0;
  let idleTimer = 0;

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    if (idleTimer) window.clearTimeout(idleTimer);
    raf = 0;
    idleTimer = 0;
    vel = 0;
    carry = 0;
    burst = 0;
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
    const term = getTerm();
    if (!term) return;
    // App owns the wheel (alt screen, or mouse tracking on): hands off, and
    // kill any active glide — the mode may have flipped mid-glide.
    if (!terminalOwnsScrolling(term)) return stop();
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
  // Passive and non-preventing: xterm still performs its own per-notch
  // scroll (or forwards the notch to a tracking app); we only add the glide
  // afterwards in the cases we own.
  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("mousedown", kill, true);
  window.addEventListener("keydown", kill, true);
  return () => {
    stop();
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("mousedown", kill, true);
    window.removeEventListener("keydown", kill, true);
  };
};
