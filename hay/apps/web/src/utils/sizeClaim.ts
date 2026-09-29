// Who may take a session's terminal size.
//
// The PTY has one size, shared by everyone looking at it, and it is sticky:
// whatever was claimed last stays until someone claims again. So the rule is
// deliberately narrow — only a surface the human just ACTED IN may take it.
// Merely having a session on screen is not an act: a wall of tiles, a
// background tab, a reconnect after a tunnel blip and a pane you are not
// typing in all leave the size alone and render what they are given, scaled.

export type ViewMode = "fit" | "full";
export type Size = { cols: number; rows: number };

/**
 * An attach claims the size only when the human just opened THIS session
 * here: a fresh page load, a switch, or closing the wall into it. A
 * reconnect is the same socket healing itself, and a hidden tab is nobody
 * looking, so neither claims.
 *
 * Manual view mode never auto-claims at all: its whole point is that the
 * user sets the size themselves.
 */
export const claimOnAttach = (o: { viewMode: ViewMode; visible: boolean; deliberate: boolean }): boolean =>
  o.viewMode === "fit" && o.visible && o.deliberate;

/**
 * A click inside the terminal is an act on this surface, so it may take the
 * size — but only when that would actually change something. Already owning
 * the session at this viewport's fit means a click is just a click, and must
 * not push a resize (it would land on every selection drag).
 */
export const claimOnClick = (o: {
  viewMode: ViewMode;
  natural: Size | null;
  active: Size | null;
  owned: boolean;
}): boolean => {
  if (o.viewMode !== "fit" || !o.natural) return false;
  if (!o.owned) return true;
  if (!o.active) return true;
  return o.active.cols !== o.natural.cols || o.active.rows !== o.natural.rows;
};

/**
 * A click is a click only when the pointer stayed put between press and
 * release and nothing is selected. A drag that ends over the terminal also
 * fires `click` — and that drag was a text selection, which a size claim
 * (a resize) would wipe the moment it finished.
 */
export const isPlainClick = (
  down: { x: number; y: number } | null,
  up: { x: number; y: number },
  hasSelection: boolean,
  slopPx = 4
): boolean => {
  if (hasSelection) return false;
  if (!down) return true;
  return Math.hypot(up.x - down.x, up.y - down.y) <= slopPx;
};

/**
 * CLOSE ENOUGH is the right size. A tile that renders the session scaled
 * by ~0.9 is visually free; a claim is for sizes that are genuinely
 * foreign (a full-screen leftover on a wall tile), not for two walls
 * disagreeing about rounding — that disagreement, claimed, was two
 * browsers re-sizing every session back and forth on every open.
 */
export const sizeIsForeign = (current: Size, natural: Size): boolean => {
  const closeCols = Math.abs(current.cols - natural.cols) <= Math.max(3, Math.round(natural.cols * 0.15));
  const closeRows = Math.abs(current.rows - natural.rows) <= Math.max(2, Math.round(natural.rows * 0.15));
  return !(closeCols && closeRows);
};

/**
 * A wall tile going live because the human ENGAGED it — a click, Enter,
 * starting or creating a session there — is the same act as opening a
 * session full screen, and takes the size the same way: only when what the
 * session is wearing is foreign to the tile. The wall pre-focusing the
 * current session as it opens is not an act (nobody clicked), and a tile
 * that already fits has nothing to claim — a claim there would be a resize
 * on every wall open, the fight the size-ownership rules exist to end.
 */
export const claimOnTileFocus = (o: {
  deliberate: boolean;
  natural: Size | null;
  current: Size | null;
}): boolean => {
  if (!o.deliberate || !o.natural) return false;
  if (o.natural.cols < 20 || o.natural.rows < 5) return false;
  if (!o.current) return true;
  return sizeIsForeign(o.current, o.natural);
};
