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

  it("as a page beside the sidebar: no backdrop, the sidebar stays live", async () => {
    const onClose = vi.fn();
    render(<ViewsPanel session="Orion" placement="page" onClose={onClose} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(2));
    expect((document.querySelector(".views-panel") as HTMLDivElement).className).toContain("page");
    expect(document.querySelector(".views-backdrop")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("side by side: no backdrop, keys only from inside, the layout toggle and the edge", async () => {
    const onClose = vi.fn(); const onToggleSide = vi.fn(); const onResizeSide = vi.fn();
    render(<ViewsPanel session="Orion" placement="side" onToggleSide={onToggleSide} onResizeSide={onResizeSide} onClose={onClose} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(2));
    const panel = document.querySelector(".views-panel") as HTMLDivElement;
    expect(panel.className).toContain("side");
    expect(document.querySelector(".views-backdrop")).toBeNull();
    // From the terminal beside it, Esc is the shell's.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Full page" }));
    expect(onToggleSide).toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize Views" }));
    expect(onResizeSide).toHaveBeenCalledWith(null);
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

  it("as a page sharing the sidebar, the sidebar's selection is the scope: a chip, × clears it", async () => {
    const onClearSession = vi.fn();
    const { rerender } = render(<ViewsPanel session="Orion" placement="page" onClearSession={onClearSession} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(2));
    expect(screen.queryByRole("tab", { name: "all" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show every session's results" }));
    expect(onClearSession).toHaveBeenCalled();
    rerender(<ViewsPanel placement="page" onClearSession={onClearSession} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(3));
    expect(document.querySelector(".views-scope-chip")).toBeNull();
  });

  it("leaves keys typed in a box outside it alone (⏎ in the sidebar's search picks a session)", async () => {
    render(<><input aria-label="Sidebar search" /><ViewsPanel placement="page" onClose={() => {}} /></>);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(3));
    const box = screen.getByLabelText("Sidebar search");
    box.focus();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(document.querySelector(".vg-reader")).toBeNull();
  });

  it("a Nebula notebook reads in place, read-only, with Open in Nebula one click away", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items: [
      { session: "Orion", name: "fit.ipynb.nebula.html", title: "Model fit", path: "/view/Orion/fit.ipynb.nebula.html/inline",
        kind: "link", app: "nebula", target: "http://localhost:3000/?file=%2Fdata%2Ffit.ipynb", mtime: 1786303213 }
    ] }) })));
    render(<ViewsPanel onClose={() => {}} />);
    await openCard("Model fit");
    expect(document.querySelector("iframe.views-frame")!.getAttribute("src")).toBe("/view/Orion/fit.ipynb.nebula.html/notebook");
    expect(screen.getByText("/data/fit.ipynb")).toBeTruthy();
    // Run it here: the live Nebula, through hop's relay, in place.
    fireEvent.click(screen.getByRole("button", { name: "Open in Nebula" }));
    expect(document.querySelector("iframe.views-frame")!.getAttribute("src")).toBe("/nebula/3000/?file=%2Fdata%2Ffit.ipynb");
    expect(screen.getByText("Live · Nebula")).toBeTruthy();
    const tab = screen.getByTitle("Nebula in its own tab");
    expect(tab.getAttribute("href")).toBe("/nebula/3000/?file=%2Fdata%2Ffit.ipynb");
    expect(tab.getAttribute("target")).toBe("_blank");
    fireEvent.click(screen.getByRole("button", { name: "Read-only" }));
    expect(document.querySelector("iframe.views-frame")!.getAttribute("src")).toBe("/view/Orion/fit.ipynb.nebula.html/notebook");
  });

  it("a Nebula that is not on this machine's localhost opens in its own tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items: [
      { session: "Orion", name: "far.ipynb.nebula.html", title: "Far fit", path: "/view/Orion/far.ipynb.nebula.html/inline",
        kind: "link", app: "nebula", target: "https://nebula.example.org/?file=%2Fdata%2Ffar.ipynb", mtime: 1786303213 }
    ] }) })));
    render(<ViewsPanel onClose={() => {}} />);
    await openCard("Far fit");
    expect(screen.queryByRole("button", { name: "Open in Nebula" })).toBeNull();
    const out = screen.getByText(/Open in Nebula ↗/).closest("a")!;
    expect(out.getAttribute("href")).toBe("https://nebula.example.org/?file=%2Fdata%2Ffar.ipynb");
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

