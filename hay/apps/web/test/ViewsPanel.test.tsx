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
  const title = (text: string) => screen.getAllByText(text).find((el) => el.closest(".vg-caption"))!;
  const openCard = async (text: string) => {
    await waitFor(() => expect(screen.getAllByText(text).length).toBeGreaterThan(0));
    fireEvent.click(title(text).closest("a")!);
  };

  it("opens on the gallery: cards by day, figures as thumbnails, documents as typeset cards", async () => {
    render(<ViewsPanel sessions={[{ name: "Orion", displayName: "orion-worker", internalName: "Orion" }]} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(3));
    expect(document.querySelector("iframe.views-frame")).toBeNull();
    // Title first, the filename when there is none; the session by its
    // renamed name.
    expect(title("Views end-to-end")).toBeTruthy();
    expect(title("views-test.html")).toBeTruthy();
    expect(screen.getAllByText(/orion-worker/).length).toBeGreaterThan(0);
    // An image is its own (lazy) thumbnail; a document gets its kind tag.
    const thumb = document.querySelector(".vg-thumb.image img") as HTMLImageElement;
    expect(thumb.getAttribute("src")).toBe("/view/Nebula/shot.png/thumb");
    expect(thumb.getAttribute("loading")).toBe("lazy");
    expect(screen.getByText("MD")).toBeTruthy();
    // Grouped under a day heading.
    expect(document.querySelectorAll(".vg-day-head").length).toBeGreaterThan(0);
    // A card is a real link: ⌘-click and "copy link address" keep their meaning.
    const link = title("Views end-to-end").closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/view/Orion/agent-result.md/inline");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.className).toContain("fresh");
    // Opening IS seeing: every session on screen gets its high-water mark.
    await waitFor(() => expect(loadViewsSeen()).toEqual({ Orion: 1786303213, Nebula: 1786299000 }));
    expect(hasUnseenViews("Orion", 1786303213, loadViewsSeen())).toBe(false);
    expect(hasUnseenViews("Orion", 1786303300, loadViewsSeen())).toBe(true);
  });

  it("a card opens the reader in place; ‹ › and ← → step; Esc goes back, then closes", async () => {
    const onClose = vi.fn();
    render(<ViewsPanel onClose={onClose} />);
    await openCard("Views end-to-end");
    let frame = document.querySelector("iframe.views-frame") as HTMLIFrameElement;
    // Rendered documents carry the wall's theme; our own files are never
    // sandboxed (a sandboxed iframe disables the browser's PDF viewer).
    expect(frame.getAttribute("src")).toBe("/view/Orion/agent-result.md/inline?theme=light");
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next view" }));
    frame = document.querySelector("iframe.views-frame") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/view/Orion/views-test.html/inline");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("3 / 3")).toBeTruthy();
    expect(document.querySelector(".views-media img")).toBeTruthy();
    // The filmstrip marks where you are, and a click there turns the page.
    fireEvent.click(document.querySelectorAll(".vg-strip-item")[0]);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".vg-reader")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("opened straight on one result (a link, an inline card): Esc closes, there was no gallery before", async () => {
    const onClose = vi.fn();
    render(<ViewsPanel session="Orion" item="views-test.html" onClose={onClose} />);
    await waitFor(() => expect((document.querySelector("iframe.views-frame") as HTMLIFrameElement)?.getAttribute("src")).toBe("/view/Orion/views-test.html/inline"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("filters by kind and searches by title, file or session", async () => {
    render(<ViewsPanel onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(3));
    fireEvent.click(screen.getByRole("tab", { name: /Figures/ }));
    expect(document.querySelectorAll(".vg-card").length).toBe(1);
    fireEvent.click(screen.getByRole("tab", { name: /Pages/ }));
    expect(title("views-test.html")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    fireEvent.change(screen.getByLabelText("Search views"), { target: { value: "nebula" } });
    expect(document.querySelectorAll(".vg-card").length).toBe(1);
    fireEvent.change(screen.getByLabelText("Search views"), { target: { value: "nothing-like-it" } });
    expect(screen.getByText(/Nothing here matches/)).toBeTruthy();
  });

  it("the keyboard walks the gallery: arrows move, ⏎ opens", async () => {
    render(<ViewsPanel onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(3));
    expect(document.querySelectorAll(".vg-card")[0].className).toContain("kbd");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(document.querySelectorAll(".vg-card")[1].className).toContain("kbd");
    fireEvent.keyDown(window, { key: "Enter" });
    expect((document.querySelector("iframe.views-frame") as HTMLIFrameElement).getAttribute("src")).toBe("/view/Orion/views-test.html/inline");
  });

  it("Download saves the stored file itself through a same-origin anchor", async () => {
    const clicked: Array<{ href: string; download: string }> = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href") || "", download: this.download });
    };
    try {
      render(<ViewsPanel onClose={() => {}} />);
      await openCard("Views end-to-end");
      fireEvent.click(screen.getByRole("button", { name: "Download agent-result.md" }));
      expect(clicked).toEqual([{ href: "/view/Orion/agent-result.md/download", download: "agent-result.md" }]);
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
  });

  it("docked: no backdrop, and keys are focus-scoped", async () => {
    vi.stubGlobal("innerWidth", 1280);
    const onClose = vi.fn();
    render(<ViewsPanel session="Orion" dock onClose={onClose} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(2));
    const panel = document.querySelector(".views-panel") as HTMLDivElement;
    expect(panel.className).toContain("docked");
    expect(document.querySelector(".views-backdrop")).toBeNull();
    // A key from OUTSIDE the panel (the terminal) is not the panel's: Esc
    // is a real key in a shell.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("a session picked in the sidebar refilters the page; Open session goes into it", async () => {
    const onOpenSession = vi.fn();
    const { rerender } = render(<ViewsPanel session="Orion" placement="page" onOpenSession={onOpenSession} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(2));
    fireEvent.click(screen.getByRole("tab", { name: "all" }));
    expect(document.querySelectorAll(".vg-card").length).toBe(3);
    // Another session picked: its results, and the "all" widening undone.
    rerender(<ViewsPanel session="Nebula" placement="page" onOpenSession={onOpenSession} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(1));
    expect(screen.getByRole("tab", { name: "all" }).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /Open session/ }));
    expect(onOpenSession).toHaveBeenCalledWith("Nebula");
  });

  it("a session that has published nothing says so — it never widens by itself", async () => {
    render(<ViewsPanel session="Nowhere" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Nothing published yet by this session/)).toBeTruthy());
    expect(screen.getByRole("tab", { name: "all" }).getAttribute("aria-selected")).toBe("false");
  });

  it("scoped open can widen to the fleet without reopening", async () => {
    render(<ViewsPanel session="Orion" onClose={() => {}} />);
    await waitFor(() => expect(title("Views end-to-end")).toBeTruthy());
    expect(screen.queryByText("shot.png")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "all" }));
    await waitFor(() => expect(title("shot.png")).toBeTruthy());
  });

  it("clear is two-step, scope-bounded, and leaves live servers alone", async () => {
    render(<ViewsPanel session="Orion" onClose={() => {}} />);
    await waitFor(() => expect(title("Views end-to-end")).toBeTruthy());
    fireEvent.click(screen.getByText("clear"));
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1]?.method === "DELETE").length).toBe(0);
    fireEvent.click(screen.getByText("release the copies?"));
    await waitFor(() => {
      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1]?.method === "DELETE");
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0][1].body)).toEqual({ session: "Orion", all: true });
    });
    await waitFor(() => expect(screen.queryAllByText("Views end-to-end").length).toBe(0));
  });

  it("delete is two-step from the reader, and only the second click calls the API", async () => {
    render(<ViewsPanel onClose={() => {}} />);
    await openCard("Views end-to-end");
    fireEvent.click(screen.getByLabelText("Delete"));
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1]?.method === "DELETE").length).toBe(0);
    fireEvent.click(screen.getByLabelText("Click again to delete"));
    await waitFor(() => {
      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1]?.method === "DELETE");
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0][1].body)).toEqual({ session: "Orion", name: "agent-result.md" });
    });
    // Gone only because the server said ok — and the reader goes with it.
    await waitFor(() => expect(screen.queryAllByText("Views end-to-end").length).toBe(0));
    expect(document.querySelector(".vg-reader")).toBeNull();
  });

  it("scopes to one session without pruning the others' markers", async () => {
    store["hop_views_seen"] = JSON.stringify({ Nebula: 1 });
    render(<ViewsPanel session="orion" onClose={() => {}} />);
    await waitFor(() => expect(title("Views end-to-end")).toBeTruthy());
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
    await waitFor(() => expect(title("Views end-to-end")).toBeTruthy());
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
    // The header entry says the word and wears the count of sessions with
    // something new — not a 5px dot in a corner.
    expect(screen.getByRole("button", { name: "Published views" }).textContent).toContain("1 new");
  });

  it("goes quiet once the marker covers the newest view", () => {
    store["hop_views_seen"] = JSON.stringify({ Orion: 1786303213 });
    render(<SessionSwitcher {...props} open />);
    expect(screen.getByRole("button", { name: "3 published views in Orion" }).className).not.toContain("fresh");
    expect(screen.queryByLabelText("New views")).toBeNull();
  });
});
