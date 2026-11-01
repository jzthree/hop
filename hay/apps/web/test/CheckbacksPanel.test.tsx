import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckbacksPanel } from "../src/components/CheckbacksPanel";
import { addDays } from "../src/utils/calendar";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items: [], automations: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("CheckbacksPanel", () => {
  it("as a session's tab: no backdrop, takes the keyboard, Esc goes back", async () => {
    const onClose = vi.fn();
    render(<CheckbacksPanel placement="tab" session="s_x" sessionName="x" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Nothing scheduled on this session.")).toBeTruthy());
    expect(document.querySelector(".views-backdrop")).toBeNull();
    const panel = screen.getByRole("tabpanel", { name: "Calendar for x" });
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("a week of days: entries on theirs, a fast repeat as a band, ← → a week, picking one reads it", async () => {
    const now = Date.now();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ automations: [], items: [
      { id: "a", session: "s_x", message: "look at the run", trigger: { kind: "at", at: addDays(now, 2) + 12 * 3_600_000 }, status: "pending", createdBy: "agent" },
      { id: "b", session: "s_x", message: "poll the queue", trigger: { kind: "every", everyMs: 1_800_000, next: now + 60_000 }, status: "pending" }
    ] }) })));
    render(<CheckbacksPanel placement="tab" session="s_x" sessionName="x" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("look at the run")).toBeTruthy());
    const days = [...document.querySelectorAll(".cal-day")];
    expect(days).toHaveLength(7);
    expect(days[2].textContent).toContain("look at the run");
    // The band runs every day from today.
    expect(document.querySelectorAll(".cal-entry.band")).toHaveLength(7);
    fireEvent.click(screen.getByText("look at the run"));
    expect(document.querySelector(".cal-detail")!.textContent).toContain("by the agent");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".cal-detail")).toBeNull();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.queryByText("look at the run")).toBeNull();
    fireEvent.click(screen.getByText("Today"));
    expect(screen.getByText("look at the run")).toBeTruthy();
  });

  it("elsewhere, the centred window over a backdrop", async () => {
    render(<CheckbacksPanel session="s_x" sessionName="x" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Calendar for x" })).toBeTruthy());
    expect(document.querySelector(".views-backdrop")).not.toBeNull();
  });
});
