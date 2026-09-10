// Should optimistic local echo be suppressed because the remote app is a
// full-screen TUI that repaints on every keystroke?
//
// The alternate screen was the only signal. Claude Code, vim and less use
// it — Codex does not: its TUI draws with absolute cursor positioning in a
// scroll region on the NORMAL screen, wrapped in DEC 2026 synchronized-output
// brackets, and enables mouse reporting. Typing into it echoed a raw char
// that the next frame overwrote — the same flicker the alt-screen guard
// fixed for Claude, back for Codex. Any of these says "an app owns the
// screen": no echo.
export const SYNC_OUTPUT_FRESH_MS = 10_000;

export type RemoteScreenSignals = {
  altScreen: boolean;
  mouseReporting: boolean;
  /** A DECSTBM scroll region narrower than the full screen is in effect. */
  scrollRegion: boolean;
  /** Last time a DEC 2026 synchronized-output frame was seen (ms epoch), 0 = never. */
  syncOutputSeenAt: number;
};

export const remoteAppOwnsScreen = (s: RemoteScreenSignals, now: number): boolean =>
  s.altScreen
  || s.mouseReporting
  || s.scrollRegion
  || (s.syncOutputSeenAt > 0 && now - s.syncOutputSeenAt < SYNC_OUTPUT_FRESH_MS);
