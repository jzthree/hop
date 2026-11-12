import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

/**
 * hop's own PDF reader. The browser's PDF viewer, iframed, can't be zoomed
 * in the Mac app (a pinch magnified the whole window) or on a phone (an
 * iframed PDF is one still image there). This one draws the pages itself
 * with pdf.js and zooms the way a reader should: a trackpad pinch,
 * ⌘/Ctrl + scroll, a two-finger pinch on a phone, the − / + buttons and
 * keys — always about the point under the fingers. Text stays selectable;
 * a drag on the page's blank paper pans it.
 */

type Pdfjs = typeof import("pdfjs-dist");
let pdfjsLoad: Promise<Pdfjs> | null = null;
// Loaded the first time a PDF opens, not with the app.
const loadPdfjs = () =>
  (pdfjsLoad ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  }));

// 100% is the page at its printed size: a PDF point is 1/72 in, a CSS px 1/96.
const CSS_UNITS = 96 / 72;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 6;
// Opening, and "Fit": the page across the pane, but no bigger than this.
const FIT_MAX = 1.5;
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];
const PAD = 16; // px around the pages
const GAP = 12; // px between pages
// A canvas this many pixels or more is drawn coarser (memory; Safari caps one).
const MAX_CANVAS_PX = typeof navigator !== "undefined" && /iPhone|iPad|Android/.test(navigator.userAgent) ? 5_000_000 : 16_000_000;
// Sharp pages this long after the zoom stops (until then the last drawing stretches).
const SETTLE_MS = 160;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
export const stepZoom = (z: number, dir: 1 | -1) => {
  const next = dir > 0 ? STEPS.find((s) => s > z + 0.001) : [...STEPS].reverse().find((s) => s < z - 0.001);
  return next ?? (dir > 0 ? MAX_ZOOM : MIN_ZOOM);
};
/** A wheel event's zoom factor: a pinch's small deltas follow the fingers; a mouse notch is one modest step. */
export const wheelFactor = (deltaY: number, deltaMode: number) => {
  const d = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-25, Math.min(25, d)) / 100);
};

type Size = { w: number; h: number };
type Anchor = { page: number; fx: number; fy: number; cx: number; cy: number };

type Props = {
  src: string;
  title?: string;
  /** pdf.js could not read it: the caller shows the browser's own viewer. */
  onFail?: () => void;
};

