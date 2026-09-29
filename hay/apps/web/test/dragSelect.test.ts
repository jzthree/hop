import { describe, expect, it } from "vitest";
import { installDragSelect, shouldSelectLocally, type TrackingTerminal } from "../src/utils/dragSelect";

const fakeTerminal = (mode: string, protocol: string) => {
  const mouse = { activeProtocol: protocol };
  const subs = new Set<() => void>();
  const t = {
    modes: { mouseTrackingMode: mode },
    _core: { coreMouseService: mouse },
    mouse,
    selected: false,
    hasSelection: () => t.selected,
    onSelectionChange: (cb: () => void) => { subs.add(cb); return { dispose: () => subs.delete(cb) }; },
    setSelected: (v: boolean) => { t.selected = v; for (const cb of subs) cb(); }
  };
  return t as TrackingTerminal & typeof t;
};

describe("shouldSelectLocally — a plain drag on an agent surface selects, tracking or not", () => {
  const base = { button: 0, metaKey: false, ctrlKey: false, trackingMode: "drag", agentSurface: true };
  it("yes for a plain left press while Claude/Codex track the mouse", () => {
    expect(shouldSelectLocally(base)).toBe(true);
  });
  it("no when the app is not an agent (vim, htop, tmux keep their drags)", () => {
    expect(shouldSelectLocally({ ...base, agentSurface: false })).toBe(false);
  });
  it("no when tracking is already off (xterm selects by itself), or for right/ctrl/cmd presses", () => {
    expect(shouldSelectLocally({ ...base, trackingMode: "none" })).toBe(false);
    expect(shouldSelectLocally({ ...base, button: 2 })).toBe(false);
    expect(shouldSelectLocally({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldSelectLocally({ ...base, metaKey: true })).toBe(false);
  });
});

describe("installDragSelect — tracking pauses for the drag and stays paused while the selection stands", () => {
  const press = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
  const release = () => window.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
  it("a drag that selected nothing hands the mouse back on release", () => {
    const t = fakeTerminal("drag", "DRAG");
    const el = document.createElement("div"); document.body.appendChild(el);
    const off = installDragSelect(t, el, () => true);
    press(el);
    expect(t.mouse.activeProtocol).toBe("NONE");
    release();
    expect(t.mouse.activeProtocol).toBe("DRAG");
    off();
  });
  it("a drag that selected text keeps tracking off until the selection clears — so ⌘C still has it", () => {
    const t = fakeTerminal("drag", "DRAG");
    const el = document.createElement("div"); document.body.appendChild(el);
    const off = installDragSelect(t, el, () => true);
    press(el); t.setSelected(true); release();
    expect(t.mouse.activeProtocol).toBe("NONE");
    // A second selecting press replaces the selection, still paused.
    press(el); t.setSelected(true); release();
    expect(t.mouse.activeProtocol).toBe("NONE");
    // A keypress clears the selection (xterm does this): tracking returns.
    t.setSelected(false);
    expect(t.mouse.activeProtocol).toBe("DRAG");
    off();
  });
  it("leaves a non-agent surface alone, and respects the app turning tracking off mid-drag", () => {
    const t = fakeTerminal("drag", "DRAG");
    const el = document.createElement("div"); document.body.appendChild(el);
    let agent = false;
    const off = installDragSelect(t, el, () => agent);
    press(el);
    expect(t.mouse.activeProtocol).toBe("DRAG");
    release();
    agent = true;
    press(el);
    expect(t.mouse.activeProtocol).toBe("NONE");
    t.mouse.activeProtocol = "ANY"; // the app changed its mind during the drag
    release();
    expect(t.mouse.activeProtocol).toBe("ANY");
    off();
  });
  it("a right or ctrl press while paused hands the mouse back first", () => {
    const t = fakeTerminal("drag", "DRAG");
    const el = document.createElement("div"); document.body.appendChild(el);
    const off = installDragSelect(t, el, () => true);
    press(el); t.setSelected(true); release();
    el.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }));
    expect(t.mouse.activeProtocol).toBe("DRAG");
    off();
  });
});
