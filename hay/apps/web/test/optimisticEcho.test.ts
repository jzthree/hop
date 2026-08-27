import { describe, expect, it } from "vitest";
import { createOptimisticEcho, hasActiveOtherTypist, STALE_TYPING_MS } from "../src/utils/optimisticEcho";

describe("optimistic echo", () => {
  it("echoes printable input and strips from output", () => {
    const echo = createOptimisticEcho();
    const echoed = echo.onInput("hello", true);
    expect(echoed).toBe("hello");
    const output = echo.reconcileOutput("hello");
    expect(output).toBe("");
    expect(echo.getPending()).toBe("");
  });

  it("handles partial output chunks", () => {
    const echo = createOptimisticEcho();
    echo.onInput("abc", true);
    const first = echo.reconcileOutput("ab");
    expect(first).toBe("");
    const second = echo.reconcileOutput("cX");
    expect(second).toBe("X");
  });

  it("filters non-printable input", () => {
    const echo = createOptimisticEcho();
    const echoed = echo.onInput("\u001b[A", true);
    expect(echoed).toBe("");
    expect(echo.getPending()).toBe("");
  });

  it("clears pending after timeout", () => {
    let time = 0;
    const echo = createOptimisticEcho({ now: () => time, maxPendingMs: 10 });
    echo.onInput("abc", true);
    time = 20;
    const output = echo.reconcileOutput("XYZ");
    expect(output).toBe("XYZ");
    expect(echo.getPending()).toBe("");
  });
});
it("passes TUI redraw chunks through untouched and drops pending", () => {
  const echo = createOptimisticEcho({ now: () => 1000 });
  echo.onInput("e", true);
  // Claude-Code-style composer repaint: erase + cursor moves + existing text
  const redraw = "\u001b[2K\u001b[1A\u001b[G> some earlier text e more\u001b[B";
  expect(echo.reconcileOutput(redraw)).toBe(redraw);
  expect(echo.getPending()).toBe("");
});

it("still reconciles coalesced plain echoes with SGR styling", () => {
  const echo = createOptimisticEcho({ now: () => 1000 });
  echo.onInput("a", true);
  echo.onInput("l", true);
  expect(echo.reconcileOutput("\u001b[1mal\u001b[0m")).toBe("\u001b[1m\u001b[0m");
  expect(echo.getPending()).toBe("");
});

// Responsiveness guarantee: local echo is what makes keystrokes feel instant,
// and it must NOT be silently disabled by a stale/ghost "typing" flag. A peer
// that dropped mid-type (crashed tab, evicted-but-lingering ghost) leaves
// typing=true; if that turned echo off, every keystroke would wait a full
// round-trip and typing would lag. These pin the ghost-resilience so a future
// change can't regress it.
describe("optimistic echo — active-typist gate (responsiveness)", () => {
  const NOW = 1_000_000;
  const seen = (entries: Array<[string, number]>) => new Map(entries);

  it("is SYNCHRONOUS: onInput returns the echo immediately", () => {
    const echo = createOptimisticEcho();
    const t0 = Date.now();
    const out = echo.onInput("x", true);      // no await, no promise
    expect(out).toBe("x");
    expect(Date.now() - t0).toBeLessThan(5);   // it does not wait on anything
  });

  it("a peer typing RIGHT NOW suppresses local echo (correct)", () => {
    const clients = [{ id: "me" }, { id: "peer", typing: true }];
    const lastSeen = seen([["peer", NOW - 500]]); // seen typing half a second ago
    expect(hasActiveOtherTypist(clients, "me", lastSeen, NOW)).toBe(true);
  });

  it("a GHOST whose typing flag went stale does NOT suppress echo", () => {
    const clients = [{ id: "me" }, { id: "ghost", typing: true }];
    // Its flag is still true, but we have not seen it typing for a long time.
    const lastSeen = seen([["ghost", NOW - (STALE_TYPING_MS + 5000)]]);
    expect(hasActiveOtherTypist(clients, "me", lastSeen, NOW)).toBe(false);
  });

  it("a peer never seen typing (no timestamp) does not suppress echo", () => {
    const clients = [{ id: "me" }, { id: "peer", typing: true }];
    expect(hasActiveOtherTypist(clients, "me", new Map(), NOW)).toBe(false);
  });

  it("my own typing never suppresses my echo", () => {
    const clients = [{ id: "me", typing: true }];
    const lastSeen = seen([["me", NOW]]);
    expect(hasActiveOtherTypist(clients, "me", lastSeen, NOW)).toBe(false);
  });

  it("no peers typing → echo stays on", () => {
    const clients = [{ id: "me" }, { id: "peer", typing: false }];
    expect(hasActiveOtherTypist(clients, "me", seen([["peer", NOW]]), NOW)).toBe(false);
  });
});
