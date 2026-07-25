// Drag-and-drop helper. Browsers deliberately never expose a dropped file's
// real filesystem path, so hop can't paste it — instead the drop is caught
// and the user is pointed at the OS gesture that DOES yield the path.

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
