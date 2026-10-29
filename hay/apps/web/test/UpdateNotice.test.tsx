import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateNotice } from "../src/components/UpdateNotice";

const answer = (body: object) => vi.fn(async () => ({ ok: true, json: async () => body }));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => { values.set(k, v); },
    removeItem: (k: string) => { values.delete(k); },
    clear: () => values.clear()
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

describe("UpdateNotice", () => {
  it("shows the newer version and the command when one is published", async () => {
    vi.stubGlobal("fetch", answer({ current: "0.11.85", latest: "0.11.90", updateAvailable: true, command: "hop update" }));
    render(<UpdateNotice />);
    await flush();
    expect(screen.getByRole("status").textContent).toMatch(/0\.11\.90 is available/);
    expect(screen.getByText("hop update")).toBeTruthy();
  });

  it("stays hidden when up to date", async () => {
    vi.stubGlobal("fetch", answer({ current: "0.11.90", latest: "0.11.90", updateAvailable: false, command: "hop update" }));
    render(<UpdateNotice />);
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismissing hides it until the next release", async () => {
    vi.stubGlobal("fetch", answer({ current: "0.11.85", latest: "0.11.90", updateAvailable: true, command: "hop update" }));
    const first = render(<UpdateNotice />);
    await flush();
    fireEvent.click(screen.getByLabelText("Dismiss until the next release"));
    expect(screen.queryByRole("status")).toBeNull();
    first.unmount();
    render(<UpdateNotice />);
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();
    vi.stubGlobal("fetch", answer({ current: "0.11.85", latest: "0.11.91", updateAvailable: true, command: "hop update" }));
    render(<UpdateNotice />);
    await flush();
    expect(screen.getByRole("status").textContent).toMatch(/0\.11\.91/);
  });
});
