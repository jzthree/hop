import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

// One context menu for the whole app.
//
// Right-click is a shortcut to the actions a surface already has — it must
// never be the ONLY way to reach something, and it must never invent a
// different vocabulary from the buttons beside it. So this renders the same
// items a surface's visible affordances expose, in the same order, with the
// same words.
//
// Deliberately NOT applied to the terminal: there, right-click already means
// something (paste on Linux/Windows, the native copy/paste menu everywhere),
// and mouse-reporting apps — Claude, vim, less — receive button events the
// moment tracking is on. Overriding it would either steal a click the app
// asked for or replace a menu people rely on with a worse one.

export type MenuItem =
  | {
      kind?: "item"; label: string; onSelect?: () => void; danger?: boolean; hint?: string; disabled?: boolean;
      /** A tick: this is the current choice. */
      checked?: boolean;
      /** A submenu, opened by hovering or →. */
      items?: MenuItem[];
    }
  | { kind: "separator" };

export type MenuRequest = { x: number; y: number; items: MenuItem[]; title?: string; subtitle?: string } | null;

const isItem = (i: MenuItem): i is Extract<MenuItem, { kind?: "item" }> => i.kind !== "separator";
const enabled = (items: MenuItem[]) => items.map((it, i) => (isItem(it) && !it.disabled ? i : -1)).filter((i) => i >= 0);

// While a menu is up it is modal for the keyboard: the surfaces underneath
// (a page's Esc and arrows, the wall's navigation) ask this first.
let openMenus = 0;
// (A name being edited in place from a menu counts: its Esc is its own.)
export const menuIsOpen = () => openMenus > 0 || !!document.activeElement?.closest?.(".rail-renaming");

// How long the pointer may cross a sibling on its way into a submenu.
const SUB_CLOSE_MS = 180;

