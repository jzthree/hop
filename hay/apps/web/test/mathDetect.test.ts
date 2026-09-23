import { describe, expect, it } from "vitest";
import { findMathSpans } from "../src/utils/mathDetect";

const texOf = (s: string) => findMathSpans(s).map((m) => m.tex);

describe("findMathSpans — delimited forms", () => {
  it("finds inline dollars, display dollars, and the paren/bracket forms", () => {
    expect(texOf("so $e^{i\\pi} + 1 = 0$ holds")).toEqual(["e^{i\\pi} + 1 = 0"]);
    const d = findMathSpans("$$\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$");
    expect(d).toHaveLength(1);
    expect(d[0].display).toBe(true);
    expect(texOf("value \\(a^2 + b^2 = c^2\\) here")).toEqual(["a^2 + b^2 = c^2"]);
    expect(findMathSpans("\\[ x = \\frac{-b}{2a} \\]")[0].display).toBe(true);
  });

  it("leaves prices alone", () => {
    expect(texOf("it costs $5 and $10 today")).toEqual([]);
    expect(texOf("between $3.50 and $4")).toEqual([]);
  });

  it("covers the delimiters in the span but not in the tex", () => {
    const s = "see $x_i$ now";
    const [m] = findMathSpans(s);
    expect(s.slice(m.start, m.end)).toBe("$x_i$");
    expect(m.tex).toBe("x_i");
  });
});

describe("findMathSpans — bare LaTeX", () => {
  it("picks a command run out of prose and trims the sentence punctuation", () => {
    expect(texOf("the root is \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}, as expected.")).toEqual(["\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}"]);
  });

  it("extends over the operators and symbols around the command", () => {
    expect(texOf("so x = \\alpha^2 + \\beta here")).toEqual(["x = \\alpha^2 + \\beta"]);
  });

  it("stops at prose words and keeps braces balanced", () => {
    expect(texOf("use \\sqrt{2} which is irrational")).toEqual(["\\sqrt{2}"]);
    expect(texOf("broken \\frac{a}{b and more")).toEqual([]);
  });

  it("ignores backslashes that are not math", () => {
    expect(texOf("path C:\\Users\\demo and \\n newlines")).toEqual([]);
  });

  it("returns several spans in order without overlap", () => {
    const s = "first $a+b$ then \\gamma(t) and $$c$$";
    const spans = findMathSpans(s);
    expect(spans.map((m) => m.tex)).toEqual(["a+b", "\\gamma(t)", "c"]);
    for (let i = 1; i < spans.length; i += 1) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
  });
});
