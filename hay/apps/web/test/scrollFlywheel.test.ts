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
