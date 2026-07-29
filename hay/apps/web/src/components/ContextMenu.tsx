import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
  | { kind?: "item"; label: string; onSelect: () => void; danger?: boolean; hint?: string; disabled?: boolean }
  | { kind: "separator" };

export type MenuRequest = { x: number; y: number; items: MenuItem[] } | null;

const isItem = (i: MenuItem): i is Extract<MenuItem, { kind?: "item" }> => i.kind !== "separator";

export const ContextMenu = ({ request, onClose }: { request: MenuRequest; onClose: () => void }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(0);

  // Clamp into the viewport BEFORE paint: a menu opened near an edge would
  // otherwise flash off-screen and jump.
  useLayoutEffect(() => {
    if (!request) { setPos(null); return; }
    const el = ref.current;
    const w = el?.offsetWidth || 200;
    const h = el?.offsetHeight || 200;
    const pad = 8;
    setPos({
      left: Math.max(pad, Math.min(request.x, window.innerWidth - w - pad)),
      top: Math.max(pad, Math.min(request.y, window.innerHeight - h - pad))
    });
    setActive(request.items.findIndex(isItem));
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      const idxs = request.items.map((it, i) => (isItem(it) && !it.disabled ? i : -1)).filter((i) => i >= 0);
      if (idxs.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const at = idxs.indexOf(active);
        const next = e.key === "ArrowDown"
          ? idxs[(at + 1 + idxs.length) % idxs.length]
          : idxs[(at - 1 + idxs.length) % idxs.length];
        setActive(next);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = request.items[active];
        if (item && isItem(item) && !item.disabled) { onClose(); item.onSelect(); }
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
  }, [request, active, onClose]);

  if (!request) return null;
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {request.items.map((item, i) =>
        isItem(item) ? (
          <button
            key={item.label + i}
            type="button"
            role="menuitem"
            className={"context-menu-item" + (item.danger ? " danger" : "") + (i === active ? " active" : "")}
            disabled={item.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => { onClose(); item.onSelect(); }}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ) : (
          <div key={"sep" + i} className="context-menu-separator" role="separator" />
        )
      )}
    </div>
  );
};
