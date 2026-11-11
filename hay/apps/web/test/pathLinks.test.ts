import { describe, expect, it } from "vitest";
import { findPathSpans } from "../src/utils/pathLinks";

// The paths an agent prints that open in the Views reader.
describe("findPathSpans", () => {
  const paths = (t: string) => findPathSpans(t).map((s) => s.path);
  it("finds the kinds hop shows, absolute, ~, relative or bare, without the punctuation around them", () => {
    expect(paths("Saved results/loss.png and **/Users/x/p/report.html**.")).toEqual(["results/loss.png", "/Users/x/p/report.html"]);
    expect(paths("See `figs/roc.pdf`, fig_2.svg; and ~/Code/p/notes.md.")).toEqual(["figs/roc.pdf", "fig_2.svg", "~/Code/p/notes.md"]);
    expect(paths("[table](out/table.csv) then ../up/one.ipynb!")).toEqual(["out/table.csv", "../up/one.ipynb"]);
  });
  it("leaves URLs to the web-links addon, and code and odd endings alone", () => {
    expect(paths("https://example.com/a.png and http://localhost:8000/r.html")).toEqual([]);
    expect(paths("main.py, data.json, image.png.bak, foo.pngx, .md")).toEqual([]);
  });
  it("gives offsets that cover exactly the path", () => {
    const t = "  ⎿ wrote out/fig.png now";
    const [s] = findPathSpans(t);
    expect(t.slice(s.start, s.end)).toBe("out/fig.png");
  });
});
