// The briefing's read witness, browser side. A story counts as seen only
// when a human could have read it: the item itself at least 60% on screen,
// the tab visible, the window focused, and the person active (some input
// in the last few minutes). Dwell accumulates only while all four hold;
// 1.5s earns "glimpsed", the text's reading time (200 wpm) earns "read",
// opening the session from the story is "acted". Reports go to the daemon,
// which keeps the union across devices (lib/digest-reads.js) — reading on
// the phone counts here and the other way round.

export type ReadLevel = "glimpsed" | "read" | "acted";
export type ReadReport = { edition: string; item: string; level: ReadLevel; at: number };

export const GLIMPSE_MS = 1500;
const WPM = 200;
const ACTIVE_WINDOW_MS = 3 * 60_000;
const TICK_MS = 500;

export const wordCount = (s: string): number => (s || "").trim().split(/\s+/).filter(Boolean).length;

/** The level a dwell earns for a story of `words` words. null = not yet. */
export const levelForDwell = (dwellMs: number, words: number): ReadLevel | null => {
  if (dwellMs < GLIMPSE_MS) return null;
  const readMs = Math.max(GLIMPSE_MS, Math.round((words / WPM) * 60_000));
  return dwellMs >= readMs ? "read" : "glimpsed";
};

const rank = (l: ReadLevel | null) => (l === "acted" ? 3 : l === "read" ? 2 : l === "glimpsed" ? 1 : 0);

type Tracked = { edition: string; item: string; words: number; visible: boolean; dwellMs: number; reported: ReadLevel | null };

export type Witness = {
  /** A ref callback for a story's element. */
  ref: (meta: { edition: string; item: string; words: number }) => (el: Element | null) => void;
  /** The story was opened into its session (strongest evidence). */
  acted: (edition: string, item: string) => void;
  /** Reports are batched; call to send what is pending now. */
  flush: () => void;
  dispose: () => void;
};

/**
 * `post` sends a batch to the daemon. `env` is injectable for tests; the
 * defaults read the real document, observer and clock.
 */
export const createReadWitness = (
  post: (reads: ReadReport[]) => void,
  env: {
    now?: () => number;
    isVisible?: () => boolean;
    isFocused?: () => boolean;
    observe?: (el: Element, onChange: (visible: boolean) => void) => () => void;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (h: unknown) => void;
  } = {}
): Witness => {
  const now = env.now || (() => Date.now());
  const isVisible = env.isVisible || (() => typeof document === "undefined" || document.visibilityState === "visible");
  const isFocused = env.isFocused || (() => typeof document === "undefined" || document.hasFocus());
  const observe = env.observe || ((el: Element, onChange: (v: boolean) => void) => {
    if (typeof IntersectionObserver === "undefined") { onChange(true); return () => {}; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) onChange(e.isIntersecting && e.intersectionRatio >= 0.6);
    }, { threshold: [0, 0.6, 1] });
    io.observe(el);
    return () => io.disconnect();
  });
  let lastActivity = now();
  const noteActivity = () => { lastActivity = now(); };
  const activityEvents = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "scroll"];
  if (typeof window !== "undefined") for (const ev of activityEvents) window.addEventListener(ev, noteActivity, { passive: true, capture: true });

  const tracked = new Map<Element, Tracked>();
  const unobserve = new Map<Element, () => void>();
  const pending = new Map<string, ReadReport>();
  let lastTick = now();

  const queue = (r: ReadReport) => {
    const k = `${r.edition}|${r.item}`;
    const cur = pending.get(k);
    if (!cur || rank(r.level) > rank(cur.level)) pending.set(k, r);
  };
  const flush = () => {
    if (!pending.size) return;
    const batch = [...pending.values()];
    pending.clear();
    try { post(batch); } catch { /* the next batch carries it again */ }
  };
  const tick = () => {
    const t = now();
    const dt = Math.max(0, Math.min(t - lastTick, 5000)); // a frozen tab must not bank hours
    lastTick = t;
    const active = isVisible() && isFocused() && t - lastActivity < ACTIVE_WINDOW_MS;
    if (!active) return;
    for (const tr of tracked.values()) {
      if (!tr.visible) continue;
      tr.dwellMs += dt;
      const level = levelForDwell(tr.dwellMs, tr.words);
      if (level && rank(level) > rank(tr.reported)) {
        tr.reported = level;
        queue({ edition: tr.edition, item: tr.item, level, at: t });
      }
    }
  };
  const setI = env.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearI = env.clearInterval || ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const timer = setI(tick, TICK_MS);
  const flusher = setI(flush, 2000);
  const onHide = () => { if (!isVisible()) flush(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onHide);

  return {
    ref: (meta) => (el) => {
      if (!el) return;
      const existing = tracked.get(el);
      if (existing) { existing.edition = meta.edition; existing.item = meta.item; existing.words = meta.words; return; }
      const tr: Tracked = { ...meta, visible: false, dwellMs: 0, reported: null };
      tracked.set(el, tr);
      unobserve.set(el, observe(el, (v) => { tr.visible = v; }));
    },
    acted: (edition, item) => { queue({ edition, item, level: "acted", at: now() }); flush(); },
    flush,
    dispose: () => {
      flush();
      clearI(timer); clearI(flusher);
      for (const off of unobserve.values()) off();
      tracked.clear(); unobserve.clear();
      if (typeof window !== "undefined") for (const ev of activityEvents) window.removeEventListener(ev, noteActivity, { capture: true } as EventListenerOptions);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onHide);
    }
  };
};
