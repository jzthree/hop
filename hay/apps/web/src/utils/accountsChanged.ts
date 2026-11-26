// The accounts a session can run on (its menu's Account item, the wall's
// labels) were read once, when the page opened: an account added or signed
// in afterwards showed nowhere until the page was reloaded — in the Mac app,
// until the app was restarted. Views that list accounts read them again
// when Settings adds, signs in or removes one, and when the window comes
// back to the front (an account set up from a terminal, or another device).

export const ACCOUNTS_CHANGED = "hop:accounts-changed";

/** Settings changed the accounts: every view that lists them reads them again. */
export const notifyAccountsChanged = (): void => {
  try { window.dispatchEvent(new Event(ACCOUNTS_CHANGED)); } catch { /* no window */ }
};

/**
 * Call `reload` when the accounts may have changed: at once on
 * notifyAccountsChanged, and on the window's return to the front at most
 * every `minGapMs`. Returns the unsubscribe.
 */
export const onAccountsMaybeChanged = (reload: () => void, minGapMs = 30_000): (() => void) => {
  let last = Date.now();
  const now = () => { last = Date.now(); reload(); };
  const back = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (Date.now() - last >= minGapMs) now();
  };
  window.addEventListener(ACCOUNTS_CHANGED, now);
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", back);
  return () => {
    window.removeEventListener(ACCOUNTS_CHANGED, now);
    window.removeEventListener("focus", back);
    document.removeEventListener("visibilitychange", back);
  };
};
