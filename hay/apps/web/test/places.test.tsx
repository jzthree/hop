import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BriefingPage } from "../src/components/BriefingPage";
import { PulsePage } from "../src/components/PulsePage";
import { parsePulseFeed } from "../src/utils/pulseFeed";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  vi.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const sessions = [{ name: "orion", displayName: "orion", internalName: "s_orion" }, { name: "vega", displayName: "vega", internalName: "s_vega" }];
const editions = [
  { generated_at: "2026-11-01T12:00:00Z", summary: "One decision waits.", items: [
    { session: "s_orion", headline: "Ship the fix?", why: "It is ready.", slot: "decide" as const, recommendation: "Ship it.", replies: ["Ship", "Hold"] },
    { session: "s_vega", headline: "Training", slot: "watch" as const },
    { session: "s_vega", headline: "Wrote notes", slot: "also" as const }
  ] },
  { generated_at: "2026-11-01T09:00:00Z", summary: "Earlier.", items: [{ session: "s_orion", headline: "Started the fix", slot: "watch" as const }] }
];
const base = { editions, read: new Set<string>(), sessions, onOpenSession: () => {}, markSeen: () => {}, markRead: () => {}, onClose: () => {} };

describe("BriefingPage", () => {
  it("reads like a front page: the lede, then Decide / Watch / Also; a reply is typed into its session", async () => {
    const onReply = vi.fn(async () => true);
    render(<BriefingPage {...base} onReply={onReply} />);
    expect(screen.getByText("One decision waits.")).toBeTruthy();
    expect([...document.querySelectorAll(".brief-slot-head")].map((h) => h.firstChild!.textContent)).toEqual(["Decide", "Watch", "Also"]);
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    await waitFor(() => expect(onReply).toHaveBeenCalledWith("s_orion", "Ship"));
    await waitFor(() => expect(screen.getByRole("button", { name: /✓ Ship/ })).toBeTruthy());
    expect((screen.getByRole("button", { name: "Hold" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("← steps to the earlier edition; a session's name opens it; Esc closes", () => {
    const onOpenSession = vi.fn(); const onClose = vi.fn();
    render(<BriefingPage {...base} onOpenSession={onOpenSession} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("Earlier.")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Open this session"));
    expect(onOpenSession).toHaveBeenCalledWith("s_orion");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("with the sidebar's session, the page is that session's thread across editions", () => {
    const onClearSession = vi.fn();
    render(<BriefingPage {...base} session="orion" onClearSession={onClearSession} />);
    expect([...document.querySelectorAll(".brief-thread-item .brief-headline")].map((h) => h.textContent)).toEqual(["Ship the fix?", "Started the fix"]);
    fireEvent.click(screen.getByRole("button", { name: "Show the whole briefing" }));
    expect(onClearSession).toHaveBeenCalled();
  });
});

describe("PulsePage", () => {
  const feed = parsePulseFeed({
    pulses: [
      { engine: "claude", label: "Claude", date: "2026-11-01", title: "Morning pulse", sections: [
        { id: "i", kind: "intro", body: "Hello." },
        { id: "o1", kind: "overlooked", body: "A loose end." },
        { id: "o2", kind: "overlooked", body: "Another." },
        { id: "o3", kind: "overlooked", body: "A third." },
        { id: "a1", kind: "article", title: "An idea", body: "Long form." }
      ], actions: [
        { id: "o1", label: "Follow up", cwd: "/w", session_name: "fu-1", command: "go", target_internal_name: "s_orion", target_name: "orion", message: "note" },
        { id: "o2", label: "Follow up", cwd: "/w", session_name: "fu-2", command: "go" },
        { id: "o3", label: "Start it", cwd: "/w", session_name: "fu-3", command: "go" }
      ] },
      { engine: "gpt", label: "GPT", date: "2026-11-01", title: "GPT pulse", sections: [{ id: "i", kind: "intro", body: "Hi from GPT." }] }
    ]
  });
  it("lays out the day; each follow-up says what it will do, and does it", async () => {
    const onFollowUp = vi.fn(async () => true);
    render(<PulsePage feed={feed} existing={new Set(["fu-2"])} onFollowUp={onFollowUp} markSeen={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Morning pulse")).toBeTruthy();
    expect([...document.querySelectorAll(".pulse-act")].map((b) => b.textContent)).toEqual(["Send to orion →", "Open follow-up →", "Start it →"]);
    fireEvent.click(screen.getByText("Start it"));
    await waitFor(() => expect(onFollowUp).toHaveBeenCalledWith(expect.objectContaining({ sessionName: "fu-3" })));
    fireEvent.click(screen.getByRole("tab", { name: "GPT" }));
    expect(screen.getByText("GPT pulse")).toBeTruthy();
  });
});
