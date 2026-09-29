// Drag to select in an AGENT session, even while the app has mouse tracking on.
//
// Claude Code and Codex both enable mouse tracking (for the wheel), and
// xterm then hands every drag to the app instead of selecting. On a Mac
// xterm offers no rescue gesture by default: Shift is ignored there, and
// ⌥-drag needs an option nobody sets. So "I selected text and ⌘C copied
// nothing" was really "nothing was ever selected" — the drag went to Claude,
// which does nothing with it.
//
// Neither agent uses clicks or drags, only the wheel. So while the pointer
// is down for a plain left drag on an agent surface, tracking is switched
// off LOCALLY (xterm's protocol state is local anyway — the app is never
// told), the drag selects, and the protocol is put back on release. The
// wheel still reaches the app between drags. Other TUIs (vim, htop, tmux
// with the mouse on) keep their drags: the gate is the agent surface, not
// the tracking mode.

export type TrackingTerminal = {
  modes: { mouseTrackingMode: string };
  hasSelection: () => boolean;
  onSelectionChange: (cb: () => void) => { dispose: () => void };
  _core?: { coreMouseService?: { activeProtocol: string } };
};

/** A plain left press on an agent surface while the app tracks the mouse. */
export const shouldSelectLocally = (o: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  trackingMode: string;
  agentSurface: boolean;
}): boolean =>
  o.button === 0 && !o.metaKey && !o.ctrlKey && o.trackingMode !== "none" && o.agentSurface;

/**
 * Installs the capture-phase mousedown that pauses tracking for the drag.
 * Tracking stays paused for as long as the selection it produced exists:
 * xterm DISABLES its selection service when a protocol comes back on, and
 * disabling clears the selection — restoring on release wiped the very
 * text the drag had just selected (so ⌘C copied nothing). The selection
 * clears on the next keypress or a click elsewhere, and tracking returns
 * then. Returns the uninstaller. `agentSurface` is consulted at press time,
 * so a session that stops being an agent session (shell after `exit`) gets
 * its drags forwarded again.
 */
export const installDragSelect = (
  terminal: TrackingTerminal,
  element: HTMLElement,
  agentSurface: () => boolean
): (() => void) => {
  let paused: { prev: string; sub: { dispose: () => void } | null } | null = null;
  const mouse = () => terminal._core?.coreMouseService;
  const resume = () => {
    if (!paused) return;
    const { prev, sub } = paused;
    paused = null;
    sub?.dispose();
    const m = mouse();
    // Put it back only if nothing else changed it meanwhile (the app
    // switching tracking off during the pause is its own decision).
    try { if (m && m.activeProtocol === "NONE") m.activeProtocol = prev; } catch { /* gone */ }
  };
  const onUp = () => {
    if (!paused) return;
    let has = false;
    try { has = terminal.hasSelection(); } catch { has = false; }
    if (!has) { resume(); return; }
    if (!paused.sub) {
      paused.sub = terminal.onSelectionChange(() => {
        let still = false;
        try { still = terminal.hasSelection(); } catch { still = false; }
        if (!still) resume();
      });
    }
  };
  const onDown = (ev: MouseEvent) => {
    const m = mouse();
    if (!m) return;
    let trackingMode = "none";
    try { trackingMode = terminal.modes.mouseTrackingMode; } catch { return; }
    const local = shouldSelectLocally({ button: ev.button, metaKey: ev.metaKey, ctrlKey: ev.ctrlKey, trackingMode, agentSurface: agentSurface() });
    if (paused) {
      // Already paused for a standing selection: another selecting press
      // just replaces it; any other press hands the mouse back first.
      if (!local) resume();
      return;
    }
    if (!local) return;
    const prev = m.activeProtocol;
    try { m.activeProtocol = "NONE"; } catch { return; }
    paused = { prev, sub: null };
  };
  element.addEventListener("mousedown", onDown, true);
  window.addEventListener("mouseup", onUp, true);
  return () => {
    element.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("mouseup", onUp, true);
    resume();
  };
};
