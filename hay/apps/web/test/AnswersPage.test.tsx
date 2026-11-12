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
  { id: "a3", session: "s_e", sessionName: "eval", agent: "codex", question: "what was the final AUC?", askedAt: NOW - 6 * M, answer: "0.812, up from 0.794.", answeredAt: NOW - 5 * M, readAt: null },
  { id: "a2", session: "s_t", sessionName: "trainer", agent: "claude", question: "why is the validation loss flat?", askedAt: NOW - 40 * M, answer: "Because the LR schedule ends at **0** after epoch 3.\n\n- fix: cosine to 1e-5", answeredAt: NOW - 30 * M, readAt: null },
  { id: "a1", session: "s_t", sessionName: "trainer", agent: "claude", question: "is the data loader the bottleneck?", askedAt: NOW - 300 * M, answer: "No: GPU util is 97%.", answeredAt: NOW - 290 * M, readAt: NOW - 200 * M }
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const cardsShown = () => [...document.querySelectorAll(".ans-card")] as HTMLElement[];

describe("AnswersPage", () => {
  it("shows unread answers first, each with your question and the reply drawn as prose", () => {
    render(<AnswersPage placement="page" sessions={sessions} scope={null} onScope={() => {}} initial={answers} now={NOW} onClose={() => {}} onOpenSession={() => {}} />);
    const cards = cardsShown();
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("what was the final AUC?")).toBeTruthy();
    expect(within(cards[0]).getByText("answered 5 min ago")).toBeTruthy();
    expect(within(cards[1]).getByText("0").tagName).toBe("STRONG");
    expect(cards[1].querySelectorAll("li").length).toBe(1);
    expect(screen.getByRole("tab", { name: "Unread 2" }).getAttribute("aria-selected")).toBe("true");
    // Every answer kept, read ones too.
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(cardsShown()).toHaveLength(3);
  });

  it("marks read one at a time or all at once, and opening a session marks it read", () => {
    const changed = vi.fn();
    const open = vi.fn();
    render(<AnswersPage placement="page" sessions={sessions} scope={null} onScope={() => {}} initial={answers} now={NOW} onClose={() => {}} onOpenSession={open} onChanged={changed} />);
    fireEvent.click(within(cardsShown()[0]).getByRole("button", { name: "Mark read" }));
    expect(screen.getByRole("tab", { name: "Unread 1" })).toBeTruthy();
    expect(changed).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(open).toHaveBeenCalledWith("s_t");
    expect(screen.getByText("Nothing unread.")).toBeTruthy();
  });

  it("from a session's header: only that session's answers, and a way out to all", () => {
    const onScope = vi.fn();
    render(<AnswersPage placement="sheet" sessions={sessions} scope="s_t" onScope={onScope} initial={answers} now={NOW} onClose={() => {}} onOpenSession={() => {}} />);
    expect(screen.getByText("trainer").closest(".ans-scope")).toBeTruthy();
    expect(cardsShown()).toHaveLength(1);
    expect(screen.queryByText("what was the final AUC?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Every session's answers" }));
    expect(onScope).toHaveBeenCalledWith(null);
  });

  it("empty: says what will appear and that it stays until read", () => {
    render(<AnswersPage placement="page" sessions={sessions} scope={null} onScope={() => {}} initial={[]} now={NOW} onClose={() => {}} onOpenSession={() => {}} />);
    expect(screen.getByText("No answers yet.")).toBeTruthy();
    expect(screen.getByText(/stays here until you've read it/)).toBeTruthy();
  });
});
