import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/components/SettingsPage";
import { TipCard } from "../src/components/TipCard";
import { sessionMenuItems } from "../src/components/sessionMenu";

// The test environment's localStorage keeps nothing: a Map stands in.
let calls: Array<{ url: string; body?: unknown }> = [];
const NOW = Date.UTC(2026, 10, 10, 18);
const logins = [
  { id: "a1", label: "Safari on Mac", via: "totp", lastSeenAt: NOW - 60_000, expiresAt: NOW + 20 * 86400000, current: true },
  { id: "b2", label: "iPhone app", via: "device-token", lastSeenAt: NOW - 3 * 3600_000, expiresAt: null, current: false }
];
// As the daemon sends them: ISO text.
const passkeys = [{ id: "pk1", rpID: "hop.example.org", label: null, createdAt: new Date(NOW - 30 * 86400000).toISOString(), lastUsedAt: new Date(NOW - 86400000).toISOString() }];

beforeEach(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear()
  });
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (d: unknown) => ({ ok: true, json: async () => d });
    if (url === "/api/auth/sessions") return json({ ok: true, sessions: logins });
    if (url === "/api/passkeys/list") return json({ ok: true, passkeys });
    if (url === "/api/update") return json({ current: "2.4.0", latest: "2.5.0", updateAvailable: true, command: "hop update" });
    if (url === "/api/instance") return json({ canonicalUrl: "https://hop.example.org" });
    return json({ ok: true });
  }));
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const base = () => ({
  placement: "page" as const, onClose: vi.fn(), isMac: true, touch: false,
  themeMode: "system" as const, onTheme: vi.fn(), fontSize: 14, onFontSize: vi.fn(),
  viewMode: "fit" as const, onViewMode: vi.fn(), name: "Robin", onName: vi.fn(),
  native: false, build: "abc1234 · 2026-11-10", onShowShortcuts: vi.fn(), onNotice: vi.fn(), now: NOW
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("Settings", () => {
  it("is one page of sections — how hop looks, terminals, attention, you, sign-in, about", async () => {
    render(<SettingsPage {...base()} />);
    await settle();
    const heads = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(heads).toEqual(["Appearance", "Terminals", "Attention & help", "You", "Sign-in", "About"]);
    // Nothing about one session lives here (that is its ⋯ menu).
    expect(screen.queryByText(/Kill|Redraw|Fit to this window/)).toBeNull();
  });

  it("each control says what is chosen and changes it", async () => {
    const p = base();
    render(<SettingsPage {...p} />);
    await settle();
    const theme = screen.getByRole("radiogroup", { name: "Theme" });
    expect(within(theme).getByRole("radio", { name: "Auto" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(theme).getByRole("radio", { name: "Dark" }));
    expect(p.onTheme).toHaveBeenCalledWith("dark");
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(p.onFontSize).toHaveBeenCalledWith(15);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Window size" })).getByRole("radio", { name: "Keep size" }));
    expect(p.onViewMode).toHaveBeenCalledWith("full");
    // Touch and haptics only on a touch device.
    expect(screen.queryByRole("radiogroup", { name: "Touch" })).toBeNull();
  });

  it("tips go off and come back on, and the overview's card follows", async () => {
    render(<><SettingsPage {...base()} /><TipCard isMac now={NOW} /></>);
    await settle();
    expect(screen.getByRole("note")).toBeTruthy();
    const tips = screen.getByRole("radiogroup", { name: "Tip of the day" });
    fireEvent.click(within(tips).getByRole("radio", { name: "Off" }));
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(within(tips).getByRole("radio", { name: "On" }));
    expect(screen.getByRole("note")).toBeTruthy();
  });

  it("your name is edited in place", async () => {
    const p = base();
    render(<SettingsPage {...p} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Robin/ }));
    const box = screen.getByRole("textbox", { name: "Your name" });
    fireEvent.change(box, { target: { value: "  Casey " } });
    fireEvent.submit(box.closest("form")!);
    expect(p.onName).toHaveBeenCalledWith("Casey");
  });

  it("lists where you are signed in; another login can be signed out, this one is marked", async () => {
    render(<SettingsPage {...base()} />);
    await settle();
    const here = screen.getByText("Safari on Mac").closest(".set-item") as HTMLElement;
    expect(within(here).getByText("this browser")).toBeTruthy();
    expect(within(here).queryByRole("button", { name: "Sign out" })).toBeNull();
    const phone = screen.getByText("iPhone app").closest(".set-item") as HTMLElement;
    expect(phone.textContent).toMatch(/device token · seen 3h ago · no expiry/);
    fireEvent.click(within(phone).getByRole("button", { name: "Sign out" }));
    await settle();
    expect(calls.find((c) => c.url === "/api/auth/sessions/revoke")?.body).toEqual({ id: "b2" });
  });

  it("passkeys: listed, removable; added only where they can be", async () => {
    const add = vi.fn();
    const { unmount } = render(<SettingsPage {...base()} onAddPasskey={add} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey for this device" }));
    expect(add).toHaveBeenCalled();
    expect(document.querySelector(".set-item-meta")!.textContent).toMatch(/added .*2026 · used 1d ago$/);
    fireEvent.click(screen.getByText("hop.example.org", { selector: ".set-item-main" }).closest(".set-item")!.querySelector("button")!);
    await settle();
    expect(calls.find((c) => c.url === "/api/passkeys/delete")?.body).toEqual({ id: "pk1" });
    unmount();
    render(<SettingsPage {...base()} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Add a passkey for this device" })).toBeNull();
  });

  it("the Mac app has no Sign out of this browser (it signs itself in)", async () => {
    const { unmount } = render(<SettingsPage {...base()} />);
    await settle();
    expect(screen.getByRole("button", { name: "Sign out of this browser" })).toBeTruthy();
    unmount();
    render(<SettingsPage {...base()} native />);
    await settle();
    expect(screen.queryByRole("button", { name: "Sign out of this browser" })).toBeNull();
  });

  it("About: the build, an update to open, the address to copy", async () => {
    const onShowUpdate = vi.fn();
    render(<SettingsPage {...base()} onShowUpdate={onShowUpdate} />);
    await settle();
    expect(screen.getByText("abc1234 · 2026-11-10")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update to 2.5.0…" }));
    expect(onShowUpdate).toHaveBeenCalledWith(expect.objectContaining({ latest: "2.5.0" }));
    expect(screen.getByText("hop.example.org", { selector: "code" })).toBeTruthy();
  });

  it("Esc leaves, except while a name is being typed", async () => {
    const p = base();
    render(<SettingsPage {...p} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Robin/ }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Your name" }), { key: "Escape" });
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalled();
  });
});

describe("the session's ⋯ menu", () => {
  it("is the sidebar's menu for it, led by the terminal's own actions, with its text first in Copy", () => {
    const fit = vi.fn();
    const items = sessionMenuItems({ name: "s1", displayName: "demo", internalName: "s_1", cwd: "/Users/x/Code/demo" }, {
      ctx: { notice: vi.fn(), refresh: vi.fn() }, folders: [], homes: { claude: [], codex: [] },
      isCurrent: () => true, onOpen: vi.fn(), onStartRename: vi.fn(),
      lead: [{ label: "Fit to this window", onSelect: fit }, { label: "Redraw screen" }],
      copyFirst: [{ label: "Screen text" }, { label: "All scrollback" }]
    });
    const labels = items.map((i) => ("label" in i ? i.label : "—"));
    expect(labels.slice(0, 3)).toEqual(["Fit to this window", "Redraw screen", "—"]);
    expect(labels).toContain("Rename");
    expect(labels[labels.length - 1]).toBe("Kill session");
    const copy = items.find((i) => "label" in i && i.label === "Copy") as { items: Array<{ label?: string; kind?: string }> };
    expect(copy.items.map((i) => i.label || i.kind).slice(0, 4)).toEqual(["Screen text", "All scrollback", "separator", "Name"]);
    // The sidebar's own menu, without them, starts as before.
    const plain = sessionMenuItems({ name: "s1", displayName: "demo" }, {
      ctx: { notice: vi.fn(), refresh: vi.fn() }, folders: [], homes: { claude: [], codex: [] },
      isCurrent: () => false, onOpen: vi.fn(), onStartRename: vi.fn()
    });
    expect("label" in plain[0] && plain[0].label).toBe("Open full screen");
  });
});

describe("Settings › Signed in, when there are many", () => {
  it("shows this browser first and five in all, the rest a click away", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: "x" + i, label: "Login " + i, via: "passkey", lastSeenAt: NOW - i * 3600_000, expiresAt: null, current: i === 6 }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => (url === "/api/auth/sessions" ? { ok: true, sessions: many } : {}) })));
    render(<SettingsPage {...base()} />);
    await settle();
    const names = () => [...document.querySelectorAll(".set-item-main")].map((e) => e.firstChild?.textContent);
    expect(names()).toEqual(["Login 6", "Login 0", "Login 1", "Login 2", "Login 3"]);
    fireEvent.click(screen.getByRole("button", { name: "4 more…" }));
    expect(names()).toHaveLength(9);
  });
});