export const ContextMenu = ({ request, onClose }: { request: MenuRequest; onClose: () => void }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const closeTimer = useRef(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(0);
  // The open submenu (an index in the items), its place, and the keyboard's
  // place inside it (-1: the keyboard is still on the parent).
  const [sub, setSub] = useState<number | null>(null);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  const [subActive, setSubActive] = useState(-1);

  useEffect(() => {
    if (!request) return;
    openMenus += 1;
    return () => { openMenus -= 1; };
  }, [!request]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clamp into the viewport BEFORE paint: a menu opened near an edge would
  // otherwise flash off-screen and jump.
  useLayoutEffect(() => {
    setSub(null);
    setSubActive(-1);
    if (!request) { setPos(null); return; }
    const el = mainRef.current;
    const w = el?.offsetWidth || 200;
    const h = el?.offsetHeight || 200;
    const pad = 8;
    setPos({
      left: Math.max(pad, Math.min(request.x, window.innerWidth - w - pad)),
      top: Math.max(pad, Math.min(request.y, window.innerHeight - h - pad))
    });
    setActive(request.items.findIndex(isItem));
  }, [request]);

  // A submenu sits beside its item, on whichever side has room.
  useLayoutEffect(() => {
    if (sub === null) { setSubPos(null); return; }
    const parent = itemRefs.current[sub]?.getBoundingClientRect();
    const el = subRef.current;
    if (!parent || !el) return;
    const w = el.offsetWidth, h = el.offsetHeight, pad = 8;
    const left = parent.right + w + pad <= window.innerWidth ? parent.right + 2 : Math.max(pad, parent.left - w - 2);
    setSubPos({ left, top: Math.max(pad, Math.min(parent.top - 6, window.innerHeight - h - pad)) });
  }, [sub]);

  const subItems = (() => {
    const it = sub !== null ? request?.items[sub] : null;
    return it && isItem(it) ? it.items ?? null : null;
  })();
  const openSub = (i: number, withKeyboard: boolean) => {
    window.clearTimeout(closeTimer.current);
    setSub(i);
    const it = request?.items[i];
    setSubActive(withKeyboard && it && isItem(it) && it.items ? (enabled(it.items)[0] ?? -1) : -1);
  };
  const choose = (item: MenuItem | undefined) => {
    if (!item || !isItem(item) || item.disabled || item.items) return;
    onClose();
    item.onSelect?.();
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        if (sub !== null) { setSub(null); setSubActive(-1); } else onClose();
        return;
      }
      const inSub = sub !== null && subActive >= 0 && !!subItems;
      const list = inSub ? subItems! : request.items;
      const idxs = enabled(list);
      if (idxs.length === 0) return;
      const at = inSub ? subActive : active;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const from = idxs.indexOf(at);
        const next = e.key === "ArrowDown"
          ? idxs[(from + 1 + idxs.length) % idxs.length]
          : idxs[(from - 1 + idxs.length) % idxs.length];
        if (inSub) setSubActive(next);
        else { setActive(next); setSub(null); }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const item = request.items[active];
        if (!inSub && item && isItem(item) && item.items && !item.disabled) openSub(active, true);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (sub !== null) { setSub(null); setSubActive(-1); }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = list[at];
        if (!inSub && item && isItem(item) && item.items && !item.disabled) openSub(active, true);
        else choose(item);
      }
    };
    // Capture so a menu click never also reaches the surface underneath.
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [request, active, sub, subActive, subItems, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!request) return null;
  const anyTick = (items: MenuItem[]) => items.some((it) => isItem(it) && it.checked !== undefined);
  const row = (item: Extract<MenuItem, { kind?: "item" }>, i: number, isActive: boolean, ticks: boolean, extra: Partial<React.ComponentProps<"button">>) => (
    <button
      key={item.label + i}
      type="button"
      role="menuitem"
      aria-haspopup={item.items ? "menu" : undefined}
      aria-checked={item.checked}
      className={"context-menu-item" + (item.danger ? " danger" : "") + (isActive ? " active" : "")}
      disabled={item.disabled}
      {...extra}
    >
      {ticks && <span className="context-menu-tick" aria-hidden="true">{item.checked ? "✓" : ""}</span>}
      <span className="context-menu-label">{item.label}</span>
      {item.hint && <kbd>{item.hint}</kbd>}
      {item.items && <span className="context-menu-arrow" aria-hidden="true">›</span>}
    </button>
  );
  const parts = (items: MenuItem[], render: (it: Extract<MenuItem, { kind?: "item" }>, i: number) => React.ReactNode) =>
    items.map((item, i) => (isItem(item) ? render(item, i) : <div key={"sep" + i} className="context-menu-separator" role="separator" />));

  return (
    <div ref={ref} className="context-menu-root" onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={mainRef}
        className="context-menu"
        role="menu"
        aria-label={request.title}
        style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      >
        {request.title && (
          <div className="context-menu-head">
            <div className="context-menu-head-title">{request.title}</div>
            {request.subtitle && <div className="context-menu-head-sub" title={request.subtitle}><bdi>{request.subtitle}</bdi></div>}
          </div>
        )}
        {parts(request.items, (item, i) => row(item, i, i === active, anyTick(request.items), {
          ref: (el: HTMLButtonElement | null) => { itemRefs.current[i] = el; },
          onMouseEnter: () => {
            setActive(i);
            setSubActive(-1);
            window.clearTimeout(closeTimer.current);
            if (item.items && !item.disabled) openSub(i, false);
            else if (sub !== null) closeTimer.current = window.setTimeout(() => setSub(null), SUB_CLOSE_MS);
          },
          onClick: () => { if (item.items) openSub(i, false); else choose(item); }
        }))}
      </div>
      {subItems && (
        <div
          ref={subRef}
          className="context-menu context-menu-sub"
          role="menu"
          style={subPos ? { left: subPos.left, top: subPos.top } : { left: -9999, top: -9999 }}
          onMouseEnter={() => { window.clearTimeout(closeTimer.current); if (sub !== null) setActive(sub); }}
        >
          {parts(subItems, (item, i) => row(item, i, i === subActive, anyTick(subItems), {
            onMouseEnter: () => setSubActive(i),
            onClick: () => choose(item)
          }))}
        </div>
      )}
    </div>
  );
};
