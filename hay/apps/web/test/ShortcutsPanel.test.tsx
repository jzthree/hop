import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutsPanel, dayRoutine } from "../src/components/ShortcutsPanel";

afterEach(() => cleanup());

describe("ShortcutsPanel", () => {
  it("teaches a day's routine first, in order, with the chords for the platform", () => {
    // Switching is search, so it leads.
    expect(dayRoutine(true).map((r) => r.keys)).toEqual(["⌘K, type, ⏎", "⌘G", "⌘E", "⌘K ⌘K", "⌘⇧V", "Esc"]);
    // Elsewhere Ctrl+Shift, and no Views chord (Ctrl+Shift+V is paste).
    expect(dayRoutine(false).map((r) => r.keys)).toEqual(["Ctrl+Shift+K, type, ⏎", "Ctrl+Shift+G", "Ctrl+Shift+E", "Ctrl+Shift+K Ctrl+Shift+K", "Esc"]);
  });

  it("closes on Escape and keeps the long tail folded", () => {
    const onClose = vi.fn();
    render(<ShortcutsPanel isMac onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect((document.querySelector("details.shortcuts-more") as HTMLDetailsElement).open).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
