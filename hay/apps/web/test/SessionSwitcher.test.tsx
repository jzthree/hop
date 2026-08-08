import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSwitcher, terminalMayTakeFocus } from "../src/components/SessionSwitcher";
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
  // The wall persists filter/focus/scroll in sessionStorage so a REFRESH
  // keeps your view. Tests share one jsdom, so a filter typed in one case
  // would restore into the next and silently empty the wall.
  sessionStorage.clear();
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

describe("SessionSwitcher parked sessions", () => {
  it("moves parked sessions off the wall into a collapsible section", () => {
    const mixed: SwitcherSession[] = [
      { name: "active-one", displayName: "active-one", internalName: "active-one", active: true, starting: false, createdBy: "user" },
      { name: "napping", displayName: "napping", internalName: "napping", active: true, starting: false, createdBy: "user", parked: true }
    ];
    render(<SessionSwitcher {...props} sessions={mixed} open />);
    // Not on the wall…
    expect(document.querySelector(".switcher-grid")?.textContent).not.toContain("napping");
    // …but one toggle away, with its state chip.
    fireEvent.click(screen.getByRole("button", { name: /parked · 1/ }));
    const row = screen.getByText("napping").closest(".switcher-row")!;
    expect(row.textContent).toContain("PARKED");
  });

  it("still finds parked sessions through the filter", () => {
    const mixed: SwitcherSession[] = [
      { name: "active-one", displayName: "active-one", internalName: "active-one", active: true, starting: false, createdBy: "user" },
      { name: "napping", displayName: "napping", internalName: "napping", active: true, starting: false, createdBy: "user", parked: true }
    ];
    render(<SessionSwitcher {...props} sessions={mixed} open />);
    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByText("napping")).toBeTruthy();
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

describe("SessionSwitcher manual drag", () => {
  it("reorders live as the drag passes over other tiles, before any drop", () => {
    const three: SwitcherSession[] = ["one", "two", "three"].map((n) => ({
      name: n, displayName: n, internalName: n, active: true, starting: false, createdBy: "user" as const
    }));
    render(<SessionSwitcher {...props} sessions={three} open />);
    fireEvent.click(screen.getByRole("button", { name: "Manual" }));
    const names = () =>
      Array.from(document.querySelectorAll(".switcher-card-name")).map((n) => n.textContent);
    // Nothing dragged yet, so all three are "unplaced" and sit in the stable
    // alphabetical tail — manual order never ranks by activity.
    expect(names()).toEqual(["one", "three", "two"]);

    const source = screen.getByText("one").closest(".switcher-card")!;
    const target = screen.getByText("three").closest(".switcher-card")!;
    fireEvent.dragStart(source, { dataTransfer: { effectAllowed: "" } });
    fireEvent.dragEnter(target);

    // The grid reflowed during the drag — no drop needed. "one" lands where
    // "three" sat in the pre-drag order (one, three, two).
    expect(names()).toEqual(["three", "one", "two"]);
    expect(JSON.parse(localStorage.getItem("hay_manual_order_v1")!)).toEqual(["three", "one", "two"]);
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

// The focus rules, pinned. Focus stealing has been the single most-repeated
// regression in this UI, and every previous fix blocked one KNOWN thief —
// an open set, so each rewrite minted a new one. The rule under test is the
// closed version: a terminal may not take focus away from a text input, no
// matter which code path asks (mount, remount, reconnect, poll, repaint).
describe("focus rules", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("refuses to steal focus from the filter box or any text input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(terminalMayTakeFocus()).toBe(false);

    const area = document.createElement("textarea");
    document.body.appendChild(area);
    area.focus();
    expect(terminalMayTakeFocus()).toBe(false);
  });

  it("allows focus when nothing owns the keyboard", () => {
    expect(terminalMayTakeFocus()).toBe(true);
  });

  it("allows a live tile to keep focus while it already has it", () => {
    const tile = document.createElement("div");
    tile.className = "switcher-live-tile";
    const inner = document.createElement("div");
    inner.tabIndex = 0;
    tile.appendChild(inner);
    document.body.appendChild(tile);
    inner.focus();
    expect(terminalMayTakeFocus()).toBe(true);
  });

  it("typing in the filter drops the live tile so a remount cannot grab the cursor", () => {
    render(<SessionSwitcher {...props} open tileWsBase="ws://x" />);
    const filter = document.querySelector(".switcher-filter input") as HTMLInputElement
      || document.querySelector("input") as HTMLInputElement;
    filter.focus();
    fireEvent.change(filter, { target: { value: "res" } });
    expect(document.activeElement).toBe(filter);
    expect(document.querySelectorAll(".switcher-live-tile.is-live").length).toBe(0);
  });
});

describe("context menus", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("right-clicking the wall offers create + view actions, not session actions", () => {
    render(<SessionSwitcher {...props} open />);
    const scroll = document.querySelector(".switcher-scroll")!;
    fireEvent.contextMenu(scroll, { clientX: 40, clientY: 40 });
    const labels = Array.from(document.querySelectorAll(".context-menu-item")).map((b) => b.textContent);
    expect(labels.some((l) => l?.includes("New session"))).toBe(true);
    expect(labels.some((l) => l?.includes("Group by project"))).toBe(true);
    // Session-specific verbs belong to a card's menu, never the background.
    expect(labels.some((l) => l?.includes("Rename"))).toBe(false);
  });

  it("a right-click on a card does not open the wall menu", () => {
    render(<SessionSwitcher {...props} open />);
    const card = document.querySelector(".switcher-card")!;
    fireEvent.contextMenu(card, { clientX: 10, clientY: 10 });
    const labels = Array.from(document.querySelectorAll(".context-menu-item")).map((b) => b.textContent);
    expect(labels.some((l) => l?.includes("New session"))).toBe(false);
  });

  it("Escape closes the menu", () => {
    render(<SessionSwitcher {...props} open />);
    fireEvent.contextMenu(document.querySelector(".switcher-scroll")!, { clientX: 30, clientY: 30 });
    expect(document.querySelector(".context-menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".context-menu")).toBeNull();
  });
});

describe("manual folders in the wall", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  const folders = [{ id: "f1", name: "Filed" }];
  const withFolder: SwitcherSession[] = [
    { name: "inside", displayName: "inside", internalName: "inside", active: true, starting: false, createdBy: "user", folderId: "f1" },
    { name: "outside", displayName: "outside", internalName: "outside", active: true, starting: false, createdBy: "user" }
  ];

  it("a filter matching only a foldered session shows it, not an empty wall", () => {
    render(<SessionSwitcher {...props} sessions={withFolder} folders={folders} open />);
    fireEvent.click(screen.getByRole("button", { name: "Manual" }));
    const input = document.querySelector(".switcher-top input") as HTMLInputElement
      || document.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "insid" } });
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.getByText("inside")).toBeTruthy();
    expect(screen.getByText("Filed")).toBeTruthy();
  });

  it("a query in manual mode still offers the full-history search", () => {
    // Manual keeps its own render branch under a query (narrow-in-place), so
    // the search tail — content hits + the deep button — must ride along or
    // manual-mode users never see anything past the name tier.
    render(<SessionSwitcher {...props} sessions={withFolder} folders={folders} open />);
    fireEvent.click(screen.getByRole("button", { name: "Manual" }));
    const input = document.querySelector(".switcher-top input") as HTMLInputElement
      || document.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "outsid" } });
    expect(screen.getByRole("button", { name: /Search full history for/ })).toBeTruthy();
  });
});
