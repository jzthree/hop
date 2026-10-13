// The full-screen ⇄ wall chord inside a terminal. On a Mac it is ⌘⏎ only:
// Ctrl⏎ belongs to the app (Claude Code binds it), and hop taking it meant
// the keystroke never arrived. Elsewhere there is no ⌘, so Ctrl⏎ stays.
export const IS_MAC = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

type Chord = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

export function isFullscreenChord(ev: Chord, mac = IS_MAC): boolean {
  if (ev.key !== "Enter" || ev.altKey || ev.shiftKey) return false;
  return mac ? ev.metaKey && !ev.ctrlKey : ev.metaKey || ev.ctrlKey;
}

/** Ctrl⏎ passed to the app: CSI-u (13;5u), since xterm.js would send a bare \r. */
export function isAppCtrlEnter(ev: Chord, mac = IS_MAC): boolean {
  return ev.key === "Enter" && ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey
    && !isFullscreenChord(ev, mac);
}
