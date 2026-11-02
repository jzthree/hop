import { useEffect, type RefObject } from "react";

// A scrolled page comes back where it was after a refresh (this browser tab
// only): the position is kept under `key`, and put back once `ready` says
// the content is there to scroll.
export const useSavedScroll = (ref: RefObject<HTMLElement | null>, key: string, ready: boolean) => {
  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    try {
      const top = Number(sessionStorage.getItem(key) || 0);
      if (top > 0) el.scrollTop = top;
    } catch { /* private window */ }
    let t = 0;
    const onScroll = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => { try { sessionStorage.setItem(key, String(Math.round(el.scrollTop))); } catch { /* private window */ } }, 150);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.clearTimeout(t); el.removeEventListener("scroll", onScroll); };
  }, [ref, key, ready]);
};
