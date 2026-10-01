import { describe, expect, it } from "vitest";
import { createReadWitness, levelForDwell, wordCount, type ReadReport } from "../src/utils/readWitness";

// A controllable environment: a clock, visibility flags, and an observer
// whose "visible" we flip by hand. Timers run only when we tick.
const rig = () => {
  let t = 100_000;
  const timers: Array<{ fn: () => void; ms: number; due: number }> = [];
  const flags = { visible: true, focused: true };
  const observers = new Map<Element, (v: boolean) => void>();
  const posts: ReadReport[][] = [];
  const w = createReadWitness((reads) => posts.push(reads), {
    now: () => t,
    isVisible: () => flags.visible,
    isFocused: () => flags.focused,
    observe: (el, onChange) => { observers.set(el, onChange); return () => observers.delete(el); },
    setInterval: (fn, ms) => { const h = { fn, ms, due: t + ms }; timers.push(h); return h; },
    clearInterval: () => {}
  });
  const advance = (ms: number) => {
    const end = t + ms;
    while (true) {
      const next = timers.filter((h) => h.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      t = next.due; next.fn(); next.due += next.ms;
    }
    t = end;
  };
  return { w, flags, observers, posts, advance, el: () => document.createElement("div") };
};

describe("levelForDwell", () => {
  it("1.5s glimpses; the reading time of the text reads", () => {
    expect(levelForDwell(1000, 40)).toBe(null);
    expect(levelForDwell(1500, 40)).toBe("glimpsed");
    expect(levelForDwell(12_000, 40)).toBe("read");  // 40 words = 12s
    expect(levelForDwell(1500, 4)).toBe("read");
    expect(wordCount("  one two   three ")).toBe(3);
  });
});

describe("the witness", () => {
  it("banks dwell only while the item is visible and the human is present, and reports rising levels once", () => {
    const r = rig();
    const el = r.el();
    r.w.ref({ edition: "E1", item: "surf", words: 20 })(el);   // 20 words → 6s to read
    r.advance(3000);
    expect(r.posts.length).toBe(0);                            // never visible
    r.observers.get(el)!(true);
    r.advance(2000); r.w.flush();
    expect(r.posts.flat().map((x) => x.level)).toEqual(["glimpsed"]);
    r.flags.visible = false;                                   // tab hidden: no dwell
    r.advance(10_000); r.w.flush();
    expect(r.posts.flat().map((x) => x.level)).toEqual(["glimpsed"]);
    r.flags.visible = true;
    r.advance(5000); r.w.flush();
    expect(r.posts.flat().map((x) => x.level)).toEqual(["glimpsed", "read"]);
    r.advance(30_000); r.w.flush();
    expect(r.posts.flat().map((x) => x.level)).toEqual(["glimpsed", "read"]);
  });
  it("acted is immediate and strongest", () => {
    const r = rig();
    r.w.acted("E1", "surf");
    expect(r.posts).toEqual([[{ edition: "E1", item: "surf", level: "acted", at: 100_000 }]]);
  });
  it("a frozen tab does not bank hours in one tick", () => {
    const r = rig();
    const el = r.el();
    r.w.ref({ edition: "E1", item: "surf", words: 2000 })(el);  // 10 minutes to read
    r.observers.get(el)!(true);
    r.advance(500);
    r.advance(3_600_000); r.w.flush();                           // one giant jump
    expect(r.posts.flat().map((x) => x.level)).toEqual(["glimpsed"]);
  });
});
