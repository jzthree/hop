import { describe, expect, it } from "vitest";
import { tabTitle } from "../src/utils/tabTitle";

describe("tab title", () => {
  it("names the session first and the app second", () => {
    expect(tabTitle("angler", false)).toBe("angler · hop");
  });
  it("is just the app on the hub, never a placeholder room id", () => {
    expect(tabTitle(null, false)).toBe("hop");
    expect(tabTitle("", false)).toBe("hop");
  });
  it("marks attention with a leading dot", () => {
    expect(tabTitle("angler", true)).toBe("● angler · hop");
    expect(tabTitle(null, true)).toBe("● hop");
  });
});
