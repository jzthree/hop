import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueCard, normalizeQueued } from "../src/components/QueueCard";
import { isQueueChord, isFullscreenChord } from "../src/utils/fullscreenChord";

afterEach(() => cleanup());

const props = () => ({
  agentLabel: "Claude",
  onSendNow: vi.fn(), onEdit: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onCollapse: vi.fn()
});

describe("QueueCard", () => {
  it("says who each message is from and that it goes when the turn ends; Send now, Edit, Cancel act on it", () => {
    const p = props();
    render(<QueueCard {...p} items={[{ id: "a", from: "ceo", message: "status? one line" }, { id: "b", message: "run both mixes" }]} />);
    expect(screen.getByText("2 messages queued")).toBeTruthy();
    expect(screen.getByText("from ceo")).toBeTruthy();
    expect(screen.getByText("from you")).toBeTruthy();
    expect(screen.getAllByText("sends when Claude's turn ends")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Send now" })[0]);
    expect(p.onSendNow).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel this message" })[1]);
    expect(p.onCancel).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.value).toBe("status? one line");
    fireEvent.change(box, { target: { value: "status? two lines" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(p.onEdit).toHaveBeenCalledWith("a", "status? two lines");
  });

  it("trouble reads as trouble: a failed one offers Try again; one typing joined offers only Dismiss", () => {
    const p = props();
    render(<QueueCard {...p} items={[
      { id: "f", message: "x", failed: true, note: "it didn't submit and is still in the input box" },
      { id: "m", message: "y", paused: "mixed" }
    ]} />);
    expect(screen.getByText("it didn't submit and is still in the input box")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.onRetry).toHaveBeenCalledWith("f");
    expect(screen.getByText(/typing joined it in the input box/)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Send now" })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(p.onCancel).toHaveBeenCalledWith("m");
  });
});

describe("the queue's data and key", () => {
  it("keeps well-formed queued messages from the session list, nothing else", () => {
    expect(normalizeQueued(undefined)).toBeUndefined();
    expect(normalizeQueued([])).toBeUndefined();
    expect(normalizeQueued([{ id: "a", message: "hi", from: "ceo", note: 3 }, { nope: true }])).toEqual([
      { id: "a", message: "hi", from: "ceo", createdAt: undefined, note: undefined, paused: undefined, failed: undefined, sending: undefined }
    ]);
  });

  it("⌘⌥⏎ (Ctrl+Alt+⏎ elsewhere) queues; ⌘⏎ stays full screen, ⌘⇧⏎ the pane zoom", () => {
    const k = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
      ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
    expect(isQueueChord(k({ metaKey: true, altKey: true }), true)).toBe(true);
    expect(isQueueChord(k({ ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(isQueueChord(k({ altKey: true }), true)).toBe(false);
    expect(isQueueChord(k({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isQueueChord(k({ metaKey: true }), true)).toBe(false);
    expect(isFullscreenChord(k({ metaKey: true, altKey: true }), true)).toBe(false);
  });
});
