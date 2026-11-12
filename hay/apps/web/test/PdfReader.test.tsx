import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampZoom, stepZoom, wheelFactor, MIN_ZOOM, MAX_ZOOM } from "../src/components/PdfReader";

// The reader itself draws with pdf.js in a real browser (checked there);
// here: the zoom arithmetic, and that the views reader uses it for a PDF
// with the browser's own viewer as the fallback.
let failNow: (() => void) | null = null;
vi.mock("../src/components/PdfReader", async (orig) => {
  const real = await orig<typeof import("../src/components/PdfReader")>();
  return {
    ...real,
    PdfReader: ({ src, onFail }: { src: string; onFail?: () => void }) => {
      failNow = onFail ?? null;
      return <div className="pdf-reader" data-src={src} />;
    }
  };
});
import { ViewsPanel } from "../src/components/ViewsPanel";

describe("PDF zoom arithmetic", () => {
  it("steps through the usual zoom levels from wherever it is, within bounds", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    // From a pinch's in-between zoom, the next level each way.
    expect(stepZoom(1.29, 1)).toBe(1.5);
    expect(stepZoom(1.29, -1)).toBe(1.25);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(clampZoom(40)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
  });

  it("a pinch's small wheel deltas follow the fingers; a mouse notch is one modest step", () => {
    // Chrome's pinch: deltaY of a few px per event, in and out symmetric.
    expect(wheelFactor(-4, 0)).toBeCloseTo(Math.exp(0.04));
    expect(wheelFactor(-4, 0) * wheelFactor(4, 0)).toBeCloseTo(1);
    // A mouse wheel notch (100 px, or 3 lines in Firefox): about 28%, not 2.7×.
    expect(wheelFactor(-100, 0)).toBeCloseTo(Math.exp(0.25));
    expect(wheelFactor(-3, 1)).toBeCloseTo(Math.exp(0.25));
    expect(wheelFactor(100, 0)).toBeLessThan(1);
  });
});

describe("ViewsPanel › a PDF", () => {
  const items = [{ session: "Orion", name: "paper.pdf", title: "The paper", path: "/view/Orion/paper.pdf/inline", bytes: 114171, mtime: 1786303213 }];
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items }) })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); failNow = null; });

  it("reads in hop's own reader; if pdf.js can't read it, in the browser's viewer", async () => {
    render(<ViewsPanel session="Orion" item="paper.pdf" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector(".pdf-reader")?.getAttribute("data-src")).toBe("/view/Orion/paper.pdf/inline"));
    expect(document.querySelector("iframe.views-frame")).toBeNull();
    act(() => failNow?.());
    await waitFor(() => expect(document.querySelector("iframe.views-frame")?.getAttribute("src")).toBe("/view/Orion/paper.pdf/inline"));
    expect(document.querySelector(".pdf-reader")).toBeNull();
  });
});