// The shelf: files a session's agent wrote or named but never published —
// read in place, quiet (no "new" dots), and one click from being a view.
describe("ViewsPanel › Files from this session", () => {
  const found = [
    { id: "aaaaaaaaaaaaaaaa", name: "loss.png", file: "/Users/x/Code/p/results/loss.png", where: "~/Code/p/results/loss.png", how: "wrote", at: Date.now() - 60_000, mtime: 1786303000, bytes: 2048, path: "/sessionfile/Orion/aaaaaaaaaaaaaaaa/inline" },
    { id: "bbbbbbbbbbbbbbbb", name: "notes.md", file: "/Users/x/Code/p/notes.md", where: "~/Code/p/notes.md", how: "mentioned", at: Date.now() - 3_600_000, mtime: 1786300000, bytes: 300, path: "/sessionfile/Orion/bbbbbbbbbbbbbbbb/inline" }
  ];
  const routed = (views: unknown[], shelf: unknown[], calls: Array<{ url: string; body?: unknown }> = []) => vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("/api/sessions/files/pin")) return { ok: true, json: async () => ({ ok: true, view: "loss.png", path: "/view/Orion/loss.png/inline" }) };
    if (url.startsWith("/api/sessions/files")) return { ok: true, json: async () => ({ items: shelf }) };
    return { ok: true, json: async () => ({ items: views }) };
  });

  it("shelves them below the published, set apart and never marked new", async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal("fetch", routed(items, found, calls));
    render(<ViewsPanel session="Orion" sessions={[{ name: "Orion", internalName: "Orion" }]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("Files from this session")).toBeTruthy());
    expect(calls.some((c) => c.url === "/api/sessions/files?name=Orion")).toBe(true);
    const shelf = screen.getByLabelText("Files from this session");
    const cards = shelf.querySelectorAll(".vg-card");
    expect(cards.length).toBe(2);
    expect(cards[0].className).toContain("found");
    expect(cards[0].className).not.toContain("fresh");
    expect(shelf.querySelector(".views-dot")).toBeNull();
    expect((cards[0] as HTMLElement).getAttribute("title")).toBe("~/Code/p/results/loss.png");
    expect(cards[0].querySelector("img")!.getAttribute("src")).toBe("/sessionfile/Orion/aaaaaaaaaaaaaaaa/thumb");
    expect(cards[0].textContent).toMatch(/wrote/);
    expect(cards[1].textContent).toMatch(/named/);
    // The head counts what is published; the shelf counts itself.
    expect(document.querySelector(".vg-count")!.textContent).toBe("2");
  });

  it("every session's Views has no shelf (it is one session's)", async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal("fetch", routed(items, found, calls));
    render(<ViewsPanel onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(3));
    expect(calls.some((c) => c.url.startsWith("/api/sessions/files"))).toBe(false);
  });

  it("a found file reads in the reader, ‹ › walk on from the published into the shelf, and Pin makes it a view", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", routed(items.filter((i) => i.session === "Orion"), found, calls));
    render(<ViewsPanel session="Orion" sessions={[{ name: "Orion", internalName: "Orion" }]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("Files from this session")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Files from this session").querySelector("a")!);
    expect((document.querySelector(".views-media img") as HTMLImageElement).getAttribute("src")).toBe("/sessionfile/Orion/aaaaaaaaaaaaaaaa/inline");
    expect(document.querySelector(".views-nav-pos")!.textContent).toBe("3 / 4");
    expect(document.querySelector(".views-nav-meta")!.textContent).toMatch(/~\/Code\/p\/results\/loss\.png/);
    // Not a published copy: no delete — Pin instead.
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pin as a view" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/sessions/files/pin")?.body).toEqual({ name: "Orion", id: "aaaaaaaaaaaaaaaa" }));
  });

  it("opens straight on a found file (a path clicked in the terminal)", async () => {
    vi.stubGlobal("fetch", routed(items, found));
    render(<ViewsPanel session="Orion" found="bbbbbbbbbbbbbbbb" sessions={[{ name: "Orion", internalName: "Orion" }]} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector("iframe.views-frame")).toBeTruthy());
    expect(document.querySelector("iframe.views-frame")!.getAttribute("src")).toMatch(/^\/sessionfile\/Orion\/bbbbbbbbbbbbbbbb\/inline\?theme=/);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});

describe("ViewsPanel › Sharing", () => {
  const routed = (views: Array<Record<string, unknown>>, calls: Array<{ url: string; body?: unknown }>) => vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url === "/api/views/share") {
      return body.share
        ? { ok: true, json: async () => ({ ok: true, shared: true, token: "T0kenT0kenT0kenT0kenT0ke", url: "https://hop.example.io/shared/T0kenT0kenT0kenT0kenT0ke" }) }
        : { ok: true, json: async () => ({ ok: true, shared: false, url: null }) };
    }
    return { ok: true, json: async () => ({ items: views, shareBase: "https://hop.example.io" }) };
  });

  it("asks first, makes the link on Create, shows it, and Stop sharing takes it away", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", routed(items, calls));
    render(<ViewsPanel session="Orion" item="views-test.html" sessions={[{ name: "Orion", internalName: "Orion" }]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    // Nothing public yet: the bar explains, and only Create makes the link.
    expect(calls.some((c) => c.url === "/api/views/share")).toBe(false);
    expect(screen.getByRole("region", { name: "Public link" }).textContent).toMatch(/without signing in/);
    fireEvent.click(screen.getByRole("button", { name: "Create public link" }));
    await waitFor(() => expect((screen.getByLabelText("Public link", { selector: "input" }) as HTMLInputElement).value)
      .toBe("https://hop.example.io/shared/T0kenT0kenT0kenT0kenT0ke"));
    expect(calls.find((c) => c.url === "/api/views/share")!.body).toEqual({ session: "Orion", name: "views-test.html", share: true });
    expect(screen.getByRole("button", { name: "Shared" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create public link" })).toBeTruthy());
    expect(calls.filter((c) => c.url === "/api/views/share").pop()!.body).toEqual({ session: "Orion", name: "views-test.html", share: false });
  });

  it("a shared view says so on its card, and its link is hop's outside address", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const shared = items.map((i) => (i.name === "agent-result.md" ? { ...i, share: "S1S1S1S1S1S1S1S1S1S1S1S1" } : i));
    vi.stubGlobal("fetch", routed(shared, calls));
    render(<ViewsPanel session="Orion" sessions={[{ name: "Orion", internalName: "Orion" }]} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".vg-card").length).toBe(2));
    const cards = document.querySelectorAll(".vg-card");
    expect(cards[0].querySelector(".vg-shared")?.textContent).toBe("Shared");
    expect(cards[1].querySelector(".vg-shared")).toBeNull();
    fireEvent.click(cards[0]);
    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    expect((screen.getByLabelText("Public link", { selector: "input" }) as HTMLInputElement).value)
      .toBe("https://hop.example.io/shared/S1S1S1S1S1S1S1S1S1S1S1S1");
  });
});
