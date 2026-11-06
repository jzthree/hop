import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdatePop } from "../src/components/UpdateNotice";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const base = { current: "0.11.92", latest: "0.11.95", updateAvailable: true, command: "hop update" };
const keeper = (over = {}) => ({ keeper: true, requiresRestart: false, stale: false, reason: null, terminals: 43, startedAt: 1, ...over });
const posts = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u) === "/api/update/apply").map(([, init]) => JSON.parse(init.body));

describe("UpdatePop", () => {
  it("an ordinary update: one click, sessions keep running", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, phase: "restarting" }) })));
    render(<UpdatePop update={{ ...base, keeper: keeper() }} onDismiss={() => {}} onClose={() => {}} live={43} working={5} />);
    expect(screen.getByText(/keeps every session running/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(posts()).toEqual([{ restartTerminals: false }]));
    expect(screen.getByRole("status").textContent).toMatch(/Starting/);
    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
  });

  it("an update that replaces the terminal keeper says so, with the cost, and asks for it in the button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    render(<UpdatePop update={{ ...base, keeper: keeper({ requiresRestart: true }) }} onDismiss={() => {}} onClose={() => {}} live={43} working={5} />);
    const warn = screen.getByRole("alert").textContent || "";
    expect(warn).toMatch(/restarts every terminal/);
    expect(warn).toMatch(/all 43 sessions end/);
    expect(warn).toMatch(/5 agents are mid-turn/);
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Update and restart 43 sessions" }));
    await waitFor(() => expect(posts()).toEqual([{ restartTerminals: true }]));
  });

  it("keeper fixes waiting: restarting the terminals is an option, off by default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
    render(<UpdatePop update={{ ...base, keeper: keeper({ stale: true }) }} onDismiss={() => {}} onClose={() => {}} live={43} working={0} />);
    expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Update and restart 43 sessions" }));
    await waitFor(() => expect(posts()).toEqual([{ restartTerminals: true }]));
  });

  it("a refused update says why and leaves the buttons", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "An update is already running" }) })));
    render(<UpdatePop update={{ ...base, keeper: keeper() }} onDismiss={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("An update is already running"));
    expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy();
  });
});
