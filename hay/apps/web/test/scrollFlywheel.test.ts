import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachScrollFlywheel, isDiscreteWheel } from "../src/utils/scrollFlywheel";

describe("isDiscreteWheel", () => {
  it("line-mode deltas are always a real wheel (Firefox)", () => {
    expect(isDiscreteWheel({ deltaMode: 1, deltaY: 3 })).toBe(true);
  });
  it("large integer pixel deltas are wheel notches (Chrome ~100px steps)", () => {
    expect(isDiscreteWheel({ deltaMode: 0, deltaY: 100 })).toBe(true);
    expect(isDiscreteWheel({ deltaMode: 0, deltaY: -120 })).toBe(true);
  });
  it("small or fractional pixel deltas are trackpad pans — native inertia", () => {
    expect(isDiscreteWheel({ deltaMode: 0, deltaY: 6 })).toBe(false);
    expect(isDiscreteWheel({ deltaMode: 0, deltaY: 83.3333 })).toBe(false);
  });
});

describe("attachScrollFlywheel", () => {
  const mkTerm = (type = "normal") => {
    let viewportY = 5000;
    return {
      scrolled: [] as number[],
      scrollLines(n: number) {
        this.scrolled.push(n);
        viewportY += n;
      },
      buffer: { active: { type, get viewportY() { return viewportY; } } }
    };
  };

  let el: HTMLElement;
  let rafCbs: FrameRequestCallback[];
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.appendChild(el);
    rafCbs = [];
    now = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (rafCbs.push(cb), rafCbs.length));
    vi.stubGlobal("cancelAnimationFrame", () => { rafCbs = []; });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    el.remove();
  });

  const wheel = (deltaY: number, timeStamp: number) => {
    const e = new Event("wheel") as WheelEvent;
    Object.defineProperties(e, {
      deltaY: { value: deltaY },
      deltaMode: { value: 1 }, // line mode: unambiguous discrete wheel
      timeStamp: { value: timeStamp }
    });
    el.dispatchEvent(e);
  };

  const pumpFrames = (frames: number) => {
    for (let i = 0; i < frames && rafCbs.length; i++) {
      const cb = rafCbs.shift()!;
      now += 16;
      cb(now);
    }
  };

  it("a sustained spin glides after the wheel goes idle, then decays to a stop", () => {
    const term = mkTerm();
    const dispose = attachScrollFlywheel(el, () => term, { linesPerNotch: 4, lineHeightPx: () => 16 });
    wheel(-3, 0); wheel(-3, 50); wheel(-3, 100); wheel(-3, 150); // spin up
    expect(term.scrolled.length).toBe(0); // xterm does the immediate part, not us
    vi.advanceTimersByTime(90); // idle → glide starts
    pumpFrames(200);
    const glided = term.scrolled.reduce((a, b) => a + b, 0);
    expect(glided).toBeLessThan(-10); // kept moving up well beyond the notches
    expect(rafCbs.length).toBe(0); // and came to a stop on its own
    dispose();
  });

  it("a single notch never glides — precise nudges stay precise", () => {
    const term = mkTerm();
    const dispose = attachScrollFlywheel(el, () => term, { linesPerNotch: 4, lineHeightPx: () => 16 });
    wheel(1, 0);
    vi.advanceTimersByTime(200);
    pumpFrames(50);
    expect(term.scrolled.length).toBe(0);
    dispose();
  });

  it("alternate screen gets no momentum (inertia would spray arrow keys)", () => {
    const term = mkTerm("alternate");
    const dispose = attachScrollFlywheel(el, () => term, { linesPerNotch: 4, lineHeightPx: () => 16 });
    wheel(-3, 0); wheel(-3, 40); wheel(-3, 80); wheel(-3, 120);
    vi.advanceTimersByTime(200);
    pumpFrames(50);
    expect(term.scrolled.length).toBe(0);
    dispose();
  });

  it("a keypress kills the glide instantly", () => {
    const term = mkTerm();
    const dispose = attachScrollFlywheel(el, () => term, { linesPerNotch: 4, lineHeightPx: () => 16 });
    wheel(-3, 0); wheel(-3, 50); wheel(-3, 100); wheel(-3, 150);
    vi.advanceTimersByTime(90);
    pumpFrames(2);
    const before = term.scrolled.length;
    window.dispatchEvent(new Event("keydown"));
    pumpFrames(50);
    expect(term.scrolled.length).toBe(before);
    dispose();
  });
});

