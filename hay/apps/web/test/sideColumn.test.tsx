// Briefing, Pulse and Calendar in the column beside the session: each has
// the way between its page and the column, the column's scope switch and
// resize edge, and there — beside a live terminal — answers only keys that
// start inside it.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BriefingPage } from "../src/components/BriefingPage";
import { PulsePage } from "../src/components/PulsePage";
import { CheckbacksPanel } from "../src/components/CheckbacksPanel";
import { parsePulseFeed } from "../src/utils/pulseFeed";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items: [], automations: [] }) })));
  vi.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const sessions = [{ name: "orion", displayName: "orion", internalName: "s_orion" }];
const editions = [
  { generated_at: "2026-11-01T12:00:00Z", summary: "One decision waits.", items: [{ session: "s_orion", headline: "Ship the fix?", slot: "decide" as const }] },
  { generated_at: "2026-11-01T09:00:00Z", summary: "Earlier.", items: [] }
];
const feed = parsePulseFeed({ pulses: [{ engine: "claude", label: "Claude", date: "2026-11-01", title: "Morning", sections: [{ id: "i", kind: "intro", body: "Hello." }] }] });

// A stand-in for the terminal beside the column.
const outside = () => {
  const t = document.createElement("textarea");
  document.body.appendChild(t);
  t.focus();
  return t;
};

const panes = {
  briefing: (p: Record<string, unknown>) => (
    <BriefingPage editions={editions} read={new Set()} sessions={sessions} onOpenSession={() => {}} markSeen={() => {}} markRead={() => {}}
                  onClose={() => {}} {...p} />
  ),
  pulse: (p: Record<string, unknown>) => (
    <PulsePage feed={feed} existing={new Set()} onFollowUp={vi.fn()} sessions={sessions} markSeen={() => {}} onClose={() => {}} {...p} />
  ),
  calendar: (p: Record<string, unknown>) => (
    <CheckbacksPanel session="*" sessionName="every session" onClose={() => {}} {...p} placement={p.side ? "side" : "page"} />
  )
};

describe.each(Object.entries(panes))("%s in the column", (_kind, pane) => {
  it("offers the way back to its page, the scope, a resize edge, and ×", async () => {
    const onToggleSide = vi.fn(); const onScope = vi.fn(); const onResizeSide = vi.fn(); const onClose = vi.fn();
    render(pane({ side: true, onToggleSide, onScope, onResizeSide, onClose, scopeLabel: "orion" }));
    const column = await screen.findByRole("complementary");
    expect(column.classList.contains("side")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Full page" }));
    expect(onToggleSide).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "orion" }));
    expect(onScope).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("tab", { name: "all" }));
    expect(onScope).toHaveBeenCalledWith(true);
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(onResizeSide).toHaveBeenCalledWith(null);
    fireEvent.click(column.querySelector(".views-close")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves Esc typed in the terminal beside it to the terminal; Esc inside closes it", async () => {
    const onClose = vi.fn();
    render(pane({ side: true, onClose }));
    const column = await screen.findByRole("complementary");
    const term = outside();
    fireEvent.keyDown(term, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    column.focus();
    fireEvent.keyDown(column, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    term.remove();
  });

  it("as a page, offers the way into the column", async () => {
    const onToggleSide = vi.fn();
    render(pane({ onToggleSide }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Side by side with the session" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Side by side with the session" }));
    expect(onToggleSide).toHaveBeenCalled();
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});

describe("a session's tab", () => {
  it("Briefing and Pulse tabs, which have no head, still offer the way into the column", () => {
    const a = vi.fn(); const b = vi.fn();
    render(<>{panes.briefing({ inSession: true, session: "orion", onToggleSide: a })}{panes.pulse({ inSession: true, session: "orion", onToggleSide: b })}</>);
    const buttons = screen.getAllByRole("button", { name: "Side by side with the session" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]); fireEvent.click(buttons[1]);
    expect(a).toHaveBeenCalled(); expect(b).toHaveBeenCalled();
  });
});
