import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueueCard, normalizeQueued } from "./QueueCard";

const noop = () => {};
const show = (q: Record<string, unknown>) => {
  const items = normalizeQueued([{ id: "q1", message: "Root has fetched the JSON", createdAt: 1, ...q }])!;
  render(<QueueCard items={items} agentLabel="Antigravity" onSendNow={noop} onEdit={noop} onCancel={noop} onRetry={noop} onCollapse={noop} />);
};

describe("a queued message's state line", () => {
  it("held: says it is on hold, not the error from when it last tried", () => {
    // Held at a restart days ago; its last error ("input box isn't on screen") is stale.
    show({ paused: "held", note: "waiting: the agent's input box isn't on screen" });
    expect(screen.getByText(/on hold — it will not send by itself/)).toBeTruthy();
    expect(screen.queryByText(/input box isn't on screen/)).toBeNull();
    expect(screen.getByRole("button", { name: /Send now/ })).toBeTruthy();
  });

  it("waiting normally: sends when the turn ends", () => {
    show({});
    expect(screen.getByText(/sends when Antigravity's turn ends/)).toBeTruthy();
  });
});
