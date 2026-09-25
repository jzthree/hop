import { describe, expect, it } from "vitest";
import { claimOnAttach, claimOnClick, isPlainClick } from "../src/utils/sizeClaim";

describe("claimOnAttach — only a deliberate open takes the size", () => {
  const base = { viewMode: "fit" as const, visible: true, deliberate: true };
  it("claims when the human opened this session here", () => {
    expect(claimOnAttach(base)).toBe(true);
  });
  it("does not claim on a reconnect, in a hidden tab, or in Manual mode", () => {
    expect(claimOnAttach({ ...base, deliberate: false })).toBe(false);
    expect(claimOnAttach({ ...base, visible: false })).toBe(false);
    expect(claimOnAttach({ ...base, viewMode: "full" })).toBe(false);
  });
});

describe("claimOnClick — a click takes the size only when it changes something", () => {
  const natural = { cols: 171, rows: 40 };
  it("claims when someone else holds the size", () => {
    expect(claimOnClick({ viewMode: "fit", natural, active: { cols: 56, rows: 32 }, owned: false })).toBe(true);
  });
  it("claims when we own a size that is no longer our fit", () => {
    expect(claimOnClick({ viewMode: "fit", natural, active: { cols: 132, rows: 34 }, owned: true })).toBe(true);
  });
  it("stays quiet when the session is already at this viewport's fit", () => {
    expect(claimOnClick({ viewMode: "fit", natural, active: { ...natural }, owned: true })).toBe(false);
  });
  it("never claims in Manual mode or before the terminal can be measured", () => {
    expect(claimOnClick({ viewMode: "full", natural, active: null, owned: false })).toBe(false);
    expect(claimOnClick({ viewMode: "fit", natural: null, active: null, owned: false })).toBe(false);
  });
});

describe("isPlainClick — the release of a drag is not a click", () => {
  it("a press and release in the same place, nothing selected, is a click", () => {
    expect(isPlainClick({ x: 100, y: 100 }, { x: 102, y: 101 }, false)).toBe(true);
    expect(isPlainClick(null, { x: 5, y: 5 }, false)).toBe(true);
  });
  it("a drag, or any release with a selection standing, is not", () => {
    expect(isPlainClick({ x: 100, y: 100 }, { x: 260, y: 100 }, false)).toBe(false);
    expect(isPlainClick({ x: 100, y: 100 }, { x: 100, y: 100 }, true)).toBe(false);
  });
});
