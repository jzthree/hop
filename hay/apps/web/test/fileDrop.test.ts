import { describe, expect, it } from "vitest";
import { originalPathHint } from "../src/utils/fileDrop";

describe("originalPathHint", () => {
  it("names ⌘⌥C and Finder on Apple platforms", () => {
    expect(originalPathHint("MacIntel Mozilla/5.0 (Macintosh…)")).toContain("⌘⌥C");
    expect(originalPathHint("MacIntel …")).toContain("Finder");
    expect(originalPathHint("iPhone Safari")).toContain("⌘⌥C");
  });

  it("names Ctrl+Shift+C and Explorer on Windows", () => {
    const hint = originalPathHint("Win32 Mozilla/5.0 (Windows NT 10.0)");
    expect(hint).toContain("Ctrl+Shift+C");
    expect(hint).toContain("Explorer");
  });

  it("falls back to a generic file-manager hint elsewhere", () => {
    const hint = originalPathHint("Linux x86_64");
    expect(hint).toContain("file manager");
    expect(hint).not.toContain("⌘⌥C");
  });
});
