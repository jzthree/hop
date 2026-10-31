import { describe, expect, it } from "vitest";
import { parseViewLink, wantsNewTab } from "../src/utils/viewLinks";

const here = { host: "hop.example.org", origin: "https://hop.example.org" };

describe("parseViewLink", () => {
  it("reads this hop's view links, with or without /inline", () => {
    expect(parseViewLink("https://hop.example.org/view/s_abc/plot%20one.png/inline", here)).toEqual({ session: "s_abc", name: "plot one.png" });
    expect(parseViewLink("https://hop.example.org/view/s_abc/report.md", here)).toEqual({ session: "s_abc", name: "report.md" });
    expect(parseViewLink("/view/s_abc/report.md/inline", here)).toEqual({ session: "s_abc", name: "report.md" });
  });
  it("accepts the daemon's loopback address", () => {
    expect(parseViewLink("http://127.0.0.1:37617/view/s_abc/a.pdf/inline", here)).toEqual({ session: "s_abc", name: "a.pdf" });
  });
  it("leaves other hosts and other paths alone", () => {
    expect(parseViewLink("https://other.example.org/view/s_abc/a.pdf/inline", here)).toBeNull();
    expect(parseViewLink("https://hop.example.org/s/s_abc/", here)).toBeNull();
    expect(parseViewLink("https://hop.example.org/view/s_abc/a.pdf/download", here)).toBeNull();
    expect(parseViewLink("not a url at all", { host: "x", origin: "x" })).toBeNull();
  });
});

describe("wantsNewTab", () => {
  it("is ⌘, Ctrl or a middle click", () => {
    expect(wantsNewTab({ metaKey: true })).toBe(true);
    expect(wantsNewTab({ ctrlKey: true })).toBe(true);
    expect(wantsNewTab({ button: 1 })).toBe(true);
    expect(wantsNewTab({ button: 0 })).toBe(false);
    expect(wantsNewTab(null)).toBe(false);
  });
});
