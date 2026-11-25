import { afterEach, describe, expect, it, vi } from "vitest";
import { locateDroppedFiles } from "./fileDrop";

const f = (name: string) => new File(["x"], name, { lastModified: 1 });
const w = window as { __hopDragPaths?: string[] };
afterEach(() => { vi.unstubAllGlobals(); w.__hopDragPaths = undefined; });

describe("locateDroppedFiles", () => {
  it("sends the Mac app's paths once, matched by name, and returns the daemon's answer", async () => {
    w.__hopDragPaths = ["/Users/u/Desktop/b.pdf", "/Users/u/Desktop/a.txt"];
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.files.map((x: { path?: string }) => x.path)).toEqual(["/Users/u/Desktop/a.txt", "/Users/u/Desktop/b.pdf"]);
      return new Response(JSON.stringify({ paths: ["/Users/u/Desktop/a.txt", null] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await locateDroppedFiles("s", [f("a.txt"), f("b.pdf")])).toEqual(["/Users/u/Desktop/a.txt", null]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(w.__hopDragPaths).toBeUndefined();
  });

  it("a daemon that never answers means upload, not a hung drop", async () => {
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    expect(await locateDroppedFiles("s", [f("a"), f("b")], 50)).toEqual([null, null]);
  });
});
