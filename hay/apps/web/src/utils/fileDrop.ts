// Drag-and-drop helpers. Browsers deliberately never expose a dropped file's
// real filesystem path — so hop uploads the BYTES to the host instead and
// pastes the path the file landed on. The path hint below survives as the
// fallback for when that upload cannot happen (old daemon, offline).

/** Quote a path for a shell only when it needs it. A bare path stays bare —
 *  most drops land somewhere boring, and gratuitous quotes read as noise in
 *  an agent's composer. Single-quote style, with the standard '\'' escape. */
export const shellQuotePath = (filePath: string): string => {
  if (filePath === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(filePath)) return filePath;
  return `'${filePath.replace(/'/g, `'\\''`)}'`;
};

/** Join uploaded paths into one paste: space-separated, each quoted only if
 *  it must be. Reads as a command argument list, which is what it usually
 *  becomes. */
export const pasteableUploadPaths = (paths: string[]): string =>
  paths.map(shellQuotePath).join(" ");

/** OS-specific "copy the file's path" hotkey hint. Pass a platform string
 *  (navigator.platform + userAgent); pure so it's unit-testable. */
export const originalPathHint = (platform: string): string => {
  if (/Mac|iPhone|iPad/i.test(platform)) {
    return "Browsers can't see file paths — select the file in Finder, press ⌘⌥C, then paste here.";
  }
  if (/Win/i.test(platform)) {
    return "Browsers can't see file paths — select the file in Explorer, press Ctrl+Shift+C, then paste here.";
  }
  return "Browsers can't see file paths — copy the path in your file manager, then paste here.";
};