export const PdfReader = ({ src, title, onFail }: Props) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [lib, setLib] = useState<Pdfjs | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  // What the canvases are drawn at: the zoom, once it has settled.
  const [drawZoom, setDrawZoom] = useState(1);
  const [pageNo, setPageNo] = useState(1);
  const anchorRef = useRef<Anchor | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Open the document.
  useEffect(() => {
    let dead = false;
    let task: { destroy: () => Promise<void> } | null = null;
    loadPdfjs()
      .then((pdfjs) => {
        if (dead) return;
        setLib(pdfjs);
        const t = pdfjs.getDocument({ url: src, withCredentials: true });
        task = t;
        return t.promise.then(async (d) => {
          if (dead) return;
          const first = (await d.getPage(1)).getViewport({ scale: 1 });
          const all: Size[] = Array.from({ length: d.numPages }, () => ({ w: first.width, h: first.height }));
          setDoc(d);
          setSizes(all);
          // Every page's own size (a landscape figure among portrait pages).
          for (let i = 2; i <= d.numPages && !dead; i++) {
            const v = (await d.getPage(i)).getViewport({ scale: 1 });
            all[i - 1] = { w: v.width, h: v.height };
            if (i === d.numPages || i % 20 === 0) setSizes([...all]);
          }
        });
      })
      .catch(() => {
        if (!dead) { setFailed(true); onFail?.(); }
      });
    return () => { dead = true; void task?.destroy(); };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  const widest = sizes.reduce((m, s) => Math.max(m, s.w), 0);
  const fitZoom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !widest) return 1;
    return clampZoom(Math.min(FIT_MAX, (el.clientWidth - 2 * PAD) / (widest * CSS_UNITS)));
  }, [widest]);

  // Fit: on open, and as the pane resizes, until the person zooms.
  useLayoutEffect(() => {
    if (!fit || !widest) return;
    const apply = () => { const z = fitZoom(); setZoom(z); };
    apply();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, widest, fitZoom]);

  // Draw sharp once the zoom settles.
  useEffect(() => {
    const t = window.setTimeout(() => setDrawZoom(zoom), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [zoom]);

  /** Where a point is on its page, to keep it under the fingers. */
  const anchorAt = (clientX: number, clientY: number): Anchor | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const pages = el.querySelectorAll<HTMLElement>(".pdf-page");
    let best: { i: number; d: number } | null = null;
    pages.forEach((p, i) => {
      const pr = p.getBoundingClientRect();
      const d = clientY < pr.top ? pr.top - clientY : clientY > pr.bottom ? clientY - pr.bottom : 0;
      if (!best || d < best.d) best = { i, d };
    });
    if (!best) return null;
    const pr = pages[(best as { i: number }).i].getBoundingClientRect();
    return {
      page: (best as { i: number }).i,
      fx: (clientX - pr.left) / pr.width,
      fy: (clientY - pr.top) / pr.height,
      cx: clientX - r.left,
      cy: clientY - r.top
    };
  };

  const zoomTo = useCallback((next: number, at?: { x: number; y: number }) => {
    const el = scrollRef.current;
    const z = clampZoom(next);
    if (!el || Math.abs(z - zoomRef.current) < 1e-4) return;
    const r = el.getBoundingClientRect();
    const p = at ?? { x: r.left + el.clientWidth / 2, y: r.top + el.clientHeight / 2 };
    anchorRef.current = anchorAt(p.x, p.y);
    setFit(false);
    setZoom(z);
  }, []);

  // After a zoom: the same point of the same page back under the fingers.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchorRef.current;
    anchorRef.current = null;
    if (!el || !a) return;
    const page = el.querySelectorAll<HTMLElement>(".pdf-page")[a.page];
    if (!page) return;
    el.scrollLeft = page.offsetLeft + a.fx * page.offsetWidth - a.cx;
    el.scrollTop = page.offsetTop + a.fy * page.offsetHeight - a.cy;
  }, [zoom]);

  // The gestures. Listeners are native (non-passive): a pinch must not
  // also zoom the page around the reader, or the Mac app's whole window.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let gestureFrom: number | null = null; // Safari / the Mac app: a trackpad pinch
    let touchFrom: { d: number; z: number } | null = null; // a phone: two fingers
    const onWheel = (e: WheelEvent) => {
      // Chrome and Firefox report a trackpad pinch as a ⌃-wheel.
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (gestureFrom !== null) return;
      zoomTo(zoomRef.current * wheelFactor(e.deltaY, e.deltaMode), { x: e.clientX, y: e.clientY });
    };
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => { e.preventDefault(); if (!touchFrom) gestureFrom = zoomRef.current; };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Gesture;
      if (gestureFrom === null || touchFrom) return;
      zoomTo(gestureFrom * g.scale, { x: g.clientX, y: g.clientY });
    };
    const onGestureEnd = (e: Event) => { e.preventDefault(); gestureFrom = null; };
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) { touchFrom = { d: dist(e.touches), z: zoomRef.current }; gestureFrom = null; }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touchFrom || e.touches.length !== 2) return;
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      zoomTo(touchFrom.z * (dist(e.touches) / touchFrom.d), { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    };
    const onTouchEnd = (e: TouchEvent) => { if (e.touches.length < 2) touchFrom = null; };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart, { passive: false } as AddEventListenerOptions);
    el.addEventListener("gesturechange", onGestureChange, { passive: false } as AddEventListenerOptions);
    el.addEventListener("gestureend", onGestureEnd, { passive: false } as AddEventListenerOptions);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [zoomTo]);

  // Drag on the paper (not on its words, which select) to pan.
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onMouseDown = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    const target = e.target as HTMLElement;
    if (!el || e.button !== 0 || target.closest(".textLayer span, .pdf-tools, a")) return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
    setDragging(true);
    const move = (m: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      el.scrollLeft = d.l - (m.clientX - d.x);
      el.scrollTop = d.t - (m.clientY - d.y);
    };
    const up = () => {
      drag.current = null;
      setDragging(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable='true']")) return;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomTo(stepZoom(zoomRef.current, 1)); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomTo(stepZoom(zoomRef.current, -1)); }
    else if (e.key === "0" && !e.altKey) { e.preventDefault(); setFit(true); }
  };

  // Which page is in view.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 3;
    const pages = el.querySelectorAll<HTMLElement>(".pdf-page");
    let n = 1;
    pages.forEach((p, i) => { if (p.offsetTop <= mid) n = i + 1; });
    setPageNo(n);
  };

  if (failed) return null;
  const pct = Math.round(zoom * 100);
  return (
    <div className="pdf-reader" onKeyDown={onKeyDown}>
      <div
        ref={scrollRef}
        className={"pdf-scroll" + (dragging ? " dragging" : "")}
        tabIndex={0}
        role="document"
        aria-label={title || "PDF"}
        onMouseDown={onMouseDown}
        onScroll={onScroll}
      >
        {!doc && <div className="pdf-loading">Opening…</div>}
        {doc && lib && (
          <div className="pdf-pages" style={{ padding: PAD, gap: GAP }}>
            {sizes.map((s, i) => (
              <PdfPage key={i} doc={doc} lib={lib} index={i} size={s} zoom={zoom} drawZoom={drawZoom} root={scrollRef} />
            ))}
          </div>
        )}
      </div>
      {doc && (
        <div className="pdf-tools" role="toolbar" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" title="Zoom out (−)" disabled={zoom <= MIN_ZOOM + 1e-3} onClick={() => zoomTo(stepZoom(zoom, -1))}>−</button>
          <button type="button" className="pdf-pct" aria-label={`Zoom ${pct}%, fit to the pane`} title="Fit to the pane (0)" onClick={() => setFit(true)}>{pct}%</button>
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={zoom >= MAX_ZOOM - 1e-3} onClick={() => zoomTo(stepZoom(zoom, 1))}>+</button>
          <span className="pdf-pageno" aria-live="polite">{pageNo} / {doc.numPages}</span>
        </div>
      )}
    </div>
  );
};

