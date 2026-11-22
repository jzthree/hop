import { describe, expect, it, vi } from "vitest";
import { footSaysWorking, queueTypedInput, tabQueues, terminalSaysWorking } from "./queueInput";

const tab = { key: "Tab" };

describe("Tab queues in Claude and Antigravity while they work", () => {
  it("is a bare Tab, in a working Claude or Antigravity session only", () => {
    expect(tabQueues(tab, "claude", true)).toBe(true);
    expect(tabQueues(tab, "antigravity", true)).toBe(true);
    // Codex queues on Tab itself; an idle agent keeps its own Tab (completion).
    expect(tabQueues(tab, "codex", true)).toBe(false);
    expect(tabQueues(tab, "claude", false)).toBe(false);
    expect(tabQueues(tab, null, true)).toBe(false);
    expect(tabQueues({ key: "Tab", shiftKey: true }, "claude", true)).toBe(false);
    expect(tabQueues({ key: "Tab", isComposing: true }, "claude", true)).toBe(false);
    expect(tabQueues({ key: "a" }, "claude", true)).toBe(false);
  });

  it("asks hop to queue the box, Tab-style, and says what happened", async () => {
    const notice = vi.fn();
    const reply = (status: number, body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    let f = reply(200, { ok: true, status: "queued" });
    expect(await queueTypedInput("room", { viaTab: true, notice, fetchImpl: f })).toBe("queued");
    expect(JSON.parse((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].body as string)).toEqual({ name: "room", key: "tab" });
    expect(notice).toHaveBeenLastCalledWith("Queued: it goes when this turn ends");
    notice.mockClear();
    f = reply(200, { ok: true, status: "passed" });
    expect(await queueTypedInput("room", { viaTab: true, notice, fetchImpl: f })).toBe("passed");
    expect(notice).not.toHaveBeenCalled();
    f = reply(409, { error: "A pasted block or image can't be moved out of the input box." });
    expect(await queueTypedInput("room", { notice, fetchImpl: f })).toBeNull();
    expect(notice).toHaveBeenLastCalledWith("A pasted block or image can't be moved out of the input box.");
  });
});

describe("a turn in flight, by the foot of the terminal", () => {
  const claudeBusy = ["⏺ Reading the log", "✶ Flummoxing… (8m 21s)", "────", "❯ later please", "────", "⏵⏵ bypass permissions on", " (shift+tab to cycle) · esc to interrupt · ← 1 agent", "", ""];
  const claudeIdle = ["  the footer said esc to interrupt back then", "────", "❯ later please", "────", "⏵⏵ bypass permissions on", " (shift+tab to cycle)", ""];
  const agyBusy = ["> earlier prompt", "⣾  Thinking...", "────", "> later please", "────", "? for shortcuts", "auto"];
  const agyIdle = ["Press Shift+Tab to switch agent modes.", "esc to dismiss", "────", ">", "────", "? for shortcuts", "auto"];

  it("reads Claude's footer and agy's spinner, not the conversation above", () => {
    expect(footSaysWorking(claudeBusy)).toBe(true);
    expect(footSaysWorking(claudeIdle)).toBe(false);
    expect(footSaysWorking(agyBusy)).toBe(true);
    expect(footSaysWorking(agyIdle)).toBe(false);
    expect(footSaysWorking([])).toBe(false);
  });

  it("asks the screen only for a Tab, and only when the list does not already say working", () => {
    const screen = vi.fn(() => true);
    expect(tabQueues(tab, "claude", screen)).toBe(true);
    expect(tabQueues({ key: "a" }, "claude", screen)).toBe(false);
    expect(tabQueues(tab, "codex", screen)).toBe(false);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(tabQueues(tab, "claude", () => false)).toBe(false);
  });

  it("reads what an xterm terminal shows", () => {
    const term = (lines: string[]) => ({ rows: lines.length, buffer: { active: { baseY: 0, getLine: (i: number) => ({ translateToString: () => lines[i] }) } } });
    expect(terminalSaysWorking(term(claudeBusy))).toBe(true);
    expect(terminalSaysWorking(term(claudeIdle))).toBe(false);
    expect(terminalSaysWorking(null)).toBe(false);
  });
});
