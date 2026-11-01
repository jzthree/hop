import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckbacksPanel } from "../src/components/CheckbacksPanel";

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
    const panel = screen.getByRole("tabpanel", { name: "Scheduled for x" });
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("elsewhere, the centred window over a backdrop", async () => {
    render(<CheckbacksPanel session="s_x" sessionName="x" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Scheduled for x" })).toBeTruthy());
    expect(document.querySelector(".views-backdrop")).not.toBeNull();
  });
});
