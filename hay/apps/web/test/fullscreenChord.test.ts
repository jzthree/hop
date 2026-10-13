import { describe, expect, it } from "vitest";
import { isAppCtrlEnter, isFullscreenChord } from "../src/utils/fullscreenChord";

const key = (mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>, k = "Enter") =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("full-screen chord", () => {
  it("on a Mac only ⌘⏎ toggles; Ctrl⏎ is the app's", () => {
    expect(isFullscreenChord(key({ metaKey: true }), true)).toBe(true);
    expect(isFullscreenChord(key({ ctrlKey: true }), true)).toBe(false);
    expect(isAppCtrlEnter(key({ ctrlKey: true }), true)).toBe(true);
  });
  it("without ⌘ (Windows/Linux) Ctrl⏎ still toggles", () => {
    expect(isFullscreenChord(key({ ctrlKey: true }), false)).toBe(true);
    expect(isAppCtrlEnter(key({ ctrlKey: true }), false)).toBe(false);
  });
  it("other chords are untouched", () => {
    expect(isFullscreenChord(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isFullscreenChord(key({}), true)).toBe(false);
    expect(isAppCtrlEnter(key({ ctrlKey: true }, "a"), true)).toBe(false);
  });
});
