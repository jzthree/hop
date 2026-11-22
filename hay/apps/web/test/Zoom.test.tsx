import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewsPanel } from "../src/components/ViewsPanel";
import { fitZoomFor } from "../src/components/ZoomImage";
import { DOC_MAX_ZOOM, DOC_MIN_ZOOM } from "../src/components/ZoomFrame";
import { readerTakesZoomKeys, stepWithin, zoomKey } from "../src/utils/zoom";

describe("zoom arithmetic", () => {
  it("steps through the usual levels within a range, from wherever it is", () => {
    expect(stepWithin(1, 1, DOC_MIN_ZOOM, DOC_MAX_ZOOM)).toBe(1.1);
    expect(stepWithin(1, -1, DOC_MIN_ZOOM, DOC_MAX_ZOOM)).toBe(0.9);
    expect(stepWithin(3, 1, DOC_MIN_ZOOM, DOC_MAX_ZOOM)).toBe(3);
    expect(stepWithin(0.5, -1, DOC_MIN_ZOOM, DOC_MAX_ZOOM)).toBe(0.5);
    // An image fitted at 12%: one step in is the next usual level.
    expect(stepWithin(0.12, 1, 0.1, 8)).toBe(0.15);
  });

  it("reads + = − _ 0 as zoom keys, nothing else", () => {
    expect(["+", "=", "-", "_", "0", "a", "ArrowUp"].map(zoomKey)).toEqual(["in", "in", "out", "out", "reset", null, null]);
  });

  it("fits a picture to the pane, never past its own pixels", () => {
    expect(fitZoomFor({ w: 2000, h: 1000 }, { w: 500, h: 500 })).toBe(0.25);
    expect(fitZoomFor({ w: 200, h: 100 }, { w: 500, h: 500 })).toBe(1);
    expect(fitZoomFor(null, { w: 500, h: 500 })).toBe(1);
  });
});

const items = [
  { session: "Orion", name: "write-up.md", title: "Write-up", path: "/view/Orion/write-up.md/inline", bytes: 437, mtime: 1786303213 },
  { session: "Orion", name: "roc.png", title: "ROC", path: "/view/Orion/roc.png/inline", bytes: 9999, mtime: 1786303000 }
];
let store: Record<string, string> = {};
beforeEach(() => {
  store = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; }
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const box = () => document.querySelector(".zoom-frame-box") as HTMLElement;

describe("ViewsPanel › zooming a document", () => {
  it("− 100% + scale the page and lay it out to match; the zoom is remembered for the next document", async () => {
    render(<ViewsPanel session="Orion" item="write-up.md" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector("iframe.views-frame")).toBeTruthy());
    expect(box().style.transform).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(box().style.transform).toBe("scale(1.25)");
    expect(box().style.width).toBe("80%");
    expect(screen.getByRole("button", { name: /^Zoom 125%/ })).toBeTruthy();
    expect(store.hop_views_doc_zoom_v1).toBe("1.25");
    cleanup();
    render(<ViewsPanel session="Orion" item="write-up.md" onClose={() => {}} />);
    await waitFor(() => expect(box()?.style.transform).toBe("scale(1.25)"));
    // The percentage is "actual size".
    fireEvent.click(screen.getByRole("button", { name: /^Zoom 125%/ }));
    expect(box().style.transform).toBe("");
    expect(store.hop_views_doc_zoom_v1).toBeUndefined();
  });

  it("⌘+ / ⌘− / ⌘0 zoom the open result, and the terminal's font keys stand aside", async () => {
    render(<ViewsPanel session="Orion" item="write-up.md" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector("iframe.views-frame")).toBeTruthy());
    expect(readerTakesZoomKeys(document.body)).toBe(true);
    fireEvent.keyDown(window, { key: "=", metaKey: true });
    expect(box().style.transform).toBe("scale(1.1)");
    fireEvent.keyDown(window, { key: "-", metaKey: true });
    fireEvent.keyDown(window, { key: "-", metaKey: true });
    expect(box().style.transform).toBe("scale(0.9)");
    fireEvent.keyDown(window, { key: "0", metaKey: true });
    expect(box().style.transform).toBe("");
  });

  it("beside the terminal, only keys that start in the reader are its", async () => {
    render(<ViewsPanel session="Orion" item="write-up.md" placement="side" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector("iframe.views-frame")).toBeTruthy());
    expect(readerTakesZoomKeys(document.body)).toBe(false);
    expect(readerTakesZoomKeys(screen.getByRole("button", { name: "Zoom in" }))).toBe(true);
  });
});

describe("ViewsPanel › zooming an image", () => {
  it("opens fitted, zooms in from there, and 0 fits it again", async () => {
    render(<ViewsPanel session="Orion" item="roc.png" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector(".zoom-image img")).toBeTruthy());
    const img = document.querySelector(".zoom-image img") as HTMLImageElement;
    const scroll = document.querySelector(".zoom-image-scroll") as HTMLElement;
    Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 500 });
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 2000 });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: 1000 });
    fireEvent.load(img);
    // Fitted: 500 / 2000.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Zoom 25%/ })).toBeTruthy());
    expect(img.style.width).toBe("500px");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(img.style.width).toBe("660px");
    fireEvent.keyDown(window, { key: "0" });
    expect(img.style.width).toBe("500px");
  });
});
