import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { attachZoomGestures, clampWithin, stepWithin, zoomKey, type ZoomCommand, type ZoomPoint } from "../utils/zoom";
import { ZoomTools } from "./ZoomTools";

/**
 * An image in Views: fit to the pane on opening (never blown up past its
 * own size), then zoomed about the point under the fingers — a pinch,
 * ⌘/Ctrl + scroll, − / + and the keys, a double-click between fit and
 * actual pixels — and dragged to pan. 100% is the image's own pixels.
 */
export const IMG_MAX_ZOOM = 8;

type Size = { w: number; h: number };

export const fitZoomFor = (img: Size | null, box: Size): number =>
  img && img.w > 0 && img.h > 0 && box.w > 0 && box.h > 0 ? Math.min(1, box.w / img.w, box.h / img.h) : 1;

type Props = {
  src: string;
  alt: string;
  commandRef?: MutableRefObject<((c: ZoomCommand) => void) | null>;
};

export const ZoomImage = ({ src, alt, commandRef }: Props) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [nat, setNat] = useState<Size | null>(null);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  // null: fit to the pane (and follow it as it resizes).
  const [zoom, setZoom] = useState<number | null>(null);
  const fit = fitZoomFor(nat, box);
  const z = zoom ?? fit;
  const minZoom = Math.min(fit, 0.1);
  const zoomRef = useRef(z);
  zoomRef.current = z;
  const anchorRef = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const obs = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    obs?.observe(el);
    return () => obs?.disconnect();
  }, []);

  const zoomTo = useCallback((next: number, at?: ZoomPoint) => {
    const el = scrollRef.current;
    const img = imgRef.current;
    const nz = clampWithin(next, Math.min(fitZoomFor(nat, { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 }), 0.1), IMG_MAX_ZOOM);
    if (!el || !img || Math.abs(nz - zoomRef.current) < 1e-4) return;
    const r = el.getBoundingClientRect();
    const p = at ?? { x: r.left + el.clientWidth / 2, y: r.top + el.clientHeight / 2 };
    const ir = img.getBoundingClientRect();
    anchorRef.current = {
      fx: ir.width ? (p.x - ir.left) / ir.width : 0.5,
      fy: ir.height ? (p.y - ir.top) / ir.height : 0.5,
      cx: p.x - r.left,
      cy: p.y - r.top
    };
    zoomRef.current = nz;
    setZoom(nz);
  }, [nat]);

  // After a zoom: the same point of the picture back under the fingers.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const img = imgRef.current;
    const a = anchorRef.current;
    anchorRef.current = null;
    if (!el || !img || !a) return;
    el.scrollLeft = img.offsetLeft + a.fx * img.offsetWidth - a.cx;
    el.scrollTop = img.offsetTop + a.fy * img.offsetHeight - a.cy;
  }, [z]);

  const command = useCallback((c: ZoomCommand) => {
    if (c === "reset") { setZoom(null); return; }
    zoomTo(stepWithin(zoomRef.current, c === "in" ? 1 : -1, minZoom, IMG_MAX_ZOOM));
  }, [zoomTo, minZoom]);

  useEffect(() => {
    if (!commandRef) return;
    commandRef.current = command;
    return () => { if (commandRef.current === command) commandRef.current = null; };
  }, [commandRef, command]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return attachZoomGestures(el, { get: () => zoomRef.current, zoomTo });
  }, [zoomTo]);

  // Drag to pan, when there is more picture than pane.
  const [dragging, setDragging] = useState(false);
  const onMouseDown = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el || e.button !== 0 || (e.target as HTMLElement).closest(".zoom-tools")) return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    e.preventDefault();
    const from = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
    setDragging(true);
    const move = (m: MouseEvent) => { el.scrollLeft = from.l - (m.clientX - from.x); el.scrollTop = from.t - (m.clientY - from.y); };
    const up = () => { setDragging(false); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  // Double-click: actual pixels there (or twice a small picture), and back to fit.
  const onDoubleClick = (e: React.MouseEvent) => {
    if (zoom === null) zoomTo(fit < 1 - 1e-3 ? 1 : 2, { x: e.clientX, y: e.clientY });
    else setZoom(null);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const c = e.altKey ? null : zoomKey(e.key);
    if (c) { e.preventDefault(); command(c); }
  };

  const pannable = !!nat && (nat.w * z > box.w + 1 || nat.h * z > box.h + 1);
  return (
    <div className="views-media zoom-image" data-zoomable="" onKeyDown={onKeyDown}>
      <div ref={scrollRef} tabIndex={0} aria-label={alt}
           className={"zoom-image-scroll" + (pannable ? " pannable" : "") + (dragging ? " dragging" : "")}
           onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
        <div className="zoom-image-stage">
          <img ref={imgRef} src={src} alt={alt} draggable={false}
               onLoad={(e) => {
                 const i = e.currentTarget;
                 const el = scrollRef.current;
                 if (el) setBox({ w: el.clientWidth, h: el.clientHeight });
                 setNat(i.naturalWidth > 0 && i.naturalHeight > 0 ? { w: i.naturalWidth, h: i.naturalHeight } : null);
               }}
               style={nat ? { width: nat.w * z, height: nat.h * z } : undefined} />
        </div>
      </div>
      {nat && (
        <ZoomTools zoom={z} min={minZoom} max={IMG_MAX_ZOOM}
                   onStep={(d) => command(d > 0 ? "in" : "out")} onReset={() => command("reset")} resetTitle="Fit to the pane (⌘0)" />
      )}
    </div>
  );
};
