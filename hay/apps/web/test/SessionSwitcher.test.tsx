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

describe("SessionSwitcher tile zoom", () => {
  it("steps the zoom ladder with +/− and persists the level", () => {
    render(<SessionSwitcher {...props} open />);
    const dialog = screen.getByRole("dialog", { name: "Sessions" });
    // Default level (old M): 150px min tiles.
    expect(dialog.style.getPropertyValue("--tile-min")).toBe("150px");

    fireEvent.click(screen.getByRole("button", { name: "Bigger tiles" }));
    expect(dialog.style.getPropertyValue("--tile-min")).toBe("210px");
    expect(localStorage.getItem("hay_tile_zoom")).toBe("3");

    fireEvent.click(screen.getByRole("button", { name: "Smaller tiles" }));
    fireEvent.click(screen.getByRole("button", { name: "Smaller tiles" }));
    expect(dialog.style.getPropertyValue("--tile-min")).toBe("120px");
    expect(localStorage.getItem("hay_tile_zoom")).toBe("1");
  });

  it("migrates a legacy hay_tile_size value onto the ladder", () => {
    localStorage.setItem("hay_tile_size", "xl");
    render(<SessionSwitcher {...props} open />);
    const dialog = screen.getByRole("dialog", { name: "Sessions" });
    expect(dialog.style.getPropertyValue("--tile-min")).toBe("420px");
  });

  it("announces interactive tiles above the threshold when a ws base exists", () => {
    localStorage.setItem("hay_tile_zoom", "5");
    render(<SessionSwitcher {...props} open tileWsBase="ws://x" />);
    expect(screen.getByText("⌨ interactive")).toBeTruthy();
  });

  it("keeps preview tiles for filter matches", () => {
    render(<SessionSwitcher {...props} open />);
    // Type-anywhere filtering: stray printables land in the filter.
    fireEvent.keyDown(window, { key: "r" });
    const card = screen.getByText("research").closest(".switcher-card");
    expect(card).toBeTruthy();
    expect(card!.querySelector(".switcher-preview")).toBeTruthy();
  });
});

describe("SessionSwitcher project view density", () => {
  it("toggles between sectional and compact project views", () => {
    const withCwd: SwitcherSession[] = [
      { name: "alpha-work", displayName: "alpha-work", internalName: "alpha-work", active: true, starting: false, createdBy: "user", cwd: "/Users/x/Code/alpha" },
      { name: "beta-work", displayName: "beta-work", internalName: "beta-work", active: true, starting: false, createdBy: "user", cwd: "/Users/x/Code/beta" }
    ];
    render(<SessionSwitcher {...props} sessions={withCwd} open />);
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    // Sectional (default): one header per project.
    expect(screen.getByText("~/Code/alpha")).toBeTruthy();
    expect(screen.getByText("~/Code/beta")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    // Headers gone, both cards still present, choice persisted.
    expect(document.querySelector(".switcher-group-label")).toBeNull();
    expect(screen.getByText("alpha-work")).toBeTruthy();
    expect(screen.getByText("beta-work")).toBeTruthy();
    expect(localStorage.getItem("hay_project_compact")).toBe("1");
  });
});

describe("SessionSwitcher frozen ordering", () => {
  const at = (n: string, lastActivityAt: number): SwitcherSession => ({
    name: n, displayName: n, internalName: n, active: true, starting: false,
    createdBy: "user", lastActivityAt
  });

  it("keeps the order captured at open while activity reshuffles underneath", () => {
    const view = render(<SessionSwitcher {...props} sessions={[at("alpha", 2000), at("beta", 1000)]} open />);
    const names = () =>
      Array.from(document.querySelectorAll(".switcher-card-name")).map((n) => n.textContent);
    expect(names()).toEqual(["alpha", "beta"]);

    // beta becomes the most recent — a live rebuild would put it first.
    view.rerender(<SessionSwitcher {...props} sessions={[at("alpha", 2000), at("beta", 99000)]} open />);
    expect(names()).toEqual(["alpha", "beta"]);

    // A brand-new session appends at the end instead of reshuffling.
    view.rerender(
      <SessionSwitcher {...props} sessions={[at("alpha", 2000), at("beta", 99000), at("gamma", 500000)]} open />
    );
    expect(names()).toEqual(["alpha", "beta", "gamma"]);

    // Reopen recaptures: now the live recency order shows.
    view.rerender(<SessionSwitcher {...props} sessions={[at("alpha", 2000), at("beta", 99000), at("gamma", 500000)]} open={false} />);
    view.rerender(<SessionSwitcher {...props} sessions={[at("alpha", 2000), at("beta", 99000), at("gamma", 500000)]} open />);
    expect(names()).toEqual(["gamma", "beta", "alpha"]);
  });
});

describe("SessionSwitcher focus capture", () => {
  it("blurs the opener on open so typed search can't leak into the terminal", () => {
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    render(<SessionSwitcher {...props} open />);
    expect(document.activeElement).not.toBe(outside);
    outside.remove();
  });
});

describe("SessionSwitcher manual drag", () => {
  it("reorders live as the drag passes over other tiles, before any drop", () => {
    const three: SwitcherSession[] = ["one", "two", "three"].map((n) => ({
      name: n, displayName: n, internalName: n, active: true, starting: false, createdBy: "user" as const
    }));
    render(<SessionSwitcher {...props} sessions={three} open />);
    fireEvent.click(screen.getByRole("button", { name: "Manual" }));
    const names = () =>
      Array.from(document.querySelectorAll(".switcher-card-name")).map((n) => n.textContent);
    expect(names()).toEqual(["one", "two", "three"]);

    const source = screen.getByText("one").closest(".switcher-card")!;
    const target = screen.getByText("three").closest(".switcher-card")!;
    fireEvent.dragStart(source, { dataTransfer: { effectAllowed: "" } });
    fireEvent.dragEnter(target);

    // The grid reflowed during the drag — no drop needed.
    expect(names()).toEqual(["two", "three", "one"]);
    expect(JSON.parse(localStorage.getItem("hay_manual_order_v1")!)).toEqual(["two", "three", "one"]);
  });
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
