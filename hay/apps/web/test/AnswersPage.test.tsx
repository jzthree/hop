import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswersPage, type Answer } from "../src/components/AnswersPage";

const NOW = Date.parse("2026-11-12T18:00:00.000Z");
const M = 60_000;
const sessions = [
  { name: "trainer", displayName: "trainer", internalName: "s_t" },
  { name: "eval", displayName: "eval", internalName: "s_e" }
];
const answers: Answer[] = [
  { id: "g2", session: "s_t", sessionName: "trainer", agent: "claude", from: "agents", source: "scheduled", by: "coordinator",
    question: "Review the matched comparison from the durable handoff.", askedAt: NOW - 3 * M, answer: "Reviewed: the gain holds on both sets.", answeredAt: NOW - 2 * M, readAt: null },
  { id: "a3", session: "s_e", sessionName: "eval", agent: "codex", from: "you", source: "you", question: "what was the final AUC?", askedAt: NOW - 6 * M, answer: "0.812, up from 0.794.", answeredAt: NOW - 5 * M, readAt: null },
  { id: "g1", session: "s_e", sessionName: "eval", agent: "codex", from: "agents", source: "message", by: "plotter",
    question: "[hop message from session \"plotter\" (a Claude agent, not your user)] the plot moved", askedAt: NOW - 20 * M, answer: "Noted; redrawing.", answeredAt: NOW - 19 * M, readAt: NOW - 10 * M },
  { id: "a2", session: "s_t", sessionName: "trainer", agent: "claude", question: "why is the validation loss flat?", askedAt: NOW - 40 * M, answer: "Because the LR schedule ends at **0** after epoch 3.\n\n- fix: cosine to 1e-5", answeredAt: NOW - 30 * M, readAt: null },
  { id: "a1", session: "s_t", sessionName: "trainer", agent: "claude", from: "you", question: "is the data loader the bottleneck?", askedAt: NOW - 300 * M, answer: "No: GPU util is 97%.", answeredAt: NOW - 290 * M, readAt: NOW - 200 * M }
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const rows = () => [...document.querySelectorAll(".ans-row")] as HTMLElement[];
const reader = () => document.querySelector(".ans-reader") as HTMLElement;
const page = (extra: Partial<Parameters<typeof AnswersPage>[0]> = {}) => render(
  <AnswersPage placement="page" sessions={sessions} scope={null} onScope={() => {}} initial={answers} now={NOW} narrow={false}
               onClose={() => {}} onOpenSession={() => {}} {...extra} />
);

describe("AnswersPage", () => {
  it("keeps your questions and the turns agents started on two tabs, each with its unread count", () => {
    page();
    expect(screen.getByRole("tab", { name: "From you 2" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "From agents 1" })).toBeTruthy();
    // Unread first; a kept answer with no "from" is yours.
    expect(rows().map((r) => within(r).getByText(/\?$/).textContent)).toEqual(["what was the final AUC?", "why is the validation loss flat?"]);
    fireEvent.click(screen.getByRole("tab", { name: "From agents 1" }));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]).getByText("check-back · coordinator")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(rows()).toHaveLength(2);
    // hop's sender line is not part of the preview; the sender is the row's tag.
    expect(within(rows()[1]).getByText("plotter")).toBeTruthy();
    expect(within(rows()[1]).getByText("the plot moved")).toBeTruthy();
  });

  it("reads like mail: the list on the left, the one you pick on the right, read once opened", () => {
    const changed = vi.fn();
    page({ onChanged: changed });
    // The first is on show, not yet read.
    expect(within(reader()).getByText("what was the final AUC?")).toBeTruthy();
    expect(within(reader()).getByText("You asked")).toBeTruthy();
    fireEvent.click(rows()[1]);
    expect(within(reader()).getByText("0").tagName).toBe("STRONG");
    expect(reader().querySelectorAll("li").length).toBe(1);
    expect(changed).toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "From you 1" })).toBeTruthy();
    // Read, it stays in the unread list while you read it.
    expect(rows()).toHaveLength(2);
    expect(rows()[1].getAttribute("aria-current")).toBe("true");
    // An agent's turn says who started it.
    fireEvent.click(screen.getByRole("tab", { name: "From agents 1" }));
    fireEvent.click(rows()[0]);
    expect(within(reader()).getByText("Check-back set by coordinator")).toBeTruthy();
  });

  it("moves through the list with the arrow keys, and opens the session from the reading pane", () => {
    const open = vi.fn();
    page({ onOpenSession: open });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(within(reader()).getByText("why is the validation loss flat?")).toBeTruthy();
    fireEvent.click(within(reader()).getByRole("button", { name: "Open session" }));
    expect(open).toHaveBeenCalledWith("s_t");
  });

  it("marks a whole tab read at once", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(screen.getByRole("tab", { name: "From you" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "From agents 1" })).toBeTruthy();
  });

  it("narrow: the list, then one at a time with a way back", () => {
    page({ narrow: true });
    expect(document.querySelector(".ans-reader")).toBeNull();
    fireEvent.click(rows()[0]);
    expect(within(reader()).getByText("what was the final AUC?")).toBeTruthy();
    expect(document.querySelector(".ans-inbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "‹ Your questions" }));
    expect(rows()).toHaveLength(2);
  });

  it("from a session's header: only that session's turns, and a way out to all", () => {
    const onScope = vi.fn();
    page({ placement: "sheet", scope: "s_t", onScope });
    expect(document.querySelector(".ans-scope strong")?.textContent).toBe("trainer");
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText("what was the final AUC?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Every session's answers" }));
    expect(onScope).toHaveBeenCalledWith(null);
  });

  it("empty: says what will appear on each tab", () => {
    page({ initial: [] });
    expect(screen.getByText("No answers yet.")).toBeTruthy();
    expect(screen.getByText(/stays here until you've read it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "From agents" }));
    expect(screen.getByText("Nothing from agents yet.")).toBeTruthy();
  });
});
