import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSwitcher } from "../src/components/SessionSwitcher";
import type { SwitcherSession } from "../src/utils/switcherModel";

const sessions: SwitcherSession[] = [
  {
    name: "research",
    displayName: "research",
    internalName: "research",
    active: true,
    starting: false,
    createdBy: "user"
  },
  {
    name: "worker-review",
    displayName: "worker-review",
    internalName: "worker-review",
    active: true,
    starting: false,
    createdBy: "agent"
  }
];

const props = {
  sessions,
  currentRoom: null,
  onClose: vi.fn(),
  onSwitch: vi.fn(),
  onRefresh: vi.fn(),
  onNotice: vi.fn()
};

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear()
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

describe("SessionSwitcher origin scope", () => {
  it("starts with user sessions and switches cleanly between Agent and All", () => {
    render(<SessionSwitcher {...props} open />);

    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.queryByText("worker-review")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.queryByText("research")).toBeNull();
    expect(screen.getByText("worker-review")).toBeTruthy();
    expect(screen.queryByText("New session")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.getByText("worker-review")).toBeTruthy();
    expect(screen.getByText("AGENT")).toBeTruthy();
  });

  it("resets to user sessions each time it opens", () => {
    const view = render(<SessionSwitcher {...props} open />);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByText("worker-review")).toBeTruthy();

    view.rerender(<SessionSwitcher {...props} open={false} />);
    view.rerender(<SessionSwitcher {...props} open />);

    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.queryByText("worker-review")).toBeNull();
  });
});