type PageProps = {
  doc: PDFDocumentProxy;
  lib: Pdfjs;
  index: number;
  size: Size;
  zoom: number;
  drawZoom: number;
  root: React.RefObject<HTMLDivElement | null>;
};

/** One page: sized at the live zoom, drawn (and its text laid) only near view. */
const PdfPage = ({ doc, lib, index, size, zoom, drawZoom, root }: PageProps) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  const pageRef = useRef<PDFPageProxy | null>(null);
  const textLayer = useRef<{ update: (o: { viewport: unknown }) => void; cancel: () => void } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: "100% 50%" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  // Draw it (again) at the settled zoom; let it go when far from view.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!near) {
      canvas.width = 0; canvas.height = 0;
      textLayer.current?.cancel(); textLayer.current = null;
      if (textRef.current) textRef.current.replaceChildren();
      return;
    }
    let dead = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = pageRef.current ?? (pageRef.current = await doc.getPage(index + 1));
      if (dead) return;
      const viewport = page.getViewport({ scale: drawZoom * CSS_UNITS });
      let ratio = window.devicePixelRatio || 1;
      const px = viewport.width * viewport.height * ratio * ratio;
      if (px > MAX_CANVAS_PX) ratio *= Math.sqrt(MAX_CANVAS_PX / px);
      const off = document.createElement("canvas");
      off.width = Math.floor(viewport.width * ratio);
      off.height = Math.floor(viewport.height * ratio);
      task = page.render({ canvas: off, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      try { await task.promise; } finally { if (dead) { off.width = 0; off.height = 0; } }
      if (dead) return;
      // Swap in the finished drawing: no blank flash while it redraws.
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext("2d")?.drawImage(off, 0, 0);
      // Safari is slow to give a canvas's memory back: give it now.
      off.width = 0; off.height = 0;
      const text = textRef.current;
      if (!text) return;
      if (textLayer.current) textLayer.current.update({ viewport });
      else {
        const tl = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
        textLayer.current = tl as unknown as typeof textLayer.current;
        await tl.render().catch(() => {});
      }
    })().catch(() => { /* a cancelled draw */ });
    return () => { dead = true; task?.cancel(); };
  }, [near, drawZoom, doc, lib, index]);

  useEffect(() => () => { textLayer.current?.cancel(); pageRef.current?.cleanup(); }, []);

  const w = Math.floor(size.w * zoom * CSS_UNITS);
  const h = Math.floor(size.h * zoom * CSS_UNITS);
  return (
    <div
      ref={ref}
      className="pdf-page"
      data-page={index + 1}
      style={{ width: w, height: h, ["--total-scale-factor" as string]: String(zoom * CSS_UNITS), ["--scale-round-x" as string]: "1px", ["--scale-round-y" as string]: "1px" }}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <div ref={textRef} className="textLayer" />
    </div>
  );
};
