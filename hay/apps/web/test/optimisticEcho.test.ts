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
