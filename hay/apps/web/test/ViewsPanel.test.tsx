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
  it("Download saves the stored file itself through a same-origin anchor, in the list and in the preview", async () => {
    // The row is an <a>, so the button clicks a hidden anchor of its own;
    // capture what that anchor asked the browser to do.
    const clicked: Array<{ href: string; download: string }> = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href") || "", download: this.download });
    };
    try {
      render(<ViewsPanel onClose={() => {}} />);
      await waitFor(() => expect(document.querySelector("iframe.views-frame")).toBeTruthy());
      // The newest is already the page, so the same download exists twice:
      // on its row in the index, and on the reader's bar.
      const both = screen.getAllByRole("button", { name: "Download agent-result.md" });
      expect(both.length).toBe(2);
      const inList = both.find((b) => b.closest(".views-list"))!;
      const inReader = both.find((b) => b.closest(".views-nav"))!;
      fireEvent.click(inList);
      expect(clicked).toEqual([{ href: "/view/Orion/agent-result.md/download", download: "agent-result.md" }]);
      fireEvent.click(inReader);
      expect(clicked.length).toBe(2);
      expect(clicked[1].href).toBe("/view/Orion/agent-result.md/download");
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
  });

  it("opens STRAIGHT INTO the newest result; a row click switches the page; the row stays a real link", async () => {
    const onClose = vi.fn();
    render(<ViewsPanel onClose={onClose} />);
    await waitFor(() => expect(document.querySelector("iframe.views-frame")).toBeTruthy());
    // jsdom's window is 1024 wide — the desk case, where the page exists.
    // No click needed: the newest item is already the page.
    let frame = document.querySelector("iframe.views-frame") as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    // Rendered documents carry the wall's theme into the iframe — the OS
    // doesn't know what the wall chose, so the URL has to say.
    expect(frame.getAttribute("src")).toBe("/view/Orion/agent-result.md/inline?theme=light");
    // Our own files must NOT be sandboxed — a sandboxed iframe disables the
    // browser's PDF viewer, which is half of what the pane is for.
    expect(frame.hasAttribute("sandbox")).toBe(false);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    // The index is beside the page from the start — both in one window; a
    // plain click on a row turns the page.
    expect(document.querySelector(".views-panel.rail-side .views-list")).toBeTruthy();
    const row = screen.getByText("views-test.html").closest("a") as HTMLAnchorElement;
    expect(row.getAttribute("target")).toBe("_blank");
    fireEvent.click(row);
    frame = document.querySelector("iframe.views-frame") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/view/Orion/views-test.html/inline");
    expect(screen.getByText("2 / 3")).toBeTruthy();
    // ‹ › step through the rest, and so do the arrow keys.
    fireEvent.click(screen.getByRole("button", { name: "Next view" }));
    expect(screen.getByText("3 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("2 / 3")).toBeTruthy();
    // Escape closes the panel: the reader IS the panel, there is no list
    // mode underneath it to fall back to.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("docked: the page is open at once with the index beside it, and keys are focus-scoped", async () => {
    // The dock only exists on wide windows; jsdom defaults to 1024.
    vi.stubGlobal("innerWidth", 1280);
    const onClose = vi.fn();
    render(<ViewsPanel session="Orion" dock onClose={onClose} />);
    await waitFor(() => expect(document.querySelector("iframe.views-frame")).toBeTruthy());
    const panel = document.querySelector(".views-panel") as HTMLDivElement;
    expect(panel.className).toContain("docked");
    // No backdrop: the terminal beside the dock stays interactive.
    expect(document.querySelector(".views-backdrop")).toBeNull();
    // Straight to the page: the scoped session's newest is showing.
    expect((document.querySelector("iframe.views-frame") as HTMLIFrameElement).getAttribute("src"))
      .toBe("/view/Orion/agent-result.md/inline?theme=light");
    expect(screen.getByText("1 / 2")).toBeTruthy();

    // A key from OUTSIDE the panel (the terminal) must be ignored — Esc is a
    // real key in a shell, and answering it here would close a panel the
    // user wasn't even touching. The dock takes focus when it opens (so Esc
    // right away does close it); clicking into the terminal moves focus out.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // The index sits beside the page in the dock too; ☰ hides it for a
    // wider page and the choice is remembered.
    expect(document.querySelector(".views-panel.rail-side .views-list")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide the index" }));
    expect(document.querySelector(".views-list")).toBeNull();
    expect(store.hop_views_rail).toBe("0");
    expect(document.querySelector("iframe.views-frame")).toBeTruthy();
    // Esc from the panel closes it.
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("a session that has published nothing says so — it never widens by itself", async () => {
    render(<ViewsPanel session="Nowhere" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Nothing published yet by this session/)).toBeTruthy());
    expect(screen.getByRole("tab", { name: "all" }).getAttribute("aria-selected")).toBe("false");
    expect(document.querySelector("iframe.views-frame")).toBeNull();
  });

  it("scoped open can widen to the fleet without reopening", async () => {
    render(<ViewsPanel session="Orion" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Views end-to-end")).toBeTruthy());
    // Scoped: the other session's rows are absent.
    expect(screen.queryByText("shot.png")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "all" }));
    await waitFor(() => expect(screen.getByText("shot.png")).toBeTruthy());
  });

  it("clear is two-step, scope-bounded, and leaves live servers alone", async () => {
    render(<ViewsPanel session="Orion" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Views end-to-end")).toBeTruthy());
    const clear = screen.getByText("clear");
    fireEvent.click(clear);
    // Armed, not fired: freeing space is a decision, not a hover accident.
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1]?.method === "DELETE").length).toBe(0);
    fireEvent.click(screen.getByText("release the copies?"));
    await waitFor(() => {
      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[1]?.method === "DELETE");
      expect(calls.length).toBe(1);
      // Scoped open clears ONE session's copies, and says all — the daemon
      // deletes copies only, so the agent's source files cannot be touched.
      expect(JSON.parse(calls[0][1].body)).toEqual({ session: "Orion", all: true });
    });
    await waitFor(() => expect(screen.queryByText("Views end-to-end")).toBeNull());
  });

  it("delete is two-step, and only the second click calls the API", async () => {
    render(<ViewsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Views end-to-end")).toBeTruthy());
    const del = screen.getAllByLabelText("Delete")[0];
    fireEvent.click(del);
    // Armed, not deleted: nothing left the browser yet.
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1]?.method === "DELETE").length).toBe(0);
    fireEvent.click(screen.getAllByLabelText("Click again to delete")[0]);
    await waitFor(() => {
      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[1]?.method === "DELETE");
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0][1].body)).toEqual({ session: "Orion", name: "agent-result.md" });
    });
    // The row leaves the list only because the server said ok.
    await waitFor(() => expect(screen.queryByText("Views end-to-end")).toBeNull());
  });

  it("groups by session, leads with the title, falls back to the filename", async () => {
    render(<ViewsPanel sessions={[{ name: "Orion", displayName: "orion-worker", internalName: "Orion" }]} onClose={() => {}} />);
    // The newest title appears twice on purpose — in the index and on the
    // reader's bar — so the assertions below address the index's rows.
    await waitFor(() => expect(screen.getAllByText("Views end-to-end").length).toBeGreaterThan(0));
    const inList = (text: string) => screen.getAllByText(text).find((el) => el.closest(".views-list"))!;
    // The manifest only knows internalNames; the dateline shows the rename.
    expect(inList("orion-worker")).toBeTruthy();
    expect(screen.getByText("Nebula")).toBeTruthy();
    expect(screen.getByText("views-test.html")).toBeTruthy();
    expect(screen.getByText("MD")).toBeTruthy();
    // Images render as their own thumbnail, not a type tag — the file is the
    // most honest icon it could have.
    const thumb = document.querySelector("img.views-thumb") as HTMLImageElement;
    expect(thumb).toBeTruthy();
    expect(thumb.getAttribute("loading")).toBe("lazy");

    const link = inList("Views end-to-end").closest("a") as HTMLAnchorElement;
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
