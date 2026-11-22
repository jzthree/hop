import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { attachZoomGestures, clampWithin, stepWithin, typingIn, zoomKey, type ZoomCommand, type ZoomPoint } from "../utils/zoom";
import { ZoomTools } from "./ZoomTools";

/**
 * A document in Views (a write-up, a page, a notebook, a live server),
 * zoomable the way a browser's ⌘+ zooms a page: the frame is laid out
 * 1/zoom as wide and scaled back up, so the text grows and rewraps, and the
 * page — which never knows — keeps its clicks, hovers and plots right.
 * WebKit (the Mac app) and Chrome draw the scaled text sharp.
 *
 * Pages hop serves itself are this origin: there a pinch, ⌘-scroll and the
 * keys work inside the page too. Sandboxed pages (an agent's own files) and
 * other origins zoom with the buttons and the keys from outside the page.
 */
export const DOC_MIN_ZOOM = 0.5;
export const DOC_MAX_ZOOM = 3;
const KEY = "hop_views_doc_zoom_v1";

export const loadDocZoom = (): number => {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? clampWithin(v, DOC_MIN_ZOOM, DOC_MAX_ZOOM) : 1;
  } catch { return 1; }
};
const saveDocZoom = (z: number) => {
  try { if (Math.abs(z - 1) < 1e-4) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(z)); } catch { /* private mode */ }
};

type Props = {
  src: string;
  title: string;
  sandbox?: string;
  /** Documents share one zoom, remembered (a reader who wants it bigger wants it bigger everywhere); a live app starts at 100%. */
  remember?: boolean;
  /** Bare + − 0 inside the page zoom it (a document); an app keeps its own keys and gets only ⌘/Ctrl ones. */
  bareKeys?: boolean;
  commandRef?: MutableRefObject<((c: ZoomCommand) => void) | null>;
};

export const ZoomFrame = ({ src, title, sandbox, remember = true, bareKeys = true, commandRef }: Props) => {
  const [zoom, setZoom] = useState(() => (remember ? loadDocZoom() : 1));
  const zoomRef = useRef(zoom);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // What is under the fingers, to put back there once the page has rewrapped:
  // the element and where in it (or, over blank margin, where in the whole
  // page), and the spot on screen (sx, sy: frame pixels at zoom 1).
  const anchorRef = useRef<{ el: Element | null; fx: number; fy: number; sx: number; sy: number } | null>(null);

  /** The frame's window when this page can reach it (same origin, not sandboxed). */
  const frameWindow = () => {
    try {
      const w = frameRef.current?.contentWindow ?? null;
      return w && w.document ? w : null;
    } catch { return null; }
  };

  const zoomTo = useCallback((next: number, at?: ZoomPoint) => {
    const z = clampWithin(next, DOC_MIN_ZOOM, DOC_MAX_ZOOM);
    const prev = zoomRef.current;
    if (Math.abs(z - prev) < 1e-4) return;
    const w = frameWindow();
    // `at` is in the page's own coordinates, so on screen it sits at at·prev.
    // A pinch is many small zooms: the first one's anchor holds until applied.
    if (w && at && !anchorRef.current) {
      try {
        const d = w.document;
        const hit = d.elementFromPoint(at.x, at.y);
        const el = hit && hit !== d.documentElement && hit !== d.body ? hit : null;
        const r = el?.getBoundingClientRect();
        const root = d.documentElement;
        anchorRef.current = el && r && r.width > 0 && r.height > 0
          ? { el, fx: (at.x - r.left) / r.width, fy: (at.y - r.top) / r.height, sx: at.x * prev, sy: at.y * prev }
          : { el: null, fx: (w.scrollX + at.x) / Math.max(1, root.scrollWidth), fy: (w.scrollY + at.y) / Math.max(1, root.scrollHeight), sx: at.x * prev, sy: at.y * prev };
      } catch { anchorRef.current = null; }
    }
    zoomRef.current = z;
    setZoom(z);
    if (remember) saveDocZoom(z);
  }, [remember]);

  const command = useCallback((c: ZoomCommand) => {
    if (c === "reset") zoomTo(1);
    else zoomTo(stepWithin(zoomRef.current, c === "in" ? 1 : -1, DOC_MIN_ZOOM, DOC_MAX_ZOOM));
  }, [zoomTo]);

  useEffect(() => {
    if (!commandRef) return;
    commandRef.current = command;
    return () => { if (commandRef.current === command) commandRef.current = null; };
  }, [commandRef, command]);

  // What was under the fingers back under them, once the page has rewrapped
  // at its new width (the next frame; a pinch's later zooms wait for it).
  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const id = requestAnimationFrame(() => {
      const a = anchorRef.current;
      anchorRef.current = null;
      const w = frameWindow();
      if (!a || !w) return;
      const z = zoomRef.current;
      const cx = a.sx / z, cy = a.sy / z;
      try {
        if (a.el && a.el.isConnected) {
          const r = a.el.getBoundingClientRect();
          w.scrollBy(r.left + a.fx * r.width - cx, r.top + a.fy * r.height - cy);
        } else {
          const root = w.document.documentElement;
          w.scrollTo(a.fx * root.scrollWidth - cx, a.fy * root.scrollHeight - cy);
        }
      } catch { /* navigated away */ }
    });
    return () => cancelAnimationFrame(id);
  }, [zoom]);

  // Inside the page (when it is ours to reach): the pinch, ⌘-scroll and keys.
  // Again on every load: a link followed inside the frame is a new page.
  const detachRef = useRef<(() => void) | null>(null);
  const onLoad = () => {
    detachRef.current?.();
    detachRef.current = null;
    const w = frameWindow();
    if (!w) return;
    const off = attachZoomGestures(w, { get: () => zoomRef.current, zoomTo });
    const onKey = (e: KeyboardEvent) => {
      const c = zoomKey(e.key);
      if (!c || e.altKey) return;
      if (!(e.metaKey || e.ctrlKey) && (!bareKeys || typingIn(e.target))) return;
      e.preventDefault();
      e.stopPropagation();
      command(c);
    };
    w.addEventListener("keydown", onKey, true);
    detachRef.current = () => { off(); try { w.removeEventListener("keydown", onKey, true); } catch { /* gone */ } };
  };
  useEffect(() => () => { detachRef.current?.(); detachRef.current = null; }, []);

  // Over the frame's edge and the tools: a pinch zooms the page, not the window.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    return attachZoomGestures(el, { get: () => zoomRef.current, zoomTo: (z) => zoomTo(z) });
  }, [zoomTo]);

  const scaled = Math.abs(zoom - 1) > 1e-4;
  return (
    <div className="zoom-frame" data-zoomable="" ref={wrapRef}>
      <div className="zoom-frame-box"
           style={scaled ? { width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: `scale(${zoom})` } : undefined}>
        <iframe ref={frameRef} className="views-frame" src={src} title={title} sandbox={sandbox} onLoad={onLoad} />
      </div>
      <ZoomTools zoom={zoom} min={DOC_MIN_ZOOM} max={DOC_MAX_ZOOM}
                 onStep={(d) => command(d > 0 ? "in" : "out")} onReset={() => command("reset")} resetTitle="Actual size (⌘0)" />
    </div>
  );
};
