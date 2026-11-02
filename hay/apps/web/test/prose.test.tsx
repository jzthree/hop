import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Prose, plainText } from "../src/utils/prose";

afterEach(cleanup);

describe("Prose", () => {
  it("draws paragraphs, bullets, emphasis, code and links — and never HTML", () => {
    const { container } = render(<Prose text={"First **bold** and `code`.\nsame paragraph\n\n- one\n- [two](https://example.org)\n\n<script>alert(1)</script>"} />);
    expect(container.querySelectorAll("p").length).toBe(2);
    expect(container.querySelector("strong")!.textContent).toBe("bold");
    expect(container.querySelector("code")!.textContent).toBe("code");
    expect(container.querySelectorAll("li").length).toBe(2);
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.org");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
  it("does not turn a javascript: link into a link", () => {
    const { container } = render(<Prose text={"[x](javascript:alert(1))"} />);
    expect(container.querySelector("a")).toBeNull();
  });
  it("copies as plain text", () => {
    expect(plainText("**a** `b` [c](https://d)")).toBe("a b c (https://d)");
  });
});
