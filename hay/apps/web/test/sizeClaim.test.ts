import { describe, expect, it } from "vitest";
import { claimOnAttach, claimOnClick, claimOnTileFocus, isPlainClick, sizeIsForeign } from "../src/utils/sizeClaim";

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

describe("claimOnTileFocus — a tile you engaged fits itself, a tile the wall pre-focused does not", () => {
  const natural = { cols: 90, rows: 28 };
  it("claims when a click lands on a tile wearing a full-screen size", () => {
    expect(claimOnTileFocus({ deliberate: true, natural, current: { cols: 180, rows: 48 } })).toBe(true);
  });
  it("stays quiet when the session already fits, within rounding", () => {
    expect(claimOnTileFocus({ deliberate: true, natural, current: { cols: 88, rows: 30 } })).toBe(false);
    expect(claimOnTileFocus({ deliberate: true, natural, current: natural })).toBe(false);
  });
  it("never claims for the wall's own pre-focus of the current session", () => {
    expect(claimOnTileFocus({ deliberate: false, natural, current: { cols: 180, rows: 48 } })).toBe(false);
  });
  it("needs a measurable tile and refuses a degenerate fit", () => {
    expect(claimOnTileFocus({ deliberate: true, natural: null, current: { cols: 180, rows: 48 } })).toBe(false);
    expect(claimOnTileFocus({ deliberate: true, natural: { cols: 12, rows: 3 }, current: { cols: 180, rows: 48 } })).toBe(false);
  });
  it("sizeIsForeign is the same tolerance the ⤢ badge uses", () => {
    expect(sizeIsForeign({ cols: 93, rows: 30 }, natural)).toBe(false);
    expect(sizeIsForeign({ cols: 120, rows: 28 }, natural)).toBe(true);
    expect(sizeIsForeign({ cols: 90, rows: 40 }, natural)).toBe(true);
  });
});
