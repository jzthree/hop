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
    // The same story cards as the front page: the latest under its slot, then Earlier.
    expect([...document.querySelectorAll(".brief-story .brief-headline")].map((h) => h.textContent)).toEqual(["Ship the fix?", "Started the fix"]);
    expect([...document.querySelectorAll(".brief-slot-head")].map((h) => h.firstChild!.textContent)).toEqual(["Decide", "Earlier"]);
    expect(screen.getAllByText("Ship")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show the whole briefing" }));
    expect(onClearSession).toHaveBeenCalled();
  });

  it("an ask can be skipped: nothing is sent, it reads as handled, and it folds away (undoable)", () => {
    const onReply = vi.fn(async () => true); const markRead = vi.fn();
    render(<BriefingPage {...base} onReply={onReply} markRead={markRead} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onReply).not.toHaveBeenCalled();
    expect(markRead).toHaveBeenCalledWith(editions[0].generated_at, "s_orion");
    expect(screen.queryByRole("button", { name: "Ship" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Skipped · Undo/ }));
    expect(screen.getByRole("button", { name: "Ship" })).toBeTruthy();
  });

  it("as a session's tab: no heading of its own, and the newest ask is answerable there", async () => {
    const onReply = vi.fn(async () => true);
    render(<BriefingPage {...base} inSession session="s_orion" onReply={onReply} />);
    expect(screen.getByRole("tabpanel", { name: "Briefing" })).toBeTruthy();
    expect(document.querySelector(".place-head")).toBeNull();
    expect(screen.queryByText(/Open orion/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Ship" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    await waitFor(() => expect(onReply).toHaveBeenCalledWith("s_orion", "Ship"));
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

  it("an item can be skipped and brought back; a figure is drawn where its caption line was", () => {
    const withFig = parsePulseFeed({ pulses: [{ engine: "claude", label: "Claude", date: "2026-11-01", title: "T", sections: [
      { id: "a1", kind: "article", title: "Idea", body: "Before.\n\n*Figure: A sketch.*\n\nAfter.", figures: [{ caption: "A sketch.", name: "a.png", src: "/assets/pulse-figures/2026-11-01/a.png" }] },
      { id: "o1", kind: "overlooked", body: "Loose end.", figures: [{ caption: "x", src: "https://evil.example/x.png" }] }
    ], actions: [{ id: "o1", label: "Follow up", cwd: "/w", session_name: "fu", command: "go" }] }] });
    render(<PulsePage feed={withFig} existing={new Set()} onFollowUp={vi.fn()} markSeen={() => {}} onClose={() => {}} />);
    const img = document.querySelector(".prose-figure img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/assets/pulse-figures/2026-11-01/a.png");
    expect(screen.getByText("A sketch.").tagName).toBe("FIGCAPTION");
    expect(withFig!.days[0].pulses[0].sections[1].figures).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(document.querySelector(".pulse-card.skipped")?.textContent).toMatch(/Loose end\./);
    expect(screen.queryByRole("button", { name: /^Follow up/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Skipped · Undo/ }));
    expect(screen.getByRole("button", { name: /^Follow up/ })).toBeTruthy();
  });

  it("with a session, the page is that session's share: items it owns or that followed up into it", () => {
    const onClearSession = vi.fn(); const markSeen = vi.fn();
    const { unmount } = render(<PulsePage feed={feed} existing={new Set()} onFollowUp={vi.fn()} sessions={sessions} session="orion"
                                          onClearSession={onClearSession} markSeen={markSeen} onClose={() => {}} />);
    expect(screen.getByText(/raised for orion · 1 item/)).toBeTruthy();
    expect(screen.getByText("A loose end.")).toBeTruthy();
    expect(screen.queryByText("Another.")).toBeNull();
    expect(markSeen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show the whole pulse" }));
    expect(onClearSession).toHaveBeenCalled();
    unmount();
    render(<PulsePage feed={feed} existing={new Set()} onFollowUp={vi.fn()} sessions={[...sessions, { name: "fu-2", internalName: "s_fu2" }]}
                      session="s_fu2" inSession markSeen={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("tabpanel", { name: "Pulse" })).toBeTruthy();
    expect(screen.getByText("Another.")).toBeTruthy();
  });
});
