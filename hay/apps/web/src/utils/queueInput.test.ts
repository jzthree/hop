import { describe, expect, it, vi } from "vitest";
import { queueTypedInput, tabQueues } from "./queueInput";

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
