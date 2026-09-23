// The rendered-math tooltip: one floating panel for the whole page, shown
// by the math link provider when the pointer rests on LaTeX in a terminal.
//
// Hover shows it; moving off hides it, unless the pointer moves INTO the
// tooltip (so a formula can be selected and copied) or the span was clicked,
// which pins the panel until Escape, another click, or a click elsewhere.
// KaTeX renders; errors render as the source in red rather than throwing.
import katex from "katex";
import "katex/dist/katex.min.css";

export type MathTip = {
  show(tex: string, display: boolean, at: { x: number; y: number }): void;
  hide(): void;
  /** Toggle the pinned state for the formula currently shown. */
  pin(): void;
  isPinned(): boolean;
  dispose(): void;
};

export const renderMathHtml = (tex: string, display: boolean): string => {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: display, output: "html", strict: "ignore" });
  } catch {
    return `<span class="math-tip-error">${tex.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`;
  }
};

const HIDE_DELAY_MS = 120;

export const createMathTip = (): MathTip => {
  const el = document.createElement("div");
  el.className = "math-tip";
  el.setAttribute("role", "tooltip");
  el.hidden = true;
  const render = document.createElement("div");
  render.className = "math-tip-render";
  const src = document.createElement("div");
  src.className = "math-tip-src";
  const hint = document.createElement("div");
  hint.className = "math-tip-hint";
  el.append(render, src, hint);
  document.body.appendChild(el);

  let pinned = false;
  let over = false;
  let current = "";
  let hideTimer = 0;

  const place = (at: { x: number; y: number }) => {
    // Below and to the right of the pointer, kept inside the viewport.
    const margin = 12;
    el.style.left = "0px";
    el.style.top = "0px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = at.x + 14;
    let y = at.y + 18;
    if (x + w + margin > window.innerWidth) x = Math.max(margin, window.innerWidth - w - margin);
    if (y + h + margin > window.innerHeight) y = Math.max(margin, at.y - h - 14);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  };

  const setHint = () => {
    hint.textContent = pinned ? "pinned — Esc or click to release" : "click to pin · select to copy";
    el.classList.toggle("pinned", pinned);
  };

  const show: MathTip["show"] = (tex, display, at) => {
    window.clearTimeout(hideTimer);
    if (pinned && tex !== current) return; // a pinned formula stays until released
    if (tex !== current) {
      current = tex;
      render.innerHTML = renderMathHtml(tex, display);
      src.textContent = tex;
    }
    setHint();
    el.hidden = false;
    place(at);
  };
  const reallyHide = () => {
    if (pinned || over) return;
    el.hidden = true;
    current = "";
  };
  const hide = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(reallyHide, HIDE_DELAY_MS);
  };
  const pin = () => {
    pinned = !pinned;
    setHint();
    if (!pinned) hide();
  };

  el.addEventListener("pointerenter", () => { over = true; window.clearTimeout(hideTimer); });
  el.addEventListener("pointerleave", () => { over = false; hide(); });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && pinned) { pinned = false; setHint(); reallyHide(); }
  };
  const onDocClick = (e: MouseEvent) => {
    if (!pinned || el.hidden) return;
    if (el.contains(e.target as Node)) return;
    // A click elsewhere releases the pin; the provider's own click toggles it
    // through pin() before this handler sees the event, so ignore those.
    if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
    pinned = false;
    setHint();
    reallyHide();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", onDocClick, true);

  return {
    show,
    hide,
    pin,
    isPinned: () => pinned,
    dispose: () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onDocClick, true);
      el.remove();
    }
  };
};

let shared: MathTip | null = null;
/** The page's one tooltip, created on first use. */
export const getMathTip = (): MathTip => {
  if (!shared) shared = createMathTip();
  return shared;
};
