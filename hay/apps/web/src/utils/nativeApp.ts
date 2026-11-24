// Inside hop's Mac app (window.hopNative, set by the app before the page
// loads) a hop page asked to open "in a new tab" opens in a new hop window,
// and a link elsewhere opens in the default browser: there are no tabs to
// name.
export const inMacApp = (): boolean =>
  typeof window !== "undefined"
  && (window as { hopNative?: { platform?: string } }).hopNative?.platform === "mac";

/** "new window" in the Mac app, "new tab" in a browser. */
export const newPlace = (): string => (inMacApp() ? "new window" : "new tab");
