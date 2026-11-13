import { describe, expect, it } from "vitest";
import { inlineText, parseInline, parseMarkdown, splitRow, type MdBlock } from "../src/utils/markdown";

const kinds = (bs: MdBlock[]) => bs.map((b) => b.kind);

describe("markdown blocks", () => {
  it("a GitHub table: header, alignment, rows, figures set apart", () => {
    const [t] = parseMarkdown([
      "| Model | Steps | AUC | Notes |",
      "|:---|--:|---|:-:|",
      "| **base** | 1,200 | 0.794 | — |",
      "| tuned | 3k | **0.812** | lr `1e-4` |"
    ].join("\n"));
    expect(t.kind).toBe("table");
    if (t.kind !== "table") return;
    expect(t.head).toEqual(["Model", "Steps", "AUC", "Notes"]);
    expect(t.align).toEqual(["left", "right", null, "center"]);
    expect(t.rows).toEqual([["**base**", "1,200", "0.794", "—"], ["tuned", "3k", "**0.812**", "lr `1e-4`"]]);
    // AUC has no alignment of its own and holds figures; Steps says right already.
    expect(t.numeric).toEqual([false, false, true, false]);
    // Labels and figures stay on one line; only Notes would wrap (all short here).
    expect(t.short).toEqual([true, true, true, true]);
    const [t2] = parseMarkdown("| split | notes |\n|---|---|\n| held-out | a sentence long enough to wrap in its cell |");
    expect(t2.kind === "table" && t2.short).toEqual([true, false]);
  });

  it("a pipe inside code, or escaped, stays in its cell", () => {
    expect(splitRow("| `a | b` | c \\| d | e |")).toEqual(["`a | b`", "c | d", "e"]);
    expect(splitRow("x | y")).toEqual(["x", "y"]);
    expect(splitRow("| x |  |")).toEqual(["x", ""]);
  });

  it("a table straight after a line of text, and ended by one without a pipe", () => {
    const bs = parseMarkdown("Here's where it stands:\n| a | b |\n|---|---|\n| 1 | 2 |\nThat's all.");
    expect(kinds(bs)).toEqual(["p", "table", "p"]);
  });

  it("no separator row, no table — and a rule under text is a rule", () => {
    expect(kinds(parseMarkdown("a | b\nc | d"))).toEqual(["p"]);
    expect(kinds(parseMarkdown("a | b\n---\nmore"))).toEqual(["p", "hr", "p"]);
  });

  it("fenced code keeps its insides verbatim, even indented in a list", () => {
    const bs = parseMarkdown("Run:\n```bash\nls | head **x**\n\n  echo hi\n```\n- resume:\n  ```\n  cd ~/x && claude --resume abc\n  ```\n- done");
    expect(kinds(bs)).toEqual(["p", "code", "list"]);
    expect(bs[1]).toEqual({ kind: "code", lang: "bash", text: "ls | head **x**\n\n  echo hi" });
    const list = bs[2];
    if (list.kind !== "list") throw new Error("list");
    expect(list.items).toHaveLength(2);
    expect(kinds(list.items[0].blocks)).toEqual(["p", "code"]);
    expect(list.items[0].blocks[1]).toEqual({ kind: "code", lang: "", text: "cd ~/x && claude --resume abc" });
  });

  it("numbered lists keep their start; bullets nest under them at two spaces", () => {
    const [l] = parseMarkdown("3. third\n  - a\n  - b\n4. fourth\n   1. inner");
    if (l.kind !== "list") throw new Error("list");
    expect(l.ordered).toBe(true);
    expect(l.start).toBe(3);
    expect(l.items).toHaveLength(2);
    const sub = l.items[0].blocks[1];
    expect(sub.kind === "list" && !sub.ordered && sub.items.length).toBe(2);
    const inner = l.items[1].blocks[1];
    expect(inner.kind === "list" && inner.ordered).toBe(true);
  });

  it("blank lines between items keep one list; a paragraph after ends it", () => {
    const bs = parseMarkdown("- one\n\n- two\n\n  more about two\n\nAfter.");
    expect(kinds(bs)).toEqual(["list", "p"]);
    const l = bs[0];
    if (l.kind !== "list") throw new Error("list");
    expect(l.items).toHaveLength(2);
    expect(kinds(l.items[1].blocks)).toEqual(["p", "p"]);
  });

  it("a wrapped line of a bullet is that bullet; a different marker kind is a new list", () => {
    const bs = parseMarkdown("- a long item\nthat wrapped\n1. then numbers");
    expect(kinds(bs)).toEqual(["list", "list"]);
    const l = bs[0];
    expect(l.kind === "list" && l.items[0].blocks[0]).toEqual({ kind: "p", text: "a long item that wrapped" });
  });

  it("task boxes, headings, quotes and rules", () => {
    const bs = parseMarkdown("## Status ##\n- [x] trained\n- [ ] evaluated\n\n> a note\nstill the note\n\n***\n#hashtag");
    expect(kinds(bs)).toEqual(["h", "list", "quote", "hr", "p"]);
    expect(bs[0]).toEqual({ kind: "h", level: 2, text: "Status" });
    const l = bs[1];
    expect(l.kind === "list" && l.items.map((it) => it.check)).toEqual([true, false]);
    const q = bs[2];
    expect(q.kind === "quote" && q.blocks).toEqual([{ kind: "p", text: "a note still the note" }]);
  });

  it("paragraph lines join; a trailing backslash breaks the line", () => {
    expect(parseMarkdown("one\ntwo\\\nthree")).toEqual([{ kind: "p", text: "one two\nthree" }]);
  });
});

describe("markdown inline", () => {
  const show = (s: string) => JSON.stringify(parseInline(s));
  it("bold, italics, strikethrough, code — and snake_case and globs left alone", () => {
    expect(parseInline("**a** *b* ~~c~~ `d`")).toEqual([
      { t: "strong", c: [{ t: "text", v: "a" }] }, { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "b" }] }, { t: "text", v: " " },
      { t: "del", c: [{ t: "text", v: "c" }] }, { t: "text", v: " " },
      { t: "code", v: "d" }
    ]);
    expect(parseInline("my_var_name and *.py or *.js, 5 * 3")).toEqual([{ t: "text", v: "my_var_name and *.py or *.js, 5 * 3" }]);
    expect(show("__init__.py")).not.toContain("strong");
    expect(show("***both***")).toBe(JSON.stringify([{ t: "strong", c: [{ t: "em", c: [{ t: "text", v: "both" }] }] }]));
    expect(show("**bold with `code**` inside**")).toContain('"t":"code","v":"code**"');
  });

  it("links: labelled, angle, bare — the sentence's punctuation stays out", () => {
    const nodes = parseInline("See [the **doc**](https://a.org/x_(y)), <https://b.org>, or https://c.org/p?q=1.");
    const links = nodes.filter((n) => n.t === "link");
    expect(links.map((l) => l.t === "link" && l.href)).toEqual(["https://a.org/x_(y)", "https://b.org", "https://c.org/p?q=1"]);
    expect(inlineText(nodes)).toBe("See the doc, https://b.org, or https://c.org/p?q=1.");
    expect(show("(https://d.org/a)")).toContain('"href":"https://d.org/a"');
  });

  it("escapes and unclosed marks are literal", () => {
    expect(inlineText(parseInline("\\*not em\\* and **open"))).toBe("*not em* and **open");
    expect(parseInline("a `b")).toEqual([{ t: "text", v: "a `b" }]);
  });
});
