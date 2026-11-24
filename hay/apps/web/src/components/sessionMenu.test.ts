import { afterEach, describe, expect, it } from "vitest";
import { sessionMenuItems } from "./sessionMenu";
import { inMacApp, newPlace } from "../utils/nativeApp";

// hop's Mac app opens a hop page asked for "a new tab" in a new hop window:
// there are no tabs there to name.
const deps = {
  ctx: { notice: () => {}, refresh: () => {} },
  folders: [],
  homes: { claude: [], codex: [] },
  isCurrent: () => false,
  onOpen: () => {},
  onStartRename: () => {}
};
const labels = () => sessionMenuItems({ name: "s1", displayName: "s1", type: "terminal" } as never, deps as never)
  .map((i) => ("label" in i ? i.label : null)).filter(Boolean);

describe("opening a session elsewhere", () => {
  afterEach(() => { delete (window as { hopNative?: unknown }).hopNative; });

  it("is a new tab in a browser", () => {
    expect(inMacApp()).toBe(false);
    expect(newPlace()).toBe("new tab");
    expect(labels()).toContain("Open in new tab");
  });

  it("is a new window in the Mac app", () => {
    (window as { hopNative?: unknown }).hopNative = { platform: "mac", version: "1" };
    expect(inMacApp()).toBe(true);
    expect(labels()).toContain("Open in new window");
    expect(labels()).not.toContain("Open in new tab");
  });
});
