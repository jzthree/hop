import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewsPanel, hasUnseenViews, loadViewsSeen } from "../src/components/ViewsPanel";
import { SessionSwitcher } from "../src/components/SessionSwitcher";
import type { SwitcherSession } from "../src/utils/switcherModel";

// A slice of the real /api/views manifest: newest first, one empty title (the
// common case — `hop view` without --title), two sessions.
const items = [
  { session: "Orion", name: "agent-result.md", title: "Views end-to-end", path: "/view/Orion/agent-result.md/inline", bytes: 437, mtime: 1786303213 },
  { session: "Orion", name: "views-test.html", title: "", path: "/view/Orion/views-test.html/inline", bytes: 2062, mtime: 1786299563 },
  { session: "Nebula", name: "shot.png", title: "", path: "/view/Nebula/shot.png/inline", bytes: 999999, mtime: 1786299000 }
];

let store: Record<string, string> = {};
beforeEach(() => {
  // jsdom's own localStorage is only partially implemented here, and the
  // seen-markers are the whole point of these cases.
  store = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; }
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items }) })));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("ViewsPanel", () => {
  it("groups by session, leads with the title, falls back to the filename", async () => {
    render(<ViewsPanel sessions={[{ name: "Orion", displayName: "orion-worker", internalName: "Orion" }]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Views end-to-end")).toBeTruthy());
    // The manifest only knows internalNames; the dateline shows the rename.
    expect(screen.getByText("orion-worker")).toBeTruthy();
    expect(screen.getByText("Nebula")).toBeTruthy();
    expect(screen.getByText("views-test.html")).toBeTruthy();
    expect(screen.getByText("MD")).toBeTruthy();
    expect(screen.getByText("IMG")).toBeTruthy();

    const link = screen.getByText("Views end-to-end").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/view/Orion/agent-result.md/inline");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.className).toContain("fresh");

    // Opening IS seeing: every session on screen gets its high-water mark.
    await waitFor(() => expect(loadViewsSeen()).toEqual({ Orion: 1786303213, Nebula: 1786299000 }));
    expect(hasUnseenViews("Orion", 1786303213, loadViewsSeen())).toBe(false);
    expect(hasUnseenViews("Orion", 1786303300, loadViewsSeen())).toBe(true);
  });

  it("scopes to one session without pruning the others' markers", async () => {
    store["hop_views_seen"] = JSON.stringify({ Nebula: 1 });
    render(<ViewsPanel session="orion" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Views end-to-end")).toBeTruthy());
    expect(screen.queryByText("shot.png")).toBeNull();
    await waitFor(() => expect(loadViewsSeen().Orion).toBe(1786303213));
    expect(loadViewsSeen().Nebula).toBe(1);
  });

  it("explains the feature when nothing is published", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })));
    render(<ViewsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Nothing published yet/)).toBeTruthy());
  });

  it("closes on Escape and on the backdrop", async () => {
    const onClose = vi.fn();
    const { container } = render(<ViewsPanel onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Views end-to-end")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    fireEvent.click(container.querySelector(".views-backdrop")!);
    expect(onClose.mock.calls.length).toBe(2);
  });
});

const switcherSessions: SwitcherSession[] = [
  {
    name: "Orion", displayName: "Orion", internalName: "Orion",
    active: true, starting: false, createdBy: "user",
    views: { count: 3, latestAt: 1786303213, latestName: "agent-result.md", latestTitle: "Views end-to-end", latestPath: "/view/Orion/agent-result.md/inline" }
  },
  { name: "Nebula", displayName: "Nebula", internalName: "Nebula", active: true, starting: false, createdBy: "user" }
];

describe("switcher views affordances", () => {
  const onOpenViews = vi.fn();
  const props = {
    sessions: switcherSessions, currentRoom: null,
    onClose: vi.fn(), onSwitch: vi.fn(), onRefresh: vi.fn(), onNotice: vi.fn(), onOpenViews
  };

  beforeEach(() => {
    sessionStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  it("opens scoped from a card chip and fleet-wide from the header", () => {
    render(<SessionSwitcher {...props} open />);
    const chip = screen.getByRole("button", { name: "3 published views in Orion" });
    expect(chip.className).toContain("fresh");          // no marker yet = unseen
    fireEvent.click(chip);
    expect(onOpenViews).toHaveBeenCalledWith("Orion");

    fireEvent.click(screen.getByRole("button", { name: "Published views" }));
    expect(onOpenViews).toHaveBeenLastCalledWith();     // no argument = the fleet
    expect(screen.queryByRole("button", { name: /published views in Nebula/ })).toBeNull();
    expect(screen.getByLabelText("New views")).toBeTruthy();
  });

  it("goes quiet once the marker covers the newest view", () => {
    store["hop_views_seen"] = JSON.stringify({ Orion: 1786303213 });
    render(<SessionSwitcher {...props} open />);
    expect(screen.getByRole("button", { name: "3 published views in Orion" }).className).not.toContain("fresh");
    expect(screen.queryByLabelText("New views")).toBeNull();
  });
});
