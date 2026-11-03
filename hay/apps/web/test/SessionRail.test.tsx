import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRail, type RailSession } from "../src/components/SessionRail";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => { values.set(k, v); },
    removeItem: (k: string) => { values.delete(k); },
    clear: () => values.clear()
  });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const sessions: RailSession[] = [
  { name: "alpha", displayName: "alpha", folderId: "f1", lastActivityAt: 100 },
  { name: "beta", displayName: "beta", folderId: "f1", lastActivityAt: 300, checkbacks: 2 },
  { name: "gamma", displayName: "gamma", lastActivityAt: 200 }
];
const folders = [{ id: "f1", name: "Work" }];
const names = () => [...document.querySelectorAll(".rail-row:not(.all) .rail-name")].map((n) => n.textContent);

describe("SessionRail", () => {
  it("docked, it has no backdrop, leaves Escape to the terminal, and hides from its options menu", () => {
    const onClose = vi.fn();
    const onDockChange = vi.fn();
    render(<SessionRail sessions={sessions} folders={folders} currentRoom="alpha" docked canDock
                        onPick={() => {}} onAllSessions={() => {}} onClose={onClose} onDockChange={onDockChange} />);
    expect(document.querySelector(".rail-backdrop")).toBeNull();
    expect(screen.queryByLabelText("Close sessions")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Sidebar options"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Hide sidebar/ }));
    expect(onDockChange).toHaveBeenCalledWith(false);
  });

  it("arranges by folder or most recent first, and shows check-backs", () => {
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
    expect(screen.getByTitle("2 check-backs scheduled").textContent).toBe("2");
    fireEvent.click(screen.getByLabelText("Arrange: by folder"));
    expect(names()).toEqual(["beta", "gamma", "alpha"]);
    expect(localStorage.getItem("hop_rail_order")).toBe("recent");
  });

  const ctx = () => ({ notice: vi.fn(), refresh: vi.fn() });
  const fetched = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u) !== "/api/agent-homes");

  it("a row's right-click: the session's whole menu; Park goes to the daemon and refreshes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ claude: [], codex: [] }) })));
    const c = ctx();
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null} actionContext={c}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    fireEvent.contextMenu(screen.getByText("gamma"));
    const labels = screen.getAllByRole("menuitem").map((b) => b.textContent);
    for (const want of ["Open full screen", "Rename", "Fork session", "Park session", "Kill session"]) expect(labels.join("|")).toContain(want);
    fireEvent.click(screen.getByRole("menuitem", { name: "Park session" }));
    await waitFor(() => expect(c.refresh).toHaveBeenCalled());
    const [url, init] = fetched()[0];
    expect(url).toBe("/api/sessions/park");
    expect(JSON.parse(init.body)).toEqual({ internalName: "gamma", parked: true });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("submenus open by hover or by keyboard, tick the current choice, and act", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ claude: [], codex: [] }) })));
    const c = ctx();
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null} actionContext={c}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    fireEvent.contextMenu(screen.getByText("alpha"));
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /Move to folder/ }));
    expect(screen.getByRole("menuitem", { name: /Work/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: /No folder/ }));
    await waitFor(() => expect(fetched().length).toBe(1));
    expect(JSON.parse(fetched()[0][1].body)).toEqual({ internalName: "alpha", folderId: null });
    // The keyboard: down to Rename's neighbour, → in, Esc out, Esc closed.
    fireEvent.contextMenu(screen.getByText("alpha"));
    const move = screen.getByRole("menuitem", { name: /Move to folder/ });
    fireEvent.mouseEnter(move);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getAllByRole("menu").length).toBe(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getAllByRole("menu").length).toBe(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Rename edits in place: Enter saves, Esc leaves it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ claude: [], codex: [] }) })));
    const c = ctx();
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null} actionContext={c}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    fireEvent.contextMenu(screen.getByText("gamma"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByLabelText("New name for gamma") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("New name for gamma")).toBeNull();
    fireEvent.contextMenu(screen.getByText("gamma"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name for gamma"), { target: { value: "delta" } });
    fireEvent.submit(screen.getByLabelText("New name for gamma").closest("form")!);
    await waitFor(() => expect(c.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetched()[0][1].body)).toMatchObject({ newName: "delta", internalName: "gamma" });
    await waitFor(() => expect(screen.queryByLabelText("New name for gamma")).toBeNull());
  });

  it("the ⋯ opens the same menu; a folder's menu and the list's have their own", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ claude: [], codex: [] }) })));
    const onPlace = vi.fn();
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null} actionContext={ctx()} onOpenPlace={onPlace}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Actions for beta"));
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /^Show/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Calendar/ }));
    expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ name: "beta" }), "calendar");
    fireEvent.contextMenu(screen.getByText("Work"));
    expect(screen.getByRole("menuitem", { name: "Rename folder…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Collapse" }));
    expect(screen.queryByText("alpha")).toBeNull();
    fireEvent.contextMenu(document.querySelector(".rail-list")!);
    expect(screen.getByRole("menuitem", { name: /Arrange/ })).toBeTruthy();
  });

  it("docked on the wall: Sessions is where you are, places sit in the strip, the wall's search filters the list", () => {
    const openViews = vi.fn();
    let slot: HTMLDivElement | null = null;
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null} docked onWall
                        searchSlot={(el) => { slot = el; }} externalFilter="gam"
                        nav={[{ key: "views", label: "Views", icon: "◧", onClick: openViews }]}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    expect(slot).not.toBeNull();
    expect(screen.queryByLabelText("Jump to a session")).toBeNull();
    expect(names()).toEqual(["gamma"]);
    expect(screen.getByRole("button", { name: "Sessions" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(openViews).toHaveBeenCalled();
    // Scope lives in the options menu; a non-default one shows as a chip.
    expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();
  });

  it("a page-owned scope: the sidebar shows it and reports changes instead of keeping its own", () => {
    const onScopeChange = vi.fn();
    render(<SessionRail sessions={[...sessions, { name: "bot", displayName: "bot", createdBy: "agent" }]} folders={folders}
                        currentRoom={null} scope="agent" onScopeChange={onScopeChange}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    expect(names()).toEqual(["bot"]);
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(onScopeChange).toHaveBeenCalledWith("all");
    expect(names()).toEqual(["bot"]);
  });

  it("docked, double-clicking the edge resets the width", () => {
    const onResize = vi.fn();
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null} docked onResize={onResize}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize the sidebar" }));
    expect(onResize).toHaveBeenCalledWith(null);
  });

  it("docked: the options menu sets the scope, and the chip it leaves resets it", () => {
    const onScopeChange = vi.fn();
    const { rerender } = render(<SessionRail sessions={sessions} folders={folders} currentRoom={null} docked scope="user" onScopeChange={onScopeChange}
                                             onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Sidebar options"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Agents' sessions/ }));
    expect(onScopeChange).toHaveBeenLastCalledWith("agent");
    rerender(<SessionRail sessions={sessions} folders={folders} currentRoom={null} docked scope="agent" onScopeChange={onScopeChange}
                          onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Agents/ }));
    expect(onScopeChange).toHaveBeenLastCalledWith("user");
  });

  it("search switches: best match first, ↑↓ choose, ⏎ opens, an unknown name creates, Esc clears then hands back", () => {
    const onPick = vi.fn(); const onCreate = vi.fn(); const onSearchDone = vi.fn();
    const fleet: RailSession[] = [
      { name: "my-hop", displayName: "my-hop", lastActivityAt: 50 },
      { name: "hop", displayName: "hop", lastActivityAt: 10 },
      { name: "chop-suey", displayName: "chop-suey", lastActivityAt: 90 },
      { name: "notes", displayName: "notes", tagline: "hop design notes", lastActivityAt: 99 }
    ];
    render(<SessionRail sessions={fleet} folders={[]} currentRoom={null} docked focusSignal={1}
                        onPick={onPick} onCreate={onCreate} onSearchDone={onSearchDone}
                        onAllSessions={() => {}} onClose={() => {}} />);
    const box = screen.getByLabelText("Jump to a session") as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "hop" } });
    // name start, then a word's start, then inside a name, then the tagline
    expect(names()).toEqual(["hop", "my-hop", "chop-suey", "notes"]);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: "my-hop" }));
    fireEvent.change(box, { target: { value: "brand-new" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith("brand-new");
    fireEvent.change(box, { target: { value: "x" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.value).toBe("");
    expect(onSearchDone).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onSearchDone).toHaveBeenCalled();
  });

  it("searching to switch puts the session already on screen last", () => {
    render(<SessionRail sessions={[{ name: "hop-a", displayName: "hop-a" }, { name: "hop-b", displayName: "hop-b" }]} folders={[]}
                        currentRoom="hop-a" docked onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Jump to a session"), { target: { value: "hop" } });
    expect(names()).toEqual(["hop-b", "hop-a"]);
  });

  it("lists recently closed sessions, each a click from coming back (or forgotten)", async () => {
    const onBringBack = vi.fn(async () => true); const onForgetClosed = vi.fn();
    const closed = [{ internalName: "s_baby", displayName: "babygame", cwd: "/w", agent: "claude", how: "killed", closedAt: Date.now() - 2 * 3600_000, resumable: true }];
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null} closed={closed} onBringBack={onBringBack} onForgetClosed={onForgetClosed}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Recently closed/ }));
    expect(screen.getByText("babygame")).toBeTruthy();
    expect(screen.getByText(/killed 2h ago · claude/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bring back" }));
    await waitFor(() => expect(onBringBack).toHaveBeenCalledWith(closed[0]));
    fireEvent.click(screen.getByLabelText("Forget babygame"));
    expect(onForgetClosed).toHaveBeenCalledWith(closed[0]);
  });
});
