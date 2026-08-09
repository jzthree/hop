import { describe, expect, it } from "vitest";
import { originalPathHint, pasteableUploadPaths, shellQuotePath } from "../src/utils/fileDrop";

describe("shellQuotePath", () => {
  it("leaves an ordinary path bare", () => {
    expect(shellQuotePath("/Users/me/.hop2/uploads/room/shot.png")).toBe("/Users/me/.hop2/uploads/room/shot.png");
  });

  it("quotes a path containing spaces", () => {
    expect(shellQuotePath("/tmp/my file.txt")).toBe("'/tmp/my file.txt'");
  });

  it("survives an apostrophe in the filename", () => {
    // The classic shell-quoting trap: 'it's' must close, escape, reopen.
    expect(shellQuotePath("/tmp/it's here.txt")).toBe(`'/tmp/it'\\''s here.txt'`);
  });

  it("quotes shell metacharacters that would otherwise execute", () => {
    expect(shellQuotePath("/tmp/$(whoami).txt")).toBe("'/tmp/$(whoami).txt'");
    expect(shellQuotePath("/tmp/a;rm -rf b")).toBe("'/tmp/a;rm -rf b'");
  });

  it("joins several uploads into one argument list", () => {
    expect(pasteableUploadPaths(["/tmp/a.png", "/tmp/b c.png"])).toBe("/tmp/a.png '/tmp/b c.png'");
  });
});

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
