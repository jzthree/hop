import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TipCard } from "../src/components/TipCard";
import { localDay, tipFor, tips } from "../src/utils/tips";

// The test environment's localStorage keeps nothing: a Map stands in.
beforeEach(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear()
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("tips", () => {
  it("every tip comes round, one a day, and keys read per platform", () => {
    const list = tips(true);
    const seen = new Set(Array.from({ length: list.length }, (_, d) => tipFor(list, d).id));
    expect(seen.size).toBe(list.length);
    expect(new Set(list.map((t) => t.id)).size).toBe(list.length);
    expect(tips(true).find((t) => t.id === "queue")!.text).toMatch(/^⌘⌥⏎/);
    expect(tips(false).find((t) => t.id === "queue")!.text).toMatch(/^Ctrl\+Alt\+⏎/);
    expect(tips(false).find((t) => t.id === "back")!.text).toMatch(/^Ctrl\+Shift\+E/);
  });

  it("the card: Next moves on, × hides it until tomorrow, Turn off for good", () => {
    const now = Date.UTC(2026, 10, 7, 15);
    const list = tips(true);
    const first = tipFor(list, localDay(now));
    const { unmount } = render(<TipCard isMac now={now} />);
    const shown = () => screen.getByRole("note").textContent || "";
    expect(shown()).toContain(first.text.replace(/`/g, ""));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(shown()).toContain(tipFor(list, localDay(now), 1).text.replace(/`/g, ""));
    fireEvent.click(screen.getByRole("button", { name: "Hide tips until tomorrow" }));
    expect(screen.queryByRole("note")).toBeNull();
    unmount();
    // Still hidden today; back tomorrow.
    render(<TipCard isMac now={now} />);
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
    render(<TipCard isMac now={now + 86_400_000} />);
    expect(screen.getByRole("note")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    cleanup();
    render(<TipCard isMac now={now + 3 * 86_400_000} />);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
