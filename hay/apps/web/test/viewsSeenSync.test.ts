import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadViewsSeen, syncViewsSeen } from "../src/components/ViewsPanel";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); },
    removeItem: (k: string) => { values.delete(k); }, clear: () => values.clear()
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Views seen-markers, shared through hop", () => {
  it("takes what another device has seen, and hands back what only this one has", async () => {
    localStorage.setItem("hop_views_seen", JSON.stringify({ a: 100, b: 500 }));
    const fetchMock = vi.fn(async (_u: string, init?: { method?: string; body?: string }) =>
      ({ ok: true, json: async () => (init?.method === "POST" ? { seen: {} } : { seen: { a: 300, c: 50 } }) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await syncViewsSeen()).toBe(true);
    expect(loadViewsSeen()).toEqual({ a: 300, b: 500, c: 50 });
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
    expect(JSON.parse(post![1]!.body!).seen).toEqual({ a: 300, b: 500, c: 50 });
  });

  it("nothing to take or give: no write either way; hop unreachable: this device's own stands", async () => {
    localStorage.setItem("hop_views_seen", JSON.stringify({ a: 100 }));
    const same = vi.fn(async () => ({ ok: true, json: async () => ({ seen: { a: 100 } }) }));
    vi.stubGlobal("fetch", same);
    expect(await syncViewsSeen()).toBe(false);
    expect(same).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await syncViewsSeen()).toBe(false);
    expect(loadViewsSeen()).toEqual({ a: 100 });
  });
});
