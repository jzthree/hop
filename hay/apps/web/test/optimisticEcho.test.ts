import { describe, expect, it } from "vitest";
import { createOptimisticEcho } from "../src/utils/optimisticEcho";

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

