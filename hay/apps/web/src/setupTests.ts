import "@testing-library/jest-dom";

// xterm.js touches matchMedia (and ResizeObserver) on open; jsdom has neither.
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia;
  }
  if (!(window as { ResizeObserver?: unknown }).ResizeObserver) {
    (window as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}

// UI state kept for a refresh (sessionStorage) must not carry from one test
// into the next.
import { beforeEach as clearBetween } from "vitest";
clearBetween(() => { try { sessionStorage.clear(); } catch { /* not a browser test */ } });