describe("app-owned trackpad panning", () => {
  // A term in the state every Claude session runs: alt screen + tracking.
  const mkAppTerm = () => ({
    scrolled: [] as number[],
    scrollLines() { /* app-owned: local scroll must never happen */ },
    buffer: { active: { type: "alternate", viewportY: 0 } },
    modes: { mouseTrackingMode: "drag" }
  });

  let el: HTMLElement;
  let rafCbs: FrameRequestCallback[];

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.appendChild(el);
    rafCbs = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (rafCbs.push(cb), rafCbs.length));
    vi.stubGlobal("cancelAnimationFrame", () => { rafCbs = []; });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    el.remove();
  });

  const pan = (deltaY: number, timeStamp: number, extra: Partial<WheelEvent> = {}) => {
    const e = new Event("wheel", { cancelable: true }) as WheelEvent;
    Object.defineProperties(e, {
      deltaY: { value: deltaY },
      deltaX: { value: (extra as { deltaX?: number }).deltaX ?? 0 },
      ctrlKey: { value: (extra as { ctrlKey?: boolean }).ctrlKey ?? false },
      deltaMode: { value: 0 }, // pixel mode, small deltas: a trackpad
      timeStamp: { value: timeStamp },
      clientX: { value: 10 },
      clientY: { value: 10 }
    });
    el.dispatchEvent(e);
    return e;
  };

  const drainFrames = (frames: number, stepMs = 16) => {
    let t = performance.now();
    for (let i = 0; i < frames && rafCbs.length; i++) {
      const cbs = rafCbs;
      rafCbs = [];
      t += stepMs;
      for (const cb of cbs) cb(t);
    }
  };

  it("takes ownership of the raw stream and re-emits paced line steps", () => {
    const term = mkAppTerm();
    const dispose = attachScrollFlywheel(el, () => term as never, {
      linesPerNotch: 4,
      lineHeightPx: () => 20
    });

    // Synthetic (our own) wheel events reach the app; count them.
    let forwarded = 0;
    el.addEventListener("wheel", (e) => { if (!e.defaultPrevented) forwarded++; });

    // A fast flick: 30 raw events of 15px each (0.75 lines apiece).
    let cancelled = 0;
    for (let i = 0; i < 30; i++) {
      const e = pan(15, i * 8);
      if (e.defaultPrevented) cancelled++;
    }
    expect(cancelled).toBe(30); // every RAW event was consumed, none leaked
    // Count arrivals per drained frame to verify pacing.
    let inFrame = 0;
    let maxPerFrame = 0;
    el.addEventListener("wheel", (e) => { if (!e.defaultPrevented) inFrame++; });
    for (let f = 0; f < 40 && rafCbs.length; f++) {
      inFrame = 0;
      drainFrames(1);
      maxPerFrame = Math.max(maxPerFrame, inFrame);
    }

    // 450px of finger = 22 whole lines, plus a momentum coast on top (the
    // point of the feature). What must hold: lines flow as bounded BURSTS —
    // at most one speed-proportional burst per frame (each costing the app
    // one repaint), never the raw flood re-emitted wholesale.
    expect(forwarded).toBeGreaterThan(10);
    const maxBurst = 5; // APP_MAX_BURST
    expect(maxPerFrame).toBeLessThanOrEqual(maxBurst);
    expect(term.scrolled.length).toBe(0); // and nothing scrolled locally
    dispose();
  });

  it("a slow precise drag lands exactly one step per line crossed", () => {
    const term = mkAppTerm();
    const dispose = attachScrollFlywheel(el, () => term as never, {
      linesPerNotch: 4,
      lineHeightPx: () => 20
    });
    let forwarded = 0;
    el.addEventListener("wheel", (e) => { if (!e.defaultPrevented) forwarded++; });

    // 5px at a time: three events accumulate 15px — under one line, nothing
    // moves; the fourth crosses 20px and yields exactly one step.
    pan(5, 0); pan(5, 30); pan(5, 60);
    drainFrames(4);
    expect(forwarded).toBe(0);
    pan(5, 90);
    drainFrames(4);
    expect(forwarded).toBe(1);
    dispose();
  });

  it("holds after two unacked bursts when the remote goes silent", () => {
    // The pipelining contract: bursts fly while output flows; a remote that
    // stops answering gets at most APP_ACK_WINDOW bursts in flight, then we
    // hold (until the 300ms stall cap) instead of flooding its input queue.
    const term = mkAppTerm();
    let lastOutput = 0; // frozen: the remote never answers
    // A clock that actually advances: the hold logic compares real
    // timestamps, and vitest's frozen performance.now() (0) disarms it.
    let clock = 1000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const dispose = attachScrollFlywheel(el, () => term as never, {
      linesPerNotch: 4,
      lineHeightPx: () => 20,
      lastOutputAt: () => lastOutput
    });
    let bursts = 0;
    let prevCount = 0;
    let count = 0;
    el.addEventListener("wheel", (e) => { if (!e.defaultPrevented) count++; });

    for (let i = 0; i < 30; i++) { clock += 8; pan(15, clock); }
    for (let f = 0; f < 15 && rafCbs.length; f++) {
      prevCount = count;
      clock += 16;
      drainFrames(1);
      if (count > prevCount) bursts++;
    }
    expect(bursts).toBe(2); // APP_ACK_WINDOW, not a flood

    // The remote answers: the window clears and bursts resume.
    lastOutput = clock + 1;
    prevCount = count;
    clock += 16;
    drainFrames(3);
    expect(count).toBeGreaterThan(prevCount);
    nowSpy.mockRestore();
    dispose();
  });

  it("leaves pinch-zoom and horizontal pans alone", () => {
    const term = mkAppTerm();
    const dispose = attachScrollFlywheel(el, () => term as never, {
      linesPerNotch: 4,
      lineHeightPx: () => 20
    });
    const zoom = pan(15, 0, { ctrlKey: true } as Partial<WheelEvent>);
    const sideways = pan(3, 20, { deltaX: 40 } as Partial<WheelEvent>);
    expect(zoom.defaultPrevented).toBe(false);
    expect(sideways.defaultPrevented).toBe(false);
    dispose();
  });

  it("local-scrollback trackpads keep the native feel — untouched", () => {
    let viewportY = 5000;
    const term = {
      scrolled: [] as number[],
      scrollLines(n: number) { this.scrolled.push(n); viewportY += n; },
      buffer: { active: { type: "normal", get viewportY() { return viewportY; } } }
    };
    const dispose = attachScrollFlywheel(el, () => term as never, {
      linesPerNotch: 4,
      lineHeightPx: () => 20
    });
    const e = pan(15, 0);
    expect(e.defaultPrevented).toBe(false); // xterm's own handling stands
    expect(term.scrolled.length).toBe(0);   // and we add no glide of our own
    dispose();
  });
});
