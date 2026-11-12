import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagesPage } from "../src/components/MessagesPage";
import { statusLine, threadsOf, type AgentMessage } from "../src/utils/messageThreads";

const NOW = Date.parse("2026-11-12T18:00:00.000Z");
const M = 60_000;

// What the agents said: an orchestrator and a worker, the worker and an
// eval session, and one turned away.
const log: AgentMessage[] = [
  { id: "1", from: "s_boss", fromName: "boss", to: "s_w", toName: "worker", text: "Rerun the eval on results/af.csv", at: NOW - 60 * M, status: "delivered", deliveredAt: NOW - 59 * M },
  { id: "2", from: "s_w", fromName: "worker", to: "s_boss", toName: "boss", text: "Done: AUC 0.81 (was 0.79).", at: NOW - 30 * M, status: "delivered" },
  { id: "3", from: "s_boss", fromName: "boss", to: "s_w", toName: "worker", text: "Status?", at: NOW - 20 * M, status: "delivered", replyHere: true, replyAt: NOW - 18 * M, reply: "Two runs left, ETA 40 min." },
  { id: "4", from: "s_w", fromName: "worker", to: "s_eval", toName: "eval", text: "Can I use GPU 2?", at: NOW - 10 * M, status: "waiting", reason: "sends when the turn ends" },
  { id: "5", from: null, fromName: null, to: "s_eval", toName: "eval", text: "hello from outside", at: NOW - 70 * M, status: "refused", reason: "agent access is off for this session" }
];
const sessions = [
  { name: "boss", displayName: "boss", internalName: "s_boss", active: true, agent: "claude", agentPhase: "done" },
  { name: "worker", displayName: "worker", internalName: "s_w", active: true, agent: "claude", agentPhase: "working" },
  { name: "eval", displayName: "eval", internalName: "s_eval", active: false, agent: "codex" }
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** A conversation row by the names it shows ("a ⇄ b"). */
const row = (names: string) => {
  const hit = [...document.querySelectorAll(".msg-row")].find((b) => b.querySelector(".msg-row-names")?.textContent === names);
  if (!hit) throw new Error(`no conversation ${names}`);
  return hit as HTMLElement;
};

describe("messageThreads", () => {
  it("groups by pair, newest conversation first, an answer read off a turn counted", () => {
    const t = threadsOf(log);
    expect(t.map((x) => [x.a, x.b])).toEqual([["s_eval", "s_w"], ["s_boss", "s_w"], ["(outside)", "s_eval"]]);
    expect(t[1].messages.map((m) => m.id)).toEqual(["1", "2", "3"]);
    expect(t[1].count).toBe(4);
    expect(t[2].names["(outside)"]).toBe("an agent outside hop");
  });
  it("says what became of each message", () => {
    const fmt = () => "5:00 PM";
    expect(statusLine(log[0], fmt)).toBe("Delivered");
    expect(statusLine({ ...log[0], deliveredAt: log[0].at + 30 * M }, fmt)).toBe("Delivered 5:00 PM");
    expect(statusLine(log[3], fmt)).toBe("Waiting: sends when the turn ends");
    expect(statusLine({ ...log[3], reason: undefined }, fmt)).toBe("Waiting for eval to finish its turn");
    expect(statusLine(log[4], fmt)).toBe("Turned away: agent access is off for this session");
    expect(statusLine({ ...log[0], status: "held", reason: "12 messages between them in 10 minutes" }, fmt)).toMatch(/^Stopped: 12 messages/);
  });
});

describe("MessagesPage", () => {
  it("wide: the newest conversation open beside the list, read-only, each message's fate under it", () => {
    vi.stubGlobal("innerWidth", 1400);
    const seen = vi.fn();
    render(<MessagesPage placement="page" sessions={sessions} initial={log} now={NOW} onClose={() => {}} onOpenSession={() => {}} onSeen={seen} />);
    const list = screen.getByRole("navigation", { name: "Conversations" });
    expect(within(list).getAllByRole("button").map((b) => b.querySelector(".msg-row-names")?.textContent)).toEqual(["eval ⇄ worker", "boss ⇄ worker", "an agent outside hop ⇄ eval"]);
    // Opened on the newest: worker asking eval, still waiting.
    const thread = screen.getByRole("region", { name: "eval and worker" });
    expect(within(thread).getByText("Can I use GPU 2?")).toBeTruthy();
    expect(within(thread).getByText("Waiting: sends when the turn ends")).toBeTruthy();
    // Nothing to type into: messaging is for the agents.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(seen).toHaveBeenCalledWith(NOW - 10 * M);
  });

  it("a send-and-wait answer shows as the other side's words, and a name opens its session", () => {
    vi.stubGlobal("innerWidth", 1400);
    const open = vi.fn();
    render(<MessagesPage placement="page" sessions={sessions} initial={log} now={NOW} onClose={() => {}} onOpenSession={open} />);
    fireEvent.click(row("boss ⇄ worker"));
    const thread = screen.getByRole("region", { name: "boss and worker" });
    const answer = within(thread).getByText("Two runs left, ETA 40 min.").closest(".msg-item")!;
    expect(answer.classList.contains("reply")).toBe(true);
    expect(answer.querySelector(".msg-who")?.textContent).toBe("worker");
    expect(within(answer as HTMLElement).getByText("its turn's answer")).toBeTruthy();
    // Sides: boss on the left (sorted first), worker's words on the right.
    expect(within(thread).getByText("Rerun the eval on results/af.csv").closest(".msg-item")!.classList.contains("left")).toBe(true);
    expect(within(thread).getByText("Done: AUC 0.81 (was 0.79).").closest(".msg-item")!.classList.contains("right")).toBe(true);
    // Presence on the names; clicking one goes there.
    const worker = within(thread).getByTitle(/Open worker \(busy\)/);
    fireEvent.click(worker);
    expect(open).toHaveBeenCalledWith("s_w");
  });

  it("narrow (a phone): the list, then one conversation, and back", () => {
    const close = vi.fn();
    render(<MessagesPage placement="sheet" sessions={sessions} initial={log} now={NOW} onClose={close} onOpenSession={() => {}} />);
    expect(screen.queryByRole("region", { name: /and/ })).toBeNull();
    fireEvent.click(row("an agent outside hop ⇄ eval"));
    expect(screen.queryByRole("navigation", { name: "Conversations" })).toBeNull();
    expect(screen.getByText("Turned away: agent access is off for this session")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("navigation", { name: "Conversations" })).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalled();
  });

  it("empty: says what will show up here", () => {
    render(<MessagesPage placement="page" sessions={sessions} initial={[]} now={NOW} onClose={() => {}} onOpenSession={() => {}} />);
    expect(screen.getByText("No messages between sessions yet.")).toBeTruthy();
  });
});
