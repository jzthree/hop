import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("docked, it has no backdrop, leaves Escape to the terminal, and offers unpinning", () => {
    const onClose = vi.fn();
    const onDockChange = vi.fn();
    render(<SessionRail sessions={sessions} folders={folders} currentRoom="alpha" docked canDock
                        onPick={() => {}} onAllSessions={() => {}} onClose={onClose} onDockChange={onDockChange} />);
    expect(document.querySelector(".rail-backdrop")).toBeNull();
    expect(screen.queryByLabelText("Close sessions")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Unpin the sidebar"));
    expect(onDockChange).toHaveBeenCalledWith(false);
  });

  it("arranges by folder or most recent first, and shows check-backs", () => {
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
    expect(screen.getByTitle("2 check-backs scheduled").textContent).toBe("⏰2");
    fireEvent.click(screen.getByLabelText("Arrange: by folder"));
    expect(names()).toEqual(["beta", "gamma", "alpha"]);
    expect(localStorage.getItem("hop_rail_order")).toBe("recent");
  });

  it("right-click on a row parks it", () => {
    const onPark = vi.fn();
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null} onPark={onPark}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    fireEvent.contextMenu(screen.getByText("gamma"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Park" }));
    expect(onPark).toHaveBeenCalledWith(expect.objectContaining({ name: "gamma" }), true);
  });

  it("on the wall: All sessions is where you are, the wall's search filters the list, nav rows open places", () => {
    const openViews = vi.fn();
    let slot: HTMLDivElement | null = null;
    render(<SessionRail sessions={sessions} folders={folders} currentRoom={null} docked onWall
                        searchSlot={(el) => { slot = el; }} externalFilter="gam"
                        nav={[{ key: "views", label: "Views", icon: "◧", onClick: openViews }]}
                        onPick={() => {}} onAllSessions={() => {}} onClose={() => {}} />);
    expect(slot).not.toBeNull();
    expect(screen.queryByLabelText("Jump to a session")).toBeNull();
    expect(names().filter((n) => n !== "Views")).toEqual(["gamma"]);
    expect(screen.getByText("All sessions").closest("button")?.getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByText("Views"));
    expect(openViews).toHaveBeenCalled();
  });
});
