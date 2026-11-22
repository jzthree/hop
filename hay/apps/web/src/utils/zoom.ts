// Zoom, the way a reader zooms: the usual levels for − / + and the keys,
// and a trackpad pinch, ⌘/Ctrl + scroll or a two-finger pinch on a phone
// that follow the fingers. Shared by the PDF reader, documents (an iframe,
// scaled) and images in Views.

export const ZOOM_STEPS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

export const clampWithin = (z: number, min: number, max: number) => Math.min(max, Math.max(min, z));

/** The next usual level up (1) or down (−1) from wherever `z` is, within [min, max]. */
export const stepWithin = (z: number, dir: 1 | -1, min: number, max: number) => {
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  return clampWithin(next ?? (dir > 0 ? max : min), min, max);
};

/** A wheel event's zoom factor: a pinch's small deltas follow the fingers; a mouse notch is one modest step. */
export const wheelFactor = (deltaY: number, deltaMode: number) => {
  const d = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-25, Math.min(25, d)) / 100);
};

/** What the zoom keys ask for: + (or =), −, 0. */
export type ZoomCommand = "in" | "out" | "reset";
export const zoomKey = (key: string): ZoomCommand | null =>
  key === "+" || key === "=" ? "in" : key === "-" || key === "_" || key === "−" ? "out" : key === "0" ? "reset" : null;

export type ZoomPoint = { x: number; y: number };
type Zoomable = { get: () => number; zoomTo: (z: number, at?: ZoomPoint) => void };

/**
 * Pinch and ⌘/Ctrl-scroll on `target` (an element, or a same-origin frame's
 * window) zoom it about the point under the fingers, in `target`'s own
 * client coordinates. Listeners are non-passive: the pinch must not also
 * zoom the page around it, or the Mac app's whole window. Returns the cleanup.
 */
export function attachZoomGestures(target: EventTarget, z: Zoomable): () => void {
  let gestureFrom: number | null = null; // Safari / the Mac app: a trackpad pinch
  let touchFrom: { d: number; z: number } | null = null; // a phone: two fingers
  const onWheel = (ev: Event) => {
    const e = ev as WheelEvent;
    // Chrome and Firefox report a trackpad pinch as a ⌃-wheel.
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (gestureFrom !== null) return;
    z.zoomTo(z.get() * wheelFactor(e.deltaY, e.deltaMode), { x: e.clientX, y: e.clientY });
  };
  type Gesture = Event & { scale: number; clientX: number; clientY: number };
  const onGestureStart = (e: Event) => { e.preventDefault(); if (!touchFrom) gestureFrom = z.get(); };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    const g = e as Gesture;
    if (gestureFrom === null || touchFrom) return;
    z.zoomTo(gestureFrom * g.scale, { x: g.clientX, y: g.clientY });
  };
  const onGestureEnd = (e: Event) => { e.preventDefault(); gestureFrom = null; };
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const onTouchStart = (ev: Event) => {
    const e = ev as TouchEvent;
    if (e.touches.length === 2) { touchFrom = { d: dist(e.touches), z: z.get() }; gestureFrom = null; }
  };
  const onTouchMove = (ev: Event) => {
    const e = ev as TouchEvent;
    if (!touchFrom || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = [e.touches[0], e.touches[1]];
    z.zoomTo(touchFrom.z * (dist(e.touches) / touchFrom.d), { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  };
  const onTouchEnd = (ev: Event) => { if ((ev as TouchEvent).touches.length < 2) touchFrom = null; };
  const active = { passive: false } as AddEventListenerOptions;
  const pairs: [string, (e: Event) => void, AddEventListenerOptions | undefined][] = [
    ["wheel", onWheel, active], ["gesturestart", onGestureStart, active], ["gesturechange", onGestureChange, active],
    ["gestureend", onGestureEnd, active], ["touchstart", onTouchStart, { passive: true }], ["touchmove", onTouchMove, active],
    ["touchend", onTouchEnd, undefined], ["touchcancel", onTouchEnd, undefined]
  ];
  for (const [type, fn, opts] of pairs) target.addEventListener(type, fn, opts);
  return () => { for (const [type, fn] of pairs) target.removeEventListener(type, fn); };
}

/** The key is someone typing (a box, an editable page), not a zoom. */
export const typingIn = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));
};

/**
 * A Views reader with a zoomable result open takes ⌘+ / ⌘− / ⌘0 from the
 * terminal's font size: over the whole window, or — beside the terminal —
 * only when the key starts inside it.
 */
export const readerTakesZoomKeys = (target: EventTarget | null) => {
  if (typeof document === "undefined") return false;
  const panel = document.querySelector<HTMLElement>(".views-panel.is-reading");
  if (!panel || !panel.querySelector("[data-zoomable]")) return false;
  return !panel.classList.contains("side") || (target instanceof Node && panel.contains(target));
};
