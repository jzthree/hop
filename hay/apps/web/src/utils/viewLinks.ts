// A `hop view` link is `<hop>/view/<session>/<file>[/inline]` — the URL the
// CLI prints and the inline card carries. On THIS hop (the page's own host,
// or loopback: the CLI prints the daemon's local address when no tunnel is
// up) it opens in the Views reader instead of a new browser tab; ⌘/Ctrl-
// click, middle click and the reader's ↗ keep the new tab as a choice.
// Any other host's view link is someone else's hop and opens as a link.

export type ViewLink = { session: string; name: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const parseViewLink = (href: string, here: { host: string; origin: string } = window.location): ViewLink | null => {
  let url: URL;
  try { url = new URL(href, here.origin); } catch { return null; }
  if (url.host !== here.host && !LOOPBACK.has(url.hostname)) return null;
  const m = /^\/view\/([^/]+)\/([^/]+?)(?:\/inline)?\/?$/.exec(url.pathname);
  if (!m) return null;
  try {
    return { session: decodeURIComponent(m[1]), name: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
};

/** A click that asked for a new tab: ⌘ (mac), Ctrl, or the middle button. */
export const wantsNewTab = (event?: { metaKey?: boolean; ctrlKey?: boolean; button?: number } | null): boolean =>
  !!event && (!!event.metaKey || !!event.ctrlKey || event.button === 1);
