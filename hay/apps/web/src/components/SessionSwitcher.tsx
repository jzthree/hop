import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { attachScrollFlywheel } from "../utils/scrollFlywheel";
import { ContextMenu, type MenuRequest } from "./ContextMenu";
import { collectTerminalMatches, selectTerminalMatch } from "../utils/terminalSearch";
import {
  buildSwitcherModel,
  filterSessionsByOrigin,
  projectKey,
  relativeTime,
  type SessionOriginScope,
  type SwitcherFolder,
  type SwitcherSession,
  type SwitcherSortMode
} from "../utils/switcherModel";
import { scanKeyboardProtocol } from "../utils/keyboardProtocol";

// Full-screen, in-app session switcher (mobile-first). Hot sessions — current,
// attention, most recent — are preview cards; the tail is compact rows grouped
// by project. Long-press (or the ⋯ button) opens a per-session action sheet.
// Previews are fetched only for hero cards, only while the switcher is open
// and the tab visible, seeded from a cache so reopening paints instantly.

const LONG_PRESS_MS = 450;
const PREVIEW_REFRESH_MS = 5000;
const FILTER_THRESHOLD = 10;

// Zoom ladder: one +/− press per step. Each level sets the grid's minimum
// tile width, the preview window height, and the preview font size (the
// focused terminal inherits the same metrics so preview → terminal stays a
// swap in place). How much of the ladder is REACHABLE depends on the
// viewport: the first level whose tiles lay out as a single full-width
// column is the ceiling — past it "+" has nothing left to grow into.
const ZOOM_LEVELS = [
  { min: 100, h: "40px", fs: "4px" },
  { min: 120, h: "56px", fs: "5px" }, // old S
  { min: 150, h: "84px", fs: "6px" }, // old M
  { min: 210, h: "130px", fs: "7.5px" },
  { min: 300, h: "200px", fs: "9.5px" }, // old L
  { min: 420, h: "300px", fs: "11px" }, // old XL — interactive from here up
  { min: 560, h: "min(46vh, 480px)", fs: "11px" },
  { min: 720, h: "min(56vh, 640px)", fs: "12px" },
  { min: 900, h: "min(66vh, 820px)", fs: "13px" }
];
// From this level up the type is legible enough to work in: clicking a tile
// focuses a real terminal in place instead of switching to the session.
const INTERACTIVE_ZOOM = 5;
const GRID_GAP = 10;
const DEFAULT_ZOOM = 2;
// Old persisted hay_tile_size values map onto the ladder.
const LEGACY_ZOOM: Record<string, number> = { s: 1, m: 2, l: 4, xl: 5 };

type Props = {
  open: boolean;
  sessions: SwitcherSession[];
  currentRoom: string | null;
  onClose: () => void;
  // False when the switcher IS the page (hop's landing/hub mode): hides the ✕
  // and disables Escape/backdrop dismissal — there is nothing behind to close to.
  dismissable?: boolean;
  onSwitch: (session: SwitcherSession) => void;
  onRefresh: () => void;
  onNotice: (message: string) => void;
  // Mobile-hub quick actions: the switcher is the front page there, so the
  // few one-tap-hot actions (keyboard, find) and the settings drawer hang off
  // its header. Omitted callbacks render no button.
  // WebSocket base + identity/theme for the XL focused tile (the one
  // interactive terminal in the wall). Absent => XL stays previews-only.
  // Interacting with a tile makes THAT session current: the chip moves, and
  // closing the wall lands full-screen in the terminal you were typing in.
  onFocusSession?: (session: SwitcherSession) => void;
  // User-authored folders (Manual mode only). Server-owned, so they follow
  // you across devices — unlike the drag ORDER, which is per-client taste.
  folders?: SwitcherFolder[];
  tileWsBase?: string;
  userName?: string;
  terminalTheme?: object;
  onOpenSettings?: () => void;
  onToggleKeyboard?: () => void;
  onFind?: () => void;
};

type Sheet = {
  session: SwitcherSession;
  mode: "menu" | "rename";
  // Viewport point the menu anchors to — the ... button or the long-press
  // finger position. A bottom sheet made the thumb travel the whole screen
  // for actions about the element it was already touching.
  anchor: { x: number; y: number };
};

// ── FOCUS RULES ───────────────────────────────────────────────────────────
// Focus moves only on these explicit actions, and nothing else:
//   → a tile's terminal:  clicking its terminal area, or ⌘⏎ (which blurs the
//                         filter first — the command legitimizes the steal)
//   → the filter box:     clicking it, ⌘K (open), ⌘F (unless a live tile
//                         owns the keyboard — then ⌘F is find-in-that-tile,
//                         scope follows focus), or ↑ from the top row
//   → the full screen:    opening a session (the wall closes)
// Enforcement, not convention: a terminal REFUSES to take focus while any
// text input holds it (stealOk below), and editing the filter drops any live
// tile back to watch — so re-renders, remounts, reconnects, and polls can
// never move the cursor. Everything else in this file must stay focus-inert.
export const terminalMayTakeFocus = () => {
  const ae = document.activeElement as HTMLElement | null;
  if (!ae || ae === document.body) return true;
  if (ae.closest?.(".switcher-live-tile, .switcher-focus-tile")) return true;
  return !ae.matches?.("input, textarea, [contenteditable]");
};

const sessionKey = (s: SwitcherSession) => s.internalName || s.name;

// A restored session can come back sitting on Claude's own "resume from
// summary / full session" question — running, but waiting on a keypress that
// only the human should answer (the full-session choice can eat a large share
// of a usage limit). Restore reports it as up, so without this it looks live
// while nothing moves. Detected from the preview text the wall already has,
// so it costs no extra request.
const RESUME_PROMPT_RE = /Resume from summary|Resuming the full session|Don't ask me again/i;
const waitingOnUser = (frame?: PreviewFrame) => !!frame && RESUME_PROMPT_RE.test(frame.text);

// One styled span of preview text. The daemon reads these straight off the
// room's grid (a real terminal), so a tile shows the session's ACTUAL colors
// instead of the flattened text previews used before.
type PreviewRun = { t: string; f?: string; b?: string; d?: 1; o?: 1; i?: 1 };
type PreviewFrame = { text: string; color?: PreviewRun[][] | null; cols?: number; rows?: number };

// Base font previews render at before scaling. The scale factor normalizes
// the on-screen size, so this only affects crispness of the downscale.
const PREVIEW_BASE_FS = 12;
// Fewest columns a tile will reflow a session to. Below this a Claude
// composer and code blocks start wrapping into noise, so the font shrinks
// instead of the session getting narrower.
const MIN_TILE_COLS = 76;

// A person, drawn — not an eye. A viewer is someone who is HERE, and the
// emoji eye read as surveillance rather than company.
const PersonGlyph = () => (
  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
    <circle cx="6" cy="3.4" r="2.4" fill="currentColor" />
    <path d="M1.4 11.2c0-2.6 2.1-4.2 4.6-4.2s4.6 1.6 4.6 4.2z" fill="currentColor" />
  </svg>
);
const PREVIEW_BASE_LH = PREVIEW_BASE_FS * 1.3;
// Measured advance width of one monospace cell at the base font — resolved
// lazily because the terminal font stack loads with the page.
let previewCharW = 0;
if (typeof document !== "undefined") {
  document.fonts?.ready?.then(() => { previewCharW = 0; }).catch(() => { /* no Font API */ });
}
const measurePreviewCharW = () => {
  if (previewCharW) return previewCharW;
  const el = document.createElement("span");
  el.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-size:${PREVIEW_BASE_FS}px;line-height:1`;
  el.style.fontFamily = "var(--font-terminal)";
  el.textContent = "0".repeat(100);
  document.body.appendChild(el);
  previewCharW = el.getBoundingClientRect().width / 100 || PREVIEW_BASE_FS * 0.6;
  el.remove();
  return previewCharW;
};

// ONE font for the whole wall at a given zoom, derived from the box width —
// never from any session's geometry. Both live tiles and static previews use
// this, which is what makes the wall read as one surface instead of a
// patchwork of magnifications. Sessions wider than the tile crop on the
// right; narrower ones leave margin. Apparent glyph size never varies.
const tileFontFor = (boxW: number) =>
  Math.max(6.5, Math.min(13, boxW / (MIN_TILE_COLS * (measurePreviewCharW() / PREVIEW_BASE_FS))));

// One observer sizes every preview box; per-tile observers would be waste.
const previewScaleObserver = typeof ResizeObserver !== "undefined"
  ? new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.target as HTMLElement;
        const inner = box.firstElementChild as HTMLElement | null;
        if (!inner) continue;
        const fs2 = tileFontFor(box.clientWidth);
        inner.style.fontSize = fs2 + "px";
        inner.style.lineHeight = Math.round(fs2 * 1.3) + "px";
      }
    })
  : null;

// The WHOLE screen, scaled to fit the tile — the same geometry the focused
// terminal uses (observe-at-active-size, scaled), which is what makes the
// preview → terminal swap land on the same pixels instead of jumping from a
// clipped corner to a fitted screen. Rows are padded to the grid height so
// blank bottom rows keep the aspect honest.
const ScaledScreen = ({ frame }: { frame: PreviewFrame }) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const rows = frame.rows || 24;
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !previewScaleObserver) return;
    previewScaleObserver.observe(box);
    return () => previewScaleObserver.unobserve(box);
  }, []);
  const lines = frame.color || [];
  const padded = lines.length < rows ? [...lines, ...Array.from({ length: rows - lines.length }, () => [] as PreviewRun[])] : lines;
  return (
    <div className="switcher-preview-scalebox" ref={boxRef}>
      <div
        className="switcher-preview-screen"
        style={{ fontSize: PREVIEW_BASE_FS, lineHeight: `${PREVIEW_BASE_LH}px` }}
      >
        {renderPreviewRuns(padded)}
      </div>
    </div>
  );
};

const renderPreviewRuns = (lines: PreviewRun[][]) =>
  lines.map((runs, y) => (
    <div key={y} className="switcher-preview-row">
      {runs.map((r, i) => (
        <span
          key={i}
          style={{
            // Inverse swaps fg/bg the way the terminal does; unset sides fall
            // back to the tile's own colors.
            color: r.i ? r.b || "var(--terminal-bg)" : r.f,
            background: r.i ? r.f || "var(--ink)" : r.b,
            opacity: r.d ? 0.6 : undefined,
            fontWeight: r.o ? 600 : undefined
          }}
        >
          {r.t}
        </span>
      ))}
    </div>
  ));

const shortDir = (p?: string) => {
  const parts = String(p || "").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return "";
  return parts.slice(-2).join("/");
};

const SHELL_PROCS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu", "xonsh", "login"]);
const runningApp = (s: SwitcherSession) => {
  const proc = (s.foregroundProcess || "").trim();
  return proc && !SHELL_PROCS.has(proc.toLowerCase()) ? proc : "";
};

// Focused tile: exactly ONE tile at a time is a real interactive terminal —
// full input, auto-fit to its box, instant rendering, connected as the user
// (it participates in presence like any client). Every other tile stays a
// cheap polled text preview, so the XL wall costs one websocket, not nine.
// ── One terminal per tile ─────────────────────────────────────────────────
// A tile at interactive zoom IS a terminal for its whole life on the wall.
// In "watch" mode it repaints from the daemon's serialized grid on the poll
// cadence; going live (a click) attaches the room's websocket and enables
// input ON THE SAME xterm instance. Nothing is created or destroyed at the
// boundary, so entering and leaving interaction changes exactly two things:
// responsiveness and whether keystrokes are accepted. The old design — an
// HTML preview swapped for a fresh xterm + socket behind a veil — is gone.
const LIVETILE_POLL_MS = 5000;
const LiveTile = ({ wsBase, room, userName, theme, live, claudeApp, claimSize, activeCols, activeRows, onFullscreen, onUnfocus }: {
  wsBase: string; room: string; userName: string; theme: object | undefined;
  live: boolean; claudeApp: boolean; claimSize: boolean; activeCols?: number; activeRows?: number;
  onFullscreen: () => void; onUnfocus: () => void;
}) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const rescaleRef = useRef<() => void>(() => {});
  // Wired by the live effect; watch mode leaves them null so keys go nowhere.
  const sendInputRef = useRef<((data: string) => void) | null>(null);
  const kbdEnhancedRef = useRef(false);
  // null = watching; "live"/"down" = connected state for the chrome.
  const [conn, setConn] = useState<"live" | "down" | null>(null);
  // In-tile find (⌘F while the tile is live): same engine as the full-screen
  // find bar. Scope follows focus — ⌘F in a live tile searches THIS session;
  // ⌘F anywhere else is the wall filter, which finds sessions.
  const [find, setFind] = useState<{ query: string; index: number; total: number } | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findIndexRef = useRef(-1);
  const runTileFind = (query: string, step = 0) => {
    const term = termRef.current;
    if (!term) return;
    if (!query) {
      term.clearSelection();
      findIndexRef.current = -1;
      setFind((f) => (f ? { ...f, query, index: 0, total: 0 } : f));
      return;
    }
    const matches = collectTerminalMatches(term as never, query);
    // Fresh query starts at the newest match; steps walk from the last one.
    const target = step === 0 ? matches.length - 1 : findIndexRef.current + step;
    const i = selectTerminalMatch(term as never, matches, target, query.length);
    findIndexRef.current = i;
    setFind({ query, index: i + 1, total: matches.length });
  };
  const closeTileFind = () => {
    setFind(null);
    findIndexRef.current = -1;
    termRef.current?.clearSelection();
    // Deliberate close returns the keyboard to the tile's terminal.
    findInputRef.current?.blur();
    window.setTimeout(() => { if (terminalMayTakeFocus()) termRef.current?.focus(); }, 0);
  };

  // Who else is attached, and who is currently driving the terminal.
  const myIdRef = useRef<string | null>(null);
  const [viewers, setViewers] = useState<Array<{ name: string }>>([]);
  const [driver, setDriver] = useState<{ name: string; color: string } | null>(null);
  const claudeAppRef = useRef(claudeApp);
  claudeAppRef.current = claudeApp;
  const liveRef = useRef(live);
  liveRef.current = live;
  const onFullscreenRef = useRef(onFullscreen);
  onFullscreenRef.current = onFullscreen;
  const onUnfocusRef = useRef(onUnfocus);
  onUnfocusRef.current = onUnfocus;

  // The terminal itself: created once per room, never per mode.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const monoStack = getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim() || "monospace";
    const term = new Terminal({
      cols: activeCols && activeCols > 1 ? activeCols : 80,
      rows: activeRows && activeRows > 1 ? activeRows : 24,
      scrollback: 2000,
      // Same scroll feel as the full-screen terminal: one wheel notch moves
      // 4 lines (xterm's default of 1 is the "tiles feel sluggish" report),
      // Shift+wheel blasts. Momentum is attached below.
      scrollSensitivity: 4,
      fastScrollSensitivity: 12,
      fontSize: PREVIEW_BASE_FS,
      lineHeight: 1.3,
      fontFamily: monoStack,
      cursorBlink: false,
      disableStdin: true,
      theme: theme as never
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box);
    termRef.current = term;
    fitRef.current = fit;
    const inner = box.querySelector(".xterm") as HTMLElement | null;
    const rescale = () => {
      // FILL THE WIDTH, SHOW THE BOTTOM. A terminal preview has a strong
      // reading order: the newest lines are at the bottom and the width is
      // what makes text legible. The old policy (fit entirely, never magnify,
      // anchor top-left) got both backwards — a session smaller than its tile
      // rendered as a postage stamp in a sea of white, and a session taller
      // than its tile had its NEWEST lines cropped away.
      //
      // Magnification changes the FONT, not a transform: upscaling a canvas
      // blurs, while re-rendering at a larger font is crisp. The transform is
      // then only the sub-font-size remainder. Hysteresis (0.75px) keeps the
      // font from oscillating against the resize observer it triggers.
      const screen = box.querySelector(".xterm-screen") as HTMLElement | null;
      const term = termRef.current;
      if (!inner || !screen || !term) return;
      const boxW = box.clientWidth;
      const boxH = box.clientHeight;
      if (boxW <= 0 || boxH <= 0) return;
      let w = screen.offsetWidth;
      let h = screen.offsetHeight;
      if (w <= 0 || h <= 0) return;
      // ONE font per zoom, from the box alone (tileFontFor) — and NO
      // per-session transform. The transform was the last variance source:
      // it rescaled each session by its column count (within the claim
      // tolerance, far more for foreign sizes), so tiles still showed
      // different apparent glyph sizes. Now: uniform font, width overflow
      // crops on the right, underfill leaves margin, bottom stays anchored.
      void w;
      void h;
      const font = term.options.fontSize || PREVIEW_BASE_FS;
      const wanted = tileFontFor(boxW);
      if (Math.abs(wanted - font) >= 0.25) {
        term.options.fontSize = wanted;
        requestAnimationFrame(() => rescaleRef.current());
        return;
      }
      inner.style.transformOrigin = "bottom left";
      inner.style.transform = "";
    };
    rescaleRef.current = rescale;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(rescale) : null;
    ro?.observe(box);
    // The screen element resizes on font measure and every cols/rows change —
    // each needs a refit, and the box itself never moves while the wall is up.
    const screenEl = box.querySelector(".xterm-screen") as HTMLElement | null;
    if (screenEl) ro?.observe(screenEl);
    else if (inner) ro?.observe(inner);
    window.setTimeout(rescale, 30);
    document.fonts?.ready?.then(() => rescale()).catch(() => { /* no Font API */ });
    // Keys route through refs so the handler survives mode flips untouched.
    term.attachCustomKeyEventHandler((ev) => {
      if (!liveRef.current) return false; // watching: the terminal takes no keys
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "f") {
        // Scope follows focus: find in THIS terminal. (The wall filter stays
        // one ⌘K away; ⌘. still unfocuses the tile.)
        if (ev.type === "keydown") {
          setFind((f) => f ?? { query: "", index: 0, total: 0 });
          window.setTimeout(() => findInputRef.current?.focus(), 0);
        }
        return false;
      }
      if (ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey
          && (kbdEnhancedRef.current || claudeAppRef.current)) {
        if (ev.type === "keydown") sendInputRef.current?.("\x1b[13;2u");
        return false;
      }
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key === "Enter") {
        if (ev.type === "keydown") onFullscreenRef.current();
        return false;
      }
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key === ".") {
        if (ev.type === "keydown") onUnfocusRef.current();
        return false;
      }
      return true;
    });
    const sub = term.onData((data) => sendInputRef.current?.(data));
    const detachFlywheel = attachScrollFlywheel(box, () => termRef.current as never, {
      linesPerNotch: 4,
      lineHeightPx: () => Math.max(1, ((term as never as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core
        ?._renderService?.dimensions?.css?.cell?.height) || PREVIEW_BASE_FS * 1.3)
    });
    return () => {
      detachFlywheel();
      ro?.disconnect();
      sub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, theme]);

  // Autofit: while the wall is visible, each tile SIZES its session to the
  // tile grid — a real reflow, so tile content is readable and fills the
  // tile, not a scaled postage stamp. Opening the wall (and resizing it) is
  // a deliberate act, so the claim rides the room's normal election with the
  // user flag; entering a session full-screen re-asserts that surface's size
  // on the way back (the wall-close deliberate attach). Local-CLI sessions
  // are exempt: a real terminal window's size is physical truth.
  const lastClaimRef = useRef<{ cols: number; rows: number; at: number } | null>(null);
  const claimTileSize = (onDone?: () => void) => {
    if (!claimSize) return;
    const fitAddon = fitRef.current;
    const boxEl = boxRef.current;
    if (!fitAddon || !boxEl || boxEl.clientWidth < 60 || boxEl.clientHeight < 40) return;
    const dims = fitAddon.proposeDimensions();
    if (!dims?.cols || !dims?.rows || dims.cols < 20 || dims.rows < 5) return;
    // Dedupe on the SESSION's size, never on what we last sent. Keying the
    // skip to the last claim meant: visit the wall (claim 85 cols), leave to
    // full screen (which re-asserts ~180), come back — the tile proposes 85
    // again, matches the remembered claim, and returns without claiming. The
    // session stayed at full-screen width and the tile rendered it as a wall
    // of microscopic text, permanently, no matter what you typed.
    const prev = lastClaimRef.current;
    const repeatSoon = prev && prev.cols === dims.cols && prev.rows === dims.rows
      && performance.now() - prev.at < 1500;
    if (repeatSoon) return;
    // CLOSE ENOUGH is the right size. Requiring exact dims made every wall
    // fight every other wall: two browsers whose tile grids differ by a few
    // cells (laptop vs phone, or layout jitter between opens) re-claimed the
    // same sessions back and forth on every open — "the tile shows at
    // terminal shape, then resizes" forever. Within tolerance the tile just
    // renders the session scaled (~0.9), which is visually free; a claim is
    // for sizes that are genuinely foreign (full-screen leftovers), not for
    // disagreements about rounding.
    const cur = termRef.current;
    if (cur) {
      const closeCols = Math.abs(cur.cols - dims.cols) <= Math.max(3, Math.round(dims.cols * 0.15));
      const closeRows = Math.abs(cur.rows - dims.rows) <= Math.max(2, Math.round(dims.rows * 0.15));
      if (closeCols && closeRows) {
        lastClaimRef.current = { cols: dims.cols, rows: dims.rows, at: performance.now() };
        return;
      }
    }
    lastClaimRef.current = { cols: dims.cols, rows: dims.rows, at: performance.now() };
    const sep = wsBase.includes("?") ? "&" : "?";
    // Claim-only socket: no replay, closed as soon as the claim is sent. The
    // watch poll then repaints at the new size.
    const sock = new WebSocket(
      wsBase + sep + "room=" + encodeURIComponent(room)
      + "&name=" + encodeURIComponent((userName || "user") + " (wall)")
      + "&replay=0&cols=" + dims.cols + "&rows=" + dims.rows
    );
    sock.onopen = () => {
      try {
        sock.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows, claim: "attach", user: true }));
      } catch { /* closing */ }
      // The election confirms to the winner (active_size) — close on that,
      // with a timeout fallback, so the repaint chase starts immediately.
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { sock.close(); } catch { /* closed */ }
        onDone?.();
      };
      sock.onmessage = finish;
      window.setTimeout(finish, 300);
    };
    sock.onerror = () => { try { sock.close(); } catch { /* closed */ } };
  };
  const claimRef = useRef(claimTileSize);
  claimRef.current = claimTileSize;

  // Watch mode: full-screen repaints from the daemon grid. One request, one
  // parse pass (RIS + serialized screen), no flicker — the same bytes the
  // live socket would eventually deliver.
  useEffect(() => {
    if (live) return;
    let cancelled = false;
    const paint = async () => {
      if (cancelled || document.hidden) return;
      try {
        const res = await fetch("/api/sessions/screen?name=" + encodeURIComponent(room));
        if (!res.ok) return;
        const data = await res.json();
        const term = termRef.current;
        if (cancelled || !term || typeof data.data !== "string") return;
        if (Number.isInteger(data.cols) && Number.isInteger(data.rows)
            && (term.cols !== data.cols || term.rows !== data.rows)) {
          term.resize(data.cols, data.rows);
          window.setTimeout(() => rescaleRef.current(), 30);
        }
        term.write("\x1bc" + data.data, () => {
          const t = termRef.current;
          if (!t) return;
          // Pin to the newest line. A repaint can leave the viewport parked
          // where it was, so the tile showed older rows and the live part of
          // the session — a Claude composer, a running command — sat below
          // the fold with nothing indicating it. A preview is a window on
          // NOW; scrollback belongs to the focused terminal.
          t.scrollToBottom();
          t.refresh(0, t.rows - 1);
          rescaleRef.current();
        });
      } catch { /* keep the last frame */ }
    };
    // Claim first, then CHASE it: poll the grid on a fast schedule until it
    // reports the claimed dims (the PTY resize → app redraw → grid ingest
    // pipeline takes a few hundred ms). One straggling 5s poll slot per tile
    // is what made refits look one-by-one.
    const settle = (attempt: number) => {
      if (cancelled) return;
      const claimed = lastClaimRef.current;
      const term = termRef.current;
      if (!claimed || !term) return;
      if (term.cols === claimed.cols && term.rows === claimed.rows) return;
      paint();
      if (attempt < 5) window.setTimeout(() => settle(attempt + 1), 200 + attempt * 250);
    };
    claimRef.current(() => { settle(0); });
    paint();
    const id = window.setInterval(paint, LIVETILE_POLL_MS);
    // Tile geometry changes (zoom step, window resize) re-claim, debounced —
    // "all session tiles autofit when the session view comes up and when
    // resize happens".
    let resizeDebounce = 0;
    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          window.clearTimeout(resizeDebounce);
          resizeDebounce = window.setTimeout(() => {
            if (!cancelled) claimRef.current(() => { settle(0); });
          }, 350);
        })
      : null;
    if (boxRef.current) ro?.observe(boxRef.current);
    return () => { cancelled = true; window.clearInterval(id); window.clearTimeout(resizeDebounce); ro?.disconnect(); };
  }, [live, room]);

  // Live mode: the same terminal, now fed by the room's websocket. Size is
  // handled by the wall-level autofit claim above (never per-keystroke — an
  // earlier version that claimed on typing shrank sessions under their other
  // surfaces with no re-assert path); here input flows and the tile follows
  // the room's elected size.
  useEffect(() => {
    if (!live) return;
    const term = termRef.current;
    const box = boxRef.current;
    if (!term || !box) return;
    term.options.disableStdin = false;
    term.options.cursorBlink = true;
    // GPU rendering for the tile you are actually using — the full-screen
    // terminal has had it all along, which is most of why a live tile felt
    // less responsive than full screen. Only the live tile: browsers cap
    // concurrent WebGL contexts (~16) and a wall can hold more tiles.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => { webgl?.dispose(); webgl = null; });
      term.loadAddon(webgl);
    } catch {
      webgl?.dispose();
      webgl = null;
    }
    setConn("live");
    const sep = wsBase.includes("?") ? "&" : "?";
    const wsUrl = () =>
      wsBase + sep + "room=" + encodeURIComponent(room) + "&name=" + encodeURIComponent(userName || "user")
      + "&replay=65536&cols=" + term.cols + "&rows=" + term.rows;
    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer = 0;
    let reconnectAttempt = 0;
    const pendingInput: Array<{ data: string; at: number }> = [];
    const scheduleReconnect = () => {
      if (disposed) return;
      setConn("down");
      window.clearTimeout(reconnectTimer);
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => connect(), delay);
    };
    const connect = () => {
      if (disposed) return;
      window.clearTimeout(reconnectTimer);
      if (ws) { try { ws.close(); } catch { /* replacing */ } }
      const sock = new WebSocket(wsUrl());
      ws = sock;
      sock.onopen = () => {
        if (disposed || ws !== sock) return;
        reconnectAttempt = 0;
        setConn("live");
        window.setTimeout(() => rescaleRef.current(), 30);
        const cutoff = Date.now() - 15000;
        for (const pend of pendingInput) {
          if (pend.at >= cutoff) sock.send(JSON.stringify({ type: "input", data: pend.data }));
        }
        pendingInput.length = 0;
      };
      sock.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data));
          if (m.type === "snapshot") {
            term.reset();
            term.write(m.data, () => {
              term.scrollToBottom();
              rescaleRef.current();
            });
            kbdEnhancedRef.current = typeof m.keyboardEnhanced === "boolean"
              ? m.keyboardEnhanced
              : scanKeyboardProtocol(String(m.data || ""), false);
          } else if (m.type === "output") {
            term.write(m.data);
            kbdEnhancedRef.current = scanKeyboardProtocol(String(m.data || ""), kbdEnhancedRef.current);
          } else if (m.type === "active_size") {
            // Follow the room's elected size — the tile mirrors reality.
            if (m.cols !== term.cols || m.rows !== term.rows) {
              term.resize(m.cols, m.rows);
              window.setTimeout(() => rescaleRef.current(), 30);
            }
          } else if (m.type === "hello") {
            myIdRef.current = String(m.clientId || "");
          } else if (m.type === "presence" && Array.isArray(m.clients)) {
            const others = (m.clients as Array<{ id?: string; name?: string; color?: string; typing?: boolean }>)
              .filter((c) => String(c.id || "") !== myIdRef.current);
            setViewers(others.map((c) => ({ name: String(c.name || "viewer") })));
            const active = others.find((c) => c.typing);
            setDriver(active ? { name: String(active.name || "someone"), color: String(active.color || "#8b5cf6") } : null);
          }
        } catch { /* non-JSON frame */ }
      };
      sock.onclose = () => {
        if (disposed || ws !== sock) return;
        scheduleReconnect();
      };
      sock.onerror = () => {
        try { sock.close(); } catch { /* already closing */ }
      };
    };
    connect();
    sendInputRef.current = (data: string) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        pendingInput.push({ data, at: Date.now() });
        if (pendingInput.length > 200) pendingInput.shift();
        setConn("down");
        if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
          reconnectAttempt = 0;
          connect();
        }
        return;
      }
      ws.send(JSON.stringify({ type: "input", data }));
    };
    const hiddenReconnect = { hiddenAt: 0 };
    const onVisibility = () => {
      if (document.hidden) { hiddenReconnect.hiddenAt = Date.now(); return; }
      // Same stale-canvas risk as the full-screen terminal: repaint on the
      // way back rather than waiting for a scroll to invalidate it.
      requestAnimationFrame(() => {
        const t = termRef.current;
        if (t) { try { t.refresh(0, t.rows - 1); } catch { /* disposed */ } }
      });
      const away = hiddenReconnect.hiddenAt ? Date.now() - hiddenReconnect.hiddenAt : 0;
      hiddenReconnect.hiddenAt = 0;
      if (!ws || ws.readyState !== WebSocket.OPEN || away > 60000) {
        reconnectAttempt = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const onWindowFocus = () => {
      if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        reconnectAttempt = 0;
        connect();
      }
    };
    window.addEventListener("focus", onWindowFocus);
    const focusTimer = window.setTimeout(() => { if (terminalMayTakeFocus()) term.focus(); }, 50);
    return () => {
      disposed = true;
      try { webgl?.dispose(); } catch { /* already gone */ }
      webgl = null;
      window.clearTimeout(focusTimer);
      window.clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onWindowFocus);
      try { ws?.close(); } catch { /* closing */ }
      sendInputRef.current = null;
      term.options.disableStdin = true;
      term.options.cursorBlink = false;
      setConn(null);
      setViewers([]);
      setDriver(null);
      setFind(null);
      findIndexRef.current = -1;
      term.blur();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, wsBase, room, userName]);

  return (
    <div
      className={"switcher-live-tile" + (live ? " is-live" : "")}
      // The terminal's own background: the partial-row remainder above the
      // bottom-anchored screen otherwise shows the CARD's background as a
      // pale strip — the "space on top".
      style={{ background: (theme as { background?: string } | undefined)?.background }}
      onClick={live ? (e) => e.stopPropagation() : undefined}
      onPointerDown={live ? (e) => e.stopPropagation() : undefined}
    >
      <div className="switcher-focus-term" ref={boxRef} />
      {live && (
        <div className="switcher-live-chrome" onClick={(e) => e.stopPropagation()}>
          <span className={"switcher-focus-label" + (conn === "down" ? " down" : "")}>
            {conn === "down" ? "reconnecting…" : "live"}
          </span>
          {driver && (
            <span className="switcher-live-driver" title={driver.name + " is typing in this session"}>
              <span className="driver-dot" style={{ background: driver.color }} />
              {driver.name}
            </span>
          )}
          {viewers.length > 0 && (
            <span
              className="switcher-live-viewers"
              title={viewers.map((v) => v.name).join(", ") + " also connected"}
            >
              <PersonGlyph />
              {viewers.length}
              {viewers.some((v) => /agent|hopa|\(pane\)/i.test(v.name)) && <b className="viewer-agent">AI</b>}
            </span>
          )}
          {find && (
            <span className="switcher-tile-find" onClick={(e) => e.stopPropagation()}>
              <input
                ref={findInputRef}
                value={find.query}
                placeholder="Find…"
                onChange={(e) => runTileFind(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") { e.preventDefault(); closeTileFind(); }
                  else if (e.key === "Enter") { e.preventDefault(); runTileFind(find.query, e.shiftKey ? -1 : 1); }
                }}
              />
              <em>{find.total > 0 ? find.index + "/" + find.total : find.query ? "0" : ""}</em>
              <button type="button" aria-label="Close find" onClick={closeTileFind}>✕</button>
            </span>
          )}
          <button type="button" title="Open full screen" aria-label="Open session full screen" onClick={onFullscreen}>⛶</button>
          <button type="button" title="Unfocus" aria-label="Unfocus tile" onClick={onUnfocus}>✕</button>
        </div>
      )}
    </div>
  );
};


export const SessionSwitcher = ({
  open,
  sessions,
  currentRoom,
  onClose,
  dismissable = true,
  onSwitch,
  onRefresh,
  onNotice,
  tileWsBase,
  onFocusSession,
  folders = [],
  userName,
  terminalTheme,
  onOpenSettings,
  onToggleKeyboard,
  onFind
}: Props) => {
  const [filter, setFilter] = useState("");
  const [originScope, setOriginScope] = useState<SessionOriginScope>("user");
  // Tile zoom: bigger tiles show more of each terminal preview.
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem("hay_tile_zoom");
    if (saved !== null && /^\d+$/.test(saved)) {
      return Math.min(Number(saved), ZOOM_LEVELS.length - 1);
    }
    const legacy = localStorage.getItem("hay_tile_size");
    if (legacy && legacy in LEGACY_ZOOM) return LEGACY_ZOOM[legacy];
    return DEFAULT_ZOOM;
  });
  // Grid content width, kept fresh across viewport/panel resizes — it decides
  // how far the zoom ladder is climbable on THIS screen.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      setGridWidth(w > 0 ? w : 0);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);
  // Ceiling: the first level that lays out as ONE full-width column. A tile
  // already spanning the whole grid has nothing left to grow into.
  const maxZoom = useMemo(() => {
    if (!gridWidth) return ZOOM_LEVELS.length - 1;
    for (let i = 0; i < ZOOM_LEVELS.length; i++) {
      if (Math.floor((gridWidth + GRID_GAP) / (ZOOM_LEVELS[i].min + GRID_GAP)) <= 1) return i;
    }
    return ZOOM_LEVELS.length - 1;
  }, [gridWidth]);
  const effectiveZoom = Math.min(zoom, maxZoom);
  const zoomLevel = ZOOM_LEVELS[effectiveZoom];
  // Above the threshold every active tile is one click away from being a real
  // terminal (the focused tile below). Announced once per open via onNotice;
  // the ⌨ chip in the header is the standing indicator.
  const interactiveTiles = effectiveZoom >= INTERACTIVE_ZOOM && !!tileWsBase;
  const noticedInteractiveRef = useRef(false);
  useEffect(() => { if (open) noticedInteractiveRef.current = false; }, [open]);
  const changeZoom = (next: number) => {
    const clamped = Math.max(0, Math.min(next, maxZoom));
    if (clamped === effectiveZoom) return;
    if (clamped >= INTERACTIVE_ZOOM && effectiveZoom < INTERACTIVE_ZOOM && tileWsBase && !noticedInteractiveRef.current) {
      noticedInteractiveRef.current = true;
      onNotice("Tiles are interactive at this zoom — click one to type in it (⌘⏎ full screen, ⌘. release)");
    }
    setZoom(clamped);
    localStorage.setItem("hay_tile_zoom", String(clamped));
  };
  // Organization mode: recent (tiers), project (grouped by workdir), or manual
  // (a persisted drag order). Persisted so the choice sticks across sessions.
  const [sortMode, setSortMode] = useState<SwitcherSortMode>(() => {
    const saved = localStorage.getItem("hay_sort_mode");
    return saved === "project" || saved === "manual" ? saved : "recent";
  });
  const changeSortMode = (mode: SwitcherSortMode) => {
    setSortMode(mode);
    localStorage.setItem("hay_sort_mode", mode);
    // A deliberate re-sort is the one time reordering is EXPECTED — drop the
    // frozen capture so the new mode lays out fresh.
    frozenOrderRef.current = null;
  };
  // Project view density: sectional (a header per project) vs compact (one
  // continuous grid — the card's workdir line already names the project).
  // Sections waste rows when most projects hold one or two sessions.
  const [projectCompact, setProjectCompact] = useState(() => localStorage.getItem("hay_project_compact") === "1");
  const changeProjectCompact = (compact: boolean) => {
    setProjectCompact(compact);
    localStorage.setItem("hay_project_compact", compact ? "1" : "0");
  };
  // Manual drag order: the ordered list of session keys. Seeded lazily from
  // the current recency order the first time the user drags, so nothing jumps.
  const [manualOrder, setManualOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("hay_manual_order_v1") || "[]");
      return Array.isArray(saved) ? saved.filter((k) => typeof k === "string") : [];
    } catch {
      return [];
    }
  });
  const persistManualOrder = (order: string[]) => {
    setManualOrder(order);
    try {
      localStorage.setItem("hay_manual_order_v1", JSON.stringify(order));
    } catch {
      /* quota — order is best-effort */
    }
  };
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuRequest>(null);

  // The wall's own background: the actions that create things, plus the view
  // controls that otherwise live only in the header. Same words as the
  // buttons — right-click is a shortcut, never a second vocabulary.
  const openWallMenu = (e: ReactMouseEvent) => {
    // Only the empty wall — a right-click on a card belongs to that card.
    if ((e.target as HTMLElement)?.closest?.(".switcher-card, .switcher-group-label, .switcher-top")) return;
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New session", onSelect: () => setCreating(true) },
        ...(sortMode === "manual" ? [{ label: "New folder", onSelect: () => { void createFolder(); } }] : []),
        { kind: "separator" as const },
        { label: "Sort by recent", onSelect: () => changeSortMode("recent"), disabled: sortMode === "recent" },
        { label: "Group by project", onSelect: () => changeSortMode("project"), disabled: sortMode === "project" },
        { label: "Manual order", onSelect: () => changeSortMode("manual"), disabled: sortMode === "manual" },
        { kind: "separator" as const },
        { label: "Zoom in", onSelect: () => changeZoom(effectiveZoom + 1), hint: "+", disabled: effectiveZoom >= maxZoom },
        { label: "Zoom out", onSelect: () => changeZoom(effectiveZoom - 1), hint: "−", disabled: effectiveZoom <= 0 }
      ]
    });
  };

  const openFolderMenu = (e: ReactMouseEvent, folder: SwitcherFolder) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Rename folder…", onSelect: () => { void renameFolder(folder); } },
        { label: "Delete folder", danger: true, onSelect: () => { void deleteFolder(folder); } },
        { kind: "separator" as const },
        { label: "New folder", onSelect: () => { void createFolder(); } }
      ]
    });
  };

  // Folder mutations go straight to the daemon: folders are shared structure,
  // not client preference, so they must not live in localStorage the way the
  // manual ORDER does.
  const folderApi = async (path: string, body: unknown, failure: string) => {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { error?: string }));
        onNotice(data.error || failure);
        return false;
      }
      onRefresh();
      return true;
    } catch {
      onNotice(failure);
      return false;
    }
  };
  const createFolder = async () => {
    const name = window.prompt("Folder name")?.trim();
    if (!name) return;
    if (await folderApi("/api/folders", { name }, "Could not create folder")) onNotice(`Created ${name}`);
  };
  const renameFolder = async (folder: SwitcherFolder) => {
    const name = window.prompt("Rename folder", folder.name)?.trim();
    if (!name || name === folder.name) return;
    await folderApi("/api/folders/rename", { id: folder.id, name }, "Could not rename folder");
  };
  const deleteFolder = async (folder: SwitcherFolder) => {
    // Deleting a folder releases its sessions; it never kills them, so this
    // needs no scarier confirmation than the sentence itself.
    if (!window.confirm(`Delete folder "${folder.name}"? Its sessions move back to unfiled.`)) return;
    await folderApi("/api/folders/delete", { id: folder.id }, "Could not delete folder");
  };
  const fileSession = async (key: string, folderId: string | null) => {
    await folderApi("/api/sessions/move", { internalName: key, folderId }, "Could not move session");
  };

  // Drag auto-scroll: a manual reorder often has to travel past a screenful
  // of tiles, and HTML5 drag blocks normal scrolling — so while a drag is
  // near the top/bottom edge, glide the wall's scroll container. Speed ramps
  // with edge proximity; dragEnter on newly revealed cards keeps reordering
  // live as the page moves under the drag.
  useEffect(() => {
    if (!dragKey) return;
    let pointerY = -1;
    let raf = 0;
    const EDGE = 110;
    const onDragOver = (e: DragEvent) => { pointerY = e.clientY; };
    const step = () => {
      const sc = scrollRef.current;
      if (sc && pointerY >= 0) {
        const rect = sc.getBoundingClientRect();
        if (pointerY < rect.top + EDGE) {
          sc.scrollTop -= Math.ceil(((rect.top + EDGE - pointerY) / EDGE) * 22);
        } else if (pointerY > rect.bottom - EDGE) {
          sc.scrollTop += Math.ceil(((pointerY - (rect.bottom - EDGE)) / EDGE) * 22);
        }
      }
      raf = requestAnimationFrame(step);
    };
    window.addEventListener("dragover", onDragOver);
    raf = requestAnimationFrame(step);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      cancelAnimationFrame(raf);
    };
  }, [dragKey]);
  // A focused tile is a live terminal: making the whole card draggable would
  // hijack text selection inside it. So it becomes draggable only while the
  // pointer is down on its HEADER — grab the title bar to move it, drag
  // inside the terminal to select text.
  const [dragArmKey, setDragArmKey] = useState<string | null>(null);
  useEffect(() => {
    if (!dragArmKey) return;
    const disarm = () => setDragArmKey(null);
    window.addEventListener("pointerup", disarm);
    window.addEventListener("dragend", disarm);
    return () => {
      window.removeEventListener("pointerup", disarm);
      window.removeEventListener("dragend", disarm);
    };
  }, [dragArmKey]);
  // Live reorder while dragging: dragging over a card moves the dragged
  // session to that card's index immediately, so the grid reflows in real
  // time and the drop is just a release. Index-move semantics keep this
  // stable (the classic sortable-hover pattern): after the move the hovered
  // card occupies the dragged card's old index, so re-entering it computes
  // from === to and no-ops instead of oscillating. Seeds the order from the
  // current visual sequence on first drag so untouched sessions keep place.
  const moveManual = (from: string | null, to: string) => {
    if (!from || from === to) return;
    // Seed and extend from EVERY session, never from what is on screen: a
    // first drag while a filter was active used to seed the order from the
    // visible matches alone, which silently banished every hidden session to
    // the end of the wall. The move itself is then computed in the full
    // order, so "put this next to that" survives clearing the filter.
    const current = orderedAllKeysRef.current;
    const base = manualOrder.length ? manualOrder.slice() : current.slice();
    for (const k of current) if (!base.includes(k)) base.push(k);
    const fromIdx = base.indexOf(from);
    const toIdx = base.indexOf(to);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    base.splice(fromIdx, 1);
    base.splice(toIdx, 0, from);
    persistManualOrder(base);
  };
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // The wall's single interactive tile. Cleared on close / zooming below the
  // interactive threshold.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  useEffect(() => { if (!open) setFocusedKey(null); }, [open]);
  useEffect(() => { if (!interactiveTiles) setFocusedKey(null); }, [interactiveTiles]);
  const [renameDraft, setRenameDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [, setTick] = useState(0);
  // Preview cache survives page reloads via sessionStorage: a freshly loaded
  // page paints last-known screens instantly instead of a wall of blanks.
  const previewCacheRef = useRef<Map<string, PreviewFrame> | null>(null);
  if (!previewCacheRef.current) {
    const seeded = new Map<string, PreviewFrame>();
    try {
      const saved = JSON.parse(sessionStorage.getItem("hop_preview_cache_v1") || "[]") as Array<[string, string]>;
      // Text-only on purpose: the reload seed just needs to paint something
      // instantly; color arrives with the first live refresh.
      for (const [k, v] of saved) seeded.set(k, { text: v });
    } catch { /* corrupt or absent — start empty */ }
    previewCacheRef.current = seeded;
  }
  const persistPreviewCache = () => {
    try {
      const entries = Array.from(previewCacheRef.current!.entries()).map(
        ([k, v]) => [k, v.text.length > 4000 ? v.text.slice(-4000) : v.text] as [string, string]
      );
      sessionStorage.setItem("hop_preview_cache_v1", JSON.stringify(entries));
    } catch { /* quota — previews are best-effort */ }
  };
  const longPressRef = useRef<{ timer: number; startX: number; startY: number } | null>(null);
  // Set when a long-press opened the sheet, so the click that fires on finger
  // release doesn't also switch sessions.
  const suppressTapRef = useRef(false);

  const visibleSessions = useMemo(
    () => filterSessionsByOrigin(sessions, originScope),
    [sessions, originScope]
  );
  // Parked sessions leave the wall but stay one glance away in a collapsed
  // section — and the FILTER still searches them, so a parked session is
  // never more than ⌘K + a few letters from coming back.
  const wallSessions = useMemo(() => visibleSessions.filter((s) => !s.parked), [visibleSessions]);
  const parkedSessions = useMemo(() => visibleSessions.filter((s) => s.parked), [visibleSessions]);
  const [parkedOpen, setParkedOpen] = useState(false);
  // While the switcher is OPEN the wall's ORDER freezes at what the user
  // first saw: attention/recency resorting yanked tiles around mid-scan
  // (and out from under a focused tile's hands). Contents still refresh —
  // fresh session objects are looked up by key — and activity shows IN
  // PLACE (the active-now glow + attention dots) instead of as movement.
  // The order recaptures on reopen or when the user changes scope/sort;
  // sessions that vanish drop out; brand-new ones append at the end rather
  // than reshuffling the wall.
  const frozenOrderRef = useRef<{ mode: "tiers" | "project"; hero: string[]; groups: Array<{ label: string; rows: string[] }> } | null>(null);
  useEffect(() => { if (!open) frozenOrderRef.current = null; }, [open]);
  const model = useMemo(() => {
    // A filter query searches EVERYTHING (parked included); the browsing
    // wall shows only unparked sessions.
    const pool = filter.trim() ? visibleSessions : wallSessions;
    const live = buildSwitcherModel(pool, currentRoom, filter, sortMode, manualOrder, folders);
    if (!open || (live.mode !== "tiers" && live.mode !== "project")) return live;
    let frozen = frozenOrderRef.current;
    if (!frozen || frozen.mode !== live.mode) {
      frozen = live.mode === "tiers"
        ? {
            mode: "tiers",
            hero: live.hero.map(sessionKey),
            groups: live.groups.map((g) => ({ label: g.label, rows: g.rows.map(sessionKey) }))
          }
        : {
            mode: "project",
            hero: [],
            groups: live.groups.map((g) => ({ label: g.label, rows: g.rows.map(sessionKey) }))
          };
      frozenOrderRef.current = frozen;
      return live;
    }
    const byKey = new Map(pool.map((s) => [sessionKey(s), s]));
    const knownKeys = new Set([...frozen.hero, ...frozen.groups.flatMap((g) => g.rows)]);
    const fresh = pool.filter((s) => !knownKeys.has(sessionKey(s)));
    const resolve = (keys: string[]) => keys.map((k) => byKey.get(k)).filter((s): s is SwitcherSession => !!s);
    if (live.mode === "tiers") {
      return {
        mode: "tiers" as const,
        // New sessions join at the end of the hero wall — visible without
        // displacing anything the user is already looking at.
        hero: [...resolve(frozen.hero), ...fresh],
        groups: frozen.groups
          .map((g) => ({ label: g.label, rows: resolve(g.rows) }))
          .filter((g) => g.rows.length > 0),
        currentInHero: live.currentInHero
      };
    }
    // Project mode: a new session lands in its own project's frozen group
    // when one exists, otherwise in a trailing group.
    const groups = frozen.groups.map((g) => ({ label: g.label, rows: resolve(g.rows) }));
    for (const s of fresh) {
      const label = s.type === "port" ? "Ports" : projectKey(s.cwd);
      const g = groups.find((x) => x.label === label);
      if (g) g.rows.push(s);
      else groups.push({ label, rows: [s] });
    }
    return { mode: "project" as const, groups: groups.filter((g) => g.rows.length > 0) };
  }, [open, visibleSessions, wallSessions, currentRoom, filter, sortMode, manualOrder, originScope]);

  // ── Keyboard-first palette: ⌘K → type to filter → ↑↓ → Enter, no mouse. ──
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [kbdIndex, setKbdIndex] = useState(0);
  const finePointer = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: fine)").matches;

  // Content-aware matches: debounced grep over each session's recent screen
  // text (daemon-side, over already-retained output — no index, no polling).
  const [contentMatches, setContentMatches] = useState<Array<{ session: SwitcherSession; snippet: string }>>([]);
  useEffect(() => {
    const q = filter.trim();
    if (!open || q.length < 3) {
      setContentMatches([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (cancelled) return;
        const byKey = new Map(visibleSessions.map((s) => [s.internalName || s.name, s]));
        setContentMatches(
          (Array.isArray(data?.matches) ? data.matches : [])
            .map((m: { internalName?: string; name?: string; snippet?: string }) => {
              const session = byKey.get(m.internalName || "") || byKey.get(m.name || "");
              return session ? { session, snippet: m.snippet || "" } : null;
            })
            .filter(Boolean) as Array<{ session: SwitcherSession; snippet: string }>
        );
      } catch {
        if (!cancelled) setContentMatches([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, filter, visibleSessions]);

  // Content matches the name filter didn't already surface.
  const extraContentMatches = useMemo(() => {
    if (model.mode !== "filter") return [];
    const seen = new Set(model.rows.map(sessionKey));
    return contentMatches.filter((m) => !seen.has(sessionKey(m.session)));
  }, [model, contentMatches]);

  // Flat navigation order = exactly the visual order: heroes, then group rows
  // (and under a filter: name matches, then on-screen content matches).
  const flatNav = useMemo<SwitcherSession[]>(
    () => {
      if (model.mode === "filter") return [...model.rows, ...extraContentMatches.map((m) => m.session)];
      // Folder rows come first because that is their visual order; keyboard
      // ↑/↓ and Enter must traverse what the eye sees, foldered included.
      if (model.mode === "manual") return [...model.folders.flatMap((f) => f.rows), ...model.rows];
      if (model.mode === "project") return model.groups.flatMap((g) => g.rows);
      return [...model.hero, ...model.groups.flatMap((g) => g.rows)];
    },
    [model, extraContentMatches]
  );
  const navIndexByKey = useMemo(() => {
    const m = new Map<string, number>();
    flatNav.forEach((s, i) => m.set(sessionKey(s), i));
    return m;
  }, [flatNav]);
  // Latest visual order, for reorderManual (defined earlier in the component).
  // Every session in the current scope, in manual order — the canonical list
  // reordering works against, regardless of what the filter is showing.
  const orderedAllKeysRef = useRef<string[]>([]);
  {
    const full = buildSwitcherModel(wallSessions, currentRoom, "", "manual", manualOrder, folders);
    orderedAllKeysRef.current = full.mode === "manual"
      ? [...full.folders.flatMap((f) => f.rows), ...full.rows].map(sessionKey)
      : [];
  }
  const flatNavRef = useRef(flatNav);
  flatNavRef.current = flatNav;

  // Default selection: the first session that isn't the current one (Enter on
  // open = jump to most relevant other session); with a filter, the top match.
  useEffect(() => {
    if (!open) return;
    // Anchor the selection on the CURRENT session: a stable, predictable start
    // (arrow keys move from there). Auto-selecting the first OTHER session
    // saved one keypress but made every open feel like the cursor teleported.
    const currentIdx = flatNav.findIndex((s) => currentRoom !== null && (s.internalName === currentRoom || s.name === currentRoom));
    setKbdIndex(filter ? 0 : Math.max(0, currentIdx));
    document.querySelector(".switcher-scroll")?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filter, originScope]);
  // Background refreshes may shrink the list — keep the selection in range.
  useEffect(() => {
    setKbdIndex((i) => Math.min(i, Math.max(0, flatNav.length - 1)));
  }, [flatNav.length]);

  // Focus the filter on open (fine-pointer devices only — autofocus on mobile
  // would pop the system keyboard over the grid).
  useEffect(() => {
    if (!open || !finePointer) return;
    const t = window.setTimeout(() => filterInputRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [open, finePointer]);

  // Every visit starts on user-owned sessions. Agent sessions stay one toggle
  // away without competing for the default view.
  useLayoutEffect(() => {
    if (open) {
      setOriginScope("user");
      setFilter("");
      setSheet(null);
      setCreating(false);
      setCreateDraft("");
    }
  }, [open]);


  // Keep relative times fresh while open.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 10000);
    return () => window.clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      // While the focused tile owns the keyboard, Escape belongs to the
      // remote app (vim, claude) — unfocus is the ✕ or a click outside.
      if (document.activeElement?.closest?.(".switcher-live-tile, .switcher-focus-tile")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (sheet) setSheet(null);
        else if (focusedKey) setFocusedKey(null);
        else if (dismissable) onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet, focusedKey]);

  // Tile previews: EVERY session gets a preview tile. Hot tiles (the
  // attention/recency heroes) refresh each tick; the long tail refreshes at a
  // quarter of that rate — 30+ tiles stay cheap, and the daemon only renders
  // previews on demand anyway. Paused while the tab is hidden.
  const lastColdRefreshRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Hot = the hero tiles in recency mode. A filter's result set is small,
    // so every match is hot — its preview is the evidence the user is
    // scanning. The other modes have no hero tier; everything refreshes at
    // the cold rate.
    const hotKeys = new Set(
      model.mode === "tiers" ? model.hero.map(sessionKey)
      : model.mode === "filter" ? [...model.rows.map(sessionKey), ...contentMatches.map((m) => sessionKey(m.session))]
      : []
    );
    // EVERY session previews — dead ones serve their retained last screen
    // from the daemon, so a tile is never a blank box.
    const seenKeys = new Set<string>();
    const all = (
      model.mode === "tiers" ? [...model.hero, ...model.groups.flatMap((g) => g.rows)]
      : model.mode === "project" ? model.groups.flatMap((g) => g.rows)
      : model.mode === "filter" ? [...model.rows, ...contentMatches.map((m) => m.session)]
      : model.rows
    ).filter((s) => {
      if (s.type === "port") return false;
      const key = sessionKey(s);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
    const refresh = async () => {
      if (cancelled || document.hidden || all.length === 0) return;
      // Time-based cold tier (not tick-based: the first mount often races the
      // sessions fetch and would consume the cold slot on an empty list).
      const coldToo = Date.now() - lastColdRefreshRef.current > 15000;
      const targets = all.filter((s) => hotKeys.has(sessionKey(s)) || coldToo);
      await Promise.all(
        targets.map(async (s) => {
          const key = sessionKey(s);
          try {
            const res = await fetch(`/api/sessions/preview?name=${encodeURIComponent(key)}`);
            if (!res.ok) return;
            const data = await res.json();
            const text = typeof data.text === "string" ? data.text.replace(/\s+$/, "") : "";
            // The daemon serves exact grid screens now (or its own cached
            // good frame), so tiny frames are real screens — a fresh shell's
            // bare prompt must fill the tile, not be filtered as junk. Only
            // an empty frame never replaces existing content.
            if (!cancelled && text.trim().length > 0) {
              previewCacheRef.current!.set(key, {
                text,
                color: Array.isArray(data.color) ? (data.color as PreviewRun[][]) : null,
                cols: Number.isInteger(data.cols) ? data.cols : undefined,
                rows: Number.isInteger(data.rows) ? data.rows : undefined
              });
            }
          } catch {
            /* keep the cached preview */
          }
        })
      );
      if (cancelled) return;
      // Consume the cold slot only after an uncancelled sweep: a model change
      // mid-sweep otherwise burned the slot and left cold tiles blank for
      // another 15s, repeatedly.
      if (coldToo) lastColdRefreshRef.current = Date.now();
      persistPreviewCache();
      setTick((t) => t + 1);
    };
    refresh();
    const id = window.setInterval(refresh, PREVIEW_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, model, contentMatches]);

  const startLongPress = (event: ReactPointerEvent, session: SwitcherSession) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    cancelLongPress();
    const pressX = event.clientX;
    const pressY = event.clientY;
    const timer = window.setTimeout(() => {
      longPressRef.current = null;
      suppressTapRef.current = true;
      setSheet({ session, mode: "menu", anchor: { x: pressX, y: pressY } });
    }, LONG_PRESS_MS);
    longPressRef.current = { timer, startX: pressX, startY: pressY };
  };

  const cancelLongPress = () => {
    if (longPressRef.current) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
  };

  // Finger jitter shouldn't cancel a long-press; a real drag/scroll should.
  const moveLongPress = (event: ReactPointerEvent) => {
    const pending = longPressRef.current;
    if (!pending) return;
    if (Math.abs(event.clientX - pending.startX) > 10 || Math.abs(event.clientY - pending.startY) > 10) {
      cancelLongPress();
    }
  };

  const handleTap = (session: SwitcherSession) => {
    cancelLongPress();
    if (suppressTapRef.current) {
      suppressTapRef.current = false;
      return;
    }
    if (currentRoom !== null && (session.internalName === currentRoom || session.name === currentRoom)) {
      onClose();
      return;
    }
    // Opening a parked session IS unparking it — best-effort, never blocking
    // the switch itself.
    if (session.parked) {
      fetch("/api/sessions/park", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(session), parked: false })
      }).catch(() => { /* daemon will still show it parked; harmless */ });
    }
    onSwitch(session);
  };

  // Arrow/Enter navigation + type-anywhere filtering. The action sheet and
  // the create form own the keyboard while open.
  useEffect(() => {
    if (!open) return;
    const onNavKey = (event: KeyboardEvent) => {
      if (sheet || creating) return;
      // ⌘F/Ctrl+F: the switcher's find IS the filter box — never browser
      // find. Handled BEFORE the focused-tile guard so it's the rescue hatch
      // when a tile owns the keyboard: unfocus, jump to the filter.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFocusedKey(null);
        filterInputRef.current?.focus();
        setKbdIndex(-1);
        return;
      }
      if (document.activeElement?.closest?.(".switcher-live-tile, .switcher-focus-tile")) return;
      // ⌘⏎ (Ctrl⏎): focus the selected tile for in-place interaction.
      // Plain Enter stays "switch to session" — the muscle-memory action.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        const target = flatNav[kbdIndex];
        if (target && interactiveTiles && target.active && target.type !== "port") {
          event.preventDefault();
          filterInputRef.current?.blur();
          setFocusedKey(sessionKey(target));
          onFocusSession?.(target);
        }
        return;
      }
      // ⌥↑/⌥↓ move the selected session in manual order — the keyboard (and
      // touch-friendly) counterpart to dragging, and the only way to reorder
      // precisely while a filter hides the neighbours you'd drag past. The
      // move lands relative to the previous/next VISIBLE match, so it means
      // the same thing as dropping there.
      if (event.altKey && !event.metaKey && !event.ctrlKey
          && (event.key === "ArrowUp" || event.key === "ArrowDown") && sortMode === "manual") {
        const target = flatNav[kbdIndex];
        const neighbour = flatNav[kbdIndex + (event.key === "ArrowUp" ? -1 : 1)];
        if (target && neighbour) {
          event.preventDefault();
          moveManual(sessionKey(target), sessionKey(neighbour));
          setKbdIndex((i) => i + (event.key === "ArrowUp" ? -1 : 1));
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // +/− step the tile zoom — but never while editing the filter text
      // ("-" is a legal character in session names).
      if (document.activeElement !== filterInputRef.current) {
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          changeZoom(effectiveZoom + 1);
          return;
        }
        if (event.key === "-") {
          event.preventDefault();
          changeZoom(effectiveZoom - 1);
          return;
        }
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "ArrowRight") {
        // ←→ must keep editing the filter text when there is any.
        if (
          (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
          document.activeElement === filterInputRef.current &&
          (filterInputRef.current?.value || "").length > 0
        ) {
          return;
        }
        event.preventDefault();
        setKbdIndex((i) => {
          // Selection parked in the filter box (-1): ↓ re-enters the wall at
          // the top; the other arrows stay in the box.
          if (i === -1) {
            if (event.key === "ArrowDown") {
              requestAnimationFrame(() => {
                document.querySelector('[data-nav-index="0"]')?.scrollIntoView({ block: "nearest" });
              });
              return 0;
            }
            return -1;
          }
          // Geometric navigation: the wall is a grid, the tail is rows — pick
          // the nearest tile in the pressed direction from real layout, so
          // all four arrows work in every mode without column bookkeeping.
          const els = Array.from(document.querySelectorAll<HTMLElement>("[data-nav-index]"));
          if (els.length === 0) return 0;
          const cur = els.find((el) => Number(el.dataset.navIndex) === i) ?? els[0];
          const cr = cur.getBoundingClientRect();
          const cx = cr.left + cr.width / 2;
          const cy = cr.top + cr.height / 2;
          let best: { idx: number; score: number } | null = null;
          for (const el of els) {
            const idx = Number(el.dataset.navIndex);
            if (idx === i || Number.isNaN(idx)) continue;
            const r = el.getBoundingClientRect();
            const dx = r.left + r.width / 2 - cx;
            const dy = r.top + r.height / 2 - cy;
            let primary: number;
            let cross: number;
            if (event.key === "ArrowDown") { primary = dy; cross = Math.abs(dx); }
            else if (event.key === "ArrowUp") { primary = -dy; cross = Math.abs(dx); }
            else if (event.key === "ArrowRight") { primary = dx; cross = Math.abs(dy); }
            else { primary = -dx; cross = Math.abs(dy); }
            if (primary < 4) continue; // wrong direction (or same row/col slot)
            const score = primary + cross * 3;
            if (!best || score < best.score) best = { idx, score };
          }
          // ↑ with nothing above: the search box sits above the wall — park
          // the selection there so the top row flows into the filter.
          if (!best && event.key === "ArrowUp") {
            requestAnimationFrame(() => filterInputRef.current?.focus());
            return -1;
          }
          const next = best ? best.idx : i;
          requestAnimationFrame(() => {
            document.querySelector(`[data-nav-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
          });
          return next;
        });
        return;
      }
      // Plain Enter only: Shift+Enter is a terminal keystroke (newline in
      // claude) — when a focused tile has lost DOM focus it must fall
      // through to NOTHING here, not switch the session to full screen.
      if (event.key === "Enter" && !event.shiftKey) {
        const target = flatNav[kbdIndex];
        if (target) {
          event.preventDefault();
          handleTap(target);
        }
        return;
      }
      // Type-to-filter from anywhere: stray printables land in the filter box.
      const inputFocused = document.activeElement === filterInputRef.current;
      if (!inputFocused && (event.key.length === 1 || event.key === "Backspace")) {
        event.preventDefault();
        setFocusedKey(null);
        filterInputRef.current?.focus();
        setFilter((f) => (event.key === "Backspace" ? f.slice(0, -1) : f + event.key));
      }
    };
    window.addEventListener("keydown", onNavKey);
    return () => window.removeEventListener("keydown", onNavKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet, creating, flatNav, kbdIndex, effectiveZoom, maxZoom, interactiveTiles]);

  const openSheet = (session: SwitcherSession, anchor?: { x: number; y: number }) => {
    cancelLongPress();
    // A missing anchor must degrade to a centered menu, never crash the render.
    setSheet({
      session,
      mode: "menu",
      anchor: anchor ?? { x: window.innerWidth / 2 + 132, y: window.innerHeight / 3 }
    });
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!sheet) return;
    const next = renameDraft.trim();
    const oldName = sheet.session.displayName || sheet.session.name;
    if (!next || next === oldName) {
      setSheet(null);
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(next)) {
      onNotice("Only letters, numbers, - and _ allowed");
      return;
    }
    try {
      const res = await fetch("/api/sessions/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Address by internal name: display names can collide, and then
        // renaming by display name picks an arbitrary one of the two.
        body: JSON.stringify({ oldName, newName: next, internalName: sessionKey(sheet.session) })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { error?: string }));
        onNotice(data.error || "Rename failed");
        return;
      }
      onNotice(`Renamed to ${next}`);
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Rename failed");
    }
  };

  const toggleAgentAccess = async () => {
    if (!sheet) return;
    const key = sessionKey(sheet.session);
    const allowed = sheet.session.agentPermitted !== true;
    try {
      const res = await fetch("/api/sessions/agent-permission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: key, allowed })
      });
      if (!res.ok) {
        onNotice("Failed to update agent access");
        return;
      }
      onNotice(allowed ? "Agent access enabled" : "Agent access disabled");
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Failed to update agent access");
    }
  };

  const killSessionByRef = async (s: SwitcherSession) => {
    const label = s.displayName || s.name;
    if (!window.confirm(`Kill session "${label}" for all participants? Its running process is terminated.`)) {
      return;
    }
    try {
      const res = await fetch("/api/sessions/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(s) })
      });
      if (!res.ok) {
        onNotice("Failed to kill session");
        return;
      }
      onNotice(`Killed ${label}`);
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Failed to kill session");
    }
  };
  // Reclassify origin (user <-> agent): adopting an agent-spawned session you
  // now drive yourself (a forked conversation, a worker you took over) moves
  // it to the user side of the origin filter — and into default restore.
  const toggleOrigin = async () => {
    if (!sheet) return;
    const next = sheet.session.createdBy === "agent" ? "user" : "agent";
    try {
      const res = await fetch("/api/sessions/origin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(sheet.session), createdBy: next })
      });
      if (!res.ok) {
        onNotice("Failed to change session origin");
        return;
      }
      onNotice(next === "user" ? "Moved to user sessions" : "Moved to agent sessions");
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Failed to change session origin");
    }
  };

  const killSession = async () => {
    if (!sheet) return;
    await killSessionByRef(sheet.session);
  };
  // Park: hide from the wall, keep running — instant bring-back via the
  // parked section or the filter. Unparking also clears the archived flag.
  const togglePark = async () => {
    if (!sheet) return;
    const next = sheet.session.parked !== true;
    try {
      const res = await fetch("/api/sessions/park", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(sheet.session), parked: next })
      });
      if (!res.ok) {
        onNotice("Failed to update park state");
        return;
      }
      onNotice(next ? "Parked — find it under “parked” at the bottom" : "Back on the wall");
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Failed to update park state");
    }
  };
  // Archive: stop the process but stay resumable — the daemon pre-writes the
  // resume command into the session's startup, so reopening it later picks
  // the conversation back up.
  const archiveSession = async () => {
    if (!sheet) return;
    try {
      const res = await fetch("/api/sessions/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalName: sessionKey(sheet.session) })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { error?: string }));
        onNotice(data.error || "Failed to stop session");
        return;
      }
      onNotice("Stopped & parked — opening it later resumes the conversation");
      setSheet(null);
      onRefresh();
    } catch {
      onNotice("Failed to stop session");
    }
  };
  const startRename = (s: SwitcherSession, anchor?: { x: number; y: number }) => {
    setRenameDraft(s.displayName || s.name);
    // Anchor is REQUIRED by the sheet's positioning math — a missing one
    // crashed the render (the ⋯ gray-screen bug's sibling). Default centers.
    setSheet({
      session: s,
      mode: "rename",
      anchor: anchor ?? { x: window.innerWidth / 2 + 132, y: window.innerHeight / 3 }
    });
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    const next = createDraft.trim();
    if (!next) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(next)) {
      onNotice("Only letters, numbers, - and _ allowed");
      return;
    }
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next, type: "terminal", port: null })
      });
      const data = await res.json().catch(() => ({} as { name?: string; error?: string }));
      if (!res.ok || !data.name) {
        onNotice(data.error || "Failed to create session");
        return;
      }
      setCreating(false);
      setCreateDraft("");
      onSwitch({ name: data.name, displayName: data.name, active: false, starting: true, internalName: data.name });
    } catch {
      onNotice("Failed to create session");
    }
  };

  if (!open) return null;

  const now = Date.now();

  const dots = (s: SwitcherSession) =>
    (s.bellUnseen || s.unread) && (
      <span
        className={`attention-dot ${s.bellUnseen ? "bell" : "output"}`}
        title={s.bellUnseen ? "Bell rung since last viewed" : "New output since last viewed"}
      />
    );

  // Claude Code titles its process with a bare version number — label it.
  const appLabel = (s: SwitcherSession) => {
    const app = runningApp(s);
    if (!app) return "";
    return /^\d+\.\d+\.\d+$/.test(app) ? "claude" : app;
  };

  // Home-shortened path, full tail preserved: the workdir IS the identity of a
  // session, so it gets its own flexible span (left-ellipsized in CSS — the
  // END of the path is the part that matters).
  const dirPath = (s: SwitcherSession) => {
    const p = s.cwd || "";
    if (!p) return "";
    return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^\/root(?=\/|$)/, "~");
  };

  // Compact right-side meta: time first, app demoted to last (least important).
  const meta = (s: SwitcherSession) => {
    const parts: string[] = [];
    const rel = relativeTime(s.lastActivityAt || 0, now);
    if (rel) parts.push(rel);
    const app = appLabel(s);
    if (app) parts.push(app);
    return parts.join(" · ");
  };

  const isCurrentSession = (s: SwitcherSession) =>
    currentRoom !== null && (s.internalName === currentRoom || s.name === currentRoom);

  const pressHandlers = (s: SwitcherSession) => ({
    onPointerDown: (e: ReactPointerEvent) => startLongPress(e, s),
    onPointerUp: cancelLongPress,
    onPointerLeave: cancelLongPress,
    onPointerMove: moveLongPress,
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      suppressTapRef.current = false;
      openSheet(s, { x: e.clientX, y: e.clientY });
    }
  });

  // `snippet` (search content hits): the matching output line, shown under
  // the preview so the card says WHY it matched.
  const renderCard = (s: SwitcherSession, snippet?: string) => {
    const key = sessionKey(s);
    const preview = previewCacheRef.current!.get(key);
    const current = isCurrentSession(s);
    const kbdSelected = navIndexByKey.get(key) === kbdIndex;
    // The frozen wall trades movement for a signal-in-place: a session
    // producing output RIGHT NOW glows instead of jumping to the top.
    // Window comfortably exceeds the 10s relative-time tick so a busy
    // session's glow holds steady rather than flickering between polls.
    const activeNow = !current && now - (s.lastActivityAt || 0) < 12000;
    // Manual mode: cards are draggable to reorder. The focused tile drags
    // from its header only (see dragArmKey) so its terminal keeps the
    // pointer for text selection; every other card drags from anywhere.
    const isFocusedCard = focusedKey === key;
    const draggable = sortMode === "manual" && (!isFocusedCard || dragArmKey === key);
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        data-nav-index={navIndexByKey.get(key)}
        className={`switcher-card${current ? " current" : ""}${activeNow ? " active-now" : ""}${kbdSelected ? " kbd-selected" : ""}${focusedKey === key ? " focused" : ""}${dragKey === key ? " dragging" : ""}${draggable ? " draggable" : ""}`}
        draggable={draggable}
        onDragStart={draggable ? (e) => { setDragKey(key); e.dataTransfer.effectAllowed = "move"; } : undefined}
        onDragEnter={draggable ? () => { if (dragKey && dragKey !== key) moveManual(dragKey, key); } : undefined}
        onDragOver={draggable ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } : undefined}
        // Order was already applied live during the drag — drop/end just clean up.
        // The release click after a drag must NEVER act — reordering ending
        // with "you are now inside a terminal" is a drag that went off a
        // cliff. Same suppression the long-press sheet uses.
        onDrop={draggable ? (e) => { e.preventDefault(); suppressTapRef.current = true; setDragKey(null); } : undefined}
        onDragEnd={draggable ? () => { suppressTapRef.current = true; setDragKey(null); window.setTimeout(() => { suppressTapRef.current = false; }, 250); } : undefined}
        onClick={(e) => {
          // Post-drag / post-long-press release: not a click.
          if (suppressTapRef.current) {
            suppressTapRef.current = false;
            return;
          }
          // Only a click on the TERMINAL AREA focuses the tile — clicking
          // the header/name/meta switches. A whole-card focus target meant
          // any stray click at interactive zoom silently rerouted the
          // keyboard into that session ("typing goes to a terminal").
          const el = e.target as HTMLElement | null;
          const onTerminalArea = !!el?.closest?.(".switcher-preview, .switcher-live-tile");
          if (interactiveTiles && s.active && s.type !== "port" && onTerminalArea) {
            setFocusedKey(key);
            onFocusSession?.(s);
            // The keyboard selection (accent outline + tinted background)
            // follows explicit interaction — otherwise it lingers on the
            // previous current card, reading as a stale current-marker.
            const idx = flatNav.findIndex((x) => sessionKey(x) === key);
            if (idx >= 0) setKbdIndex(idx);
          } else handleTap(s);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            // ⌘⏎ focuses the tile; plain Enter switches (mirrors onNavKey).
            if ((e.metaKey || e.ctrlKey) && interactiveTiles && s.active && s.type !== "port") {
              setFocusedKey(key);
              onFocusSession?.(s);
              const idx = flatNav.findIndex((x) => sessionKey(x) === key);
              if (idx >= 0) setKbdIndex(idx);
            } else handleTap(s);
          }
        }}
        {...pressHandlers(s)}
      >
        <div
          className={`switcher-card-head${sortMode === "manual" && isFocusedCard ? " drag-handle" : ""}`}
          onPointerDown={sortMode === "manual" && isFocusedCard ? () => setDragArmKey(key) : undefined}
        >
          {dots(s)}
          <span className="switcher-card-name">{s.displayName}</span>
          {current && <span className="switcher-chip current">CURRENT</span>}
          {originScope === "all" && s.createdBy === "agent" && (
            <span
              className={"switcher-chip agent" + (s.createdVia === "cli-agent-env" ? " inferred" : "")}
              title={
                s.createdVia === "mcp" ? "Started by an agent over MCP"
                  : s.createdVia === "hopa" ? "Started by an agent via the hopa CLI"
                  : s.createdVia === "cli-agent-env" ? "Guessed from the hop CLI's environment (CLAUDECODE) — not a dedicated agent interface, so this label can be wrong"
                  : "Marked as an agent session"
              }
            >
              AGENT{s.createdVia === "cli-agent-env" ? "?" : ""}
            </span>
          )}
          {!current && s.starting && !s.active && <span className="switcher-chip starting">STARTING</span>}
          {waitingOnUser(preview) && (
            <span className="switcher-chip waiting" title="Claude is asking how to resume this conversation — open it and choose">
              NEEDS YOU
            </span>
          )}
          {inlineActions(s)}
        </div>
        {/* Tagline sits directly under the name: it explains the session the
            way the name can't. Hidden at dense zooms where the card has no
            room for a second text line. */}
        {s.tagline && <div className="switcher-card-tagline" title={s.tagline}>{s.tagline}</div>}
        {interactiveTiles && tileWsBase && s.active && s.type !== "port" ? (
          <div className="switcher-preview switcher-preview-live">
            <LiveTile
              wsBase={tileWsBase}
              room={key}
              userName={userName || "user"}
              theme={terminalTheme}
              live={focusedKey === key}
              claudeApp={appLabel(s) === "claude"}
              claimSize={s.hasLocalCli !== true}
              activeCols={preview?.cols}
              activeRows={preview?.rows}
              onFullscreen={() => onSwitch(s)}
              onUnfocus={() => setFocusedKey(null)}
            />
          </div>
        ) : (
          <pre className="switcher-preview" aria-hidden="true">
            {preview?.color?.length && preview.cols && preview.rows && effectiveZoom >= INTERACTIVE_ZOOM
              ? <ScaledScreen frame={preview} />
              : preview?.color?.length
                ? renderPreviewRuns(preview.color)
                : (preview?.text || " ")}
          </pre>
        )}
        {snippet && <div className="switcher-card-snippet" title={snippet}>{snippet}</div>}
        <div className="switcher-card-meta">
          <span className="switcher-card-dir" title={s.cwd || undefined}>{dirPath(s) ? `\u200E${dirPath(s)}\u200E` : "\u00a0"}</span>
          <span className="switcher-card-when">{meta(s)}</span>
        </div>
      </div>
    );
  };

  // Inline quick actions (desktop hover): rename + kill without the sheet.
  const inlineActions = (s: SwitcherSession) => (
    <span className="switcher-inline-actions">
      <button
        type="button"
        className="switcher-icon-btn"
        aria-label={`Rename ${s.displayName}`}
        title="Rename"
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); startRename(s, { x: r.right, y: r.bottom }); }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
      <button
        type="button"
        className="switcher-icon-btn danger"
        aria-label={`Kill ${s.displayName}`}
        title="Kill session"
        onClick={(e) => { e.stopPropagation(); killSessionByRef(s); }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>
      </button>
      <button
        type="button"
        className="switcher-icon-btn"
        aria-label={`More actions for ${s.displayName}`}
        title="More"
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openSheet(s, { x: r.right, y: r.bottom }); }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        ⋯
      </button>
    </span>
  );

  const sheetSession = sheet?.session;
  const sheetAgentPermitted = sheetSession?.agentPermitted === true;

  return (
    <div
      // tile-dense: too narrow for inline actions. tile-micro: too short for
      // a second text line at all — the tagline shows from the DEFAULT zoom
      // up (hiding it there meant nobody ever saw one).
      className={`switcher-overlay${zoomLevel.min < 300 ? " tile-dense" : ""}${zoomLevel.min < 150 ? " tile-micro" : ""}${dismissable ? "" : " switcher-hub"}${dismissable ? " switcher-fullscreen" : ""}`}
      style={{ "--tile-min": `${zoomLevel.min}px`, "--tile-h": zoomLevel.h, "--tile-fs": zoomLevel.fs } as CSSProperties}
      role="dialog"
      aria-label="Sessions"
      // Always fullscreen: there is no backdrop, and a stray click must not
      // dismiss the wall and flash the terminal behind it. Escape/✕ close.
    >
      <div className="switcher-top">
        <header className="switcher-header">
          <h2>Sessions</h2>
          <span className="switcher-count">{visibleSessions.length}</span>
          {originScope !== "agent" && (
            <button
              type="button"
              className="switcher-new-top"
              title="New session"
              aria-label="New session"
              onClick={() => setCreating(true)}
            >
              ＋ New
            </button>
          )}
          <div className="switcher-tilesize" role="group" aria-label="Tile zoom">
            <button
              type="button"
              aria-label="Smaller tiles"
              title="Smaller tiles (−)"
              disabled={effectiveZoom <= 0}
              onClick={() => changeZoom(effectiveZoom - 1)}
            >
              −
            </button>
            <span className="switcher-zoom-readout" aria-hidden="true">
              {effectiveZoom + 1}
            </span>
            <button
              type="button"
              aria-label="Bigger tiles"
              title={effectiveZoom >= maxZoom ? "Tiles already span the full width" : "Bigger tiles (+)"}
              disabled={effectiveZoom >= maxZoom}
              onClick={() => changeZoom(effectiveZoom + 1)}
            >
              +
            </button>
          </div>
          {interactiveTiles && (
            <span
              className="switcher-chip live"
              title="Tiles are live terminals at this zoom — click one to type in it. ⌘⏎ opens it full screen, ⌘. releases it."
            >
              ⌨ interactive
            </span>
          )}
          <span className="switcher-header-spacer" />
          {onToggleKeyboard && (
            <button type="button" className="switcher-action" aria-label="Toggle keyboard" title="Toggle keyboard" onClick={onToggleKeyboard}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="14" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8"/>
              </svg>
            </button>
          )}
          {onFind && (
            <button type="button" className="switcher-action" aria-label="Find in terminal" title="Find in terminal" onClick={onFind}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
              </svg>
            </button>
          )}
          {onOpenSettings && (
            <button type="button" className="switcher-action" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          )}
          {dismissable && (
            <button type="button" className="switcher-close" aria-label="Close switcher" onClick={onClose}>
              ✕
            </button>
          )}
        </header>
        <div className="switcher-filter-row">
          <div className="switcher-origin" role="group" aria-label="Session origin">
            {([
              ["user", "User"],
              ["agent", "Agent"],
              ["all", "All"]
            ] as const).map(([scope, label]) => (
              <button
                key={scope}
                type="button"
                className={originScope === scope ? "active" : ""}
                aria-pressed={originScope === scope}
                onClick={() => {
                  setOriginScope(scope);
                  setCreating(false);
                  // Scope change relays a different population — refreeze.
                  frozenOrderRef.current = null;
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="switcher-origin switcher-sort" role="group" aria-label="Organize sessions by">
            {([
              ["recent", "Recent", "Most recently active first"],
              ["project", "Project", "Grouped by working directory"],
              ["manual", "Manual", "Your own drag order"]
            ] as const).map(([mode, label, title]) => (
              <button
                key={mode}
                type="button"
                className={sortMode === mode ? "active" : ""}
                aria-pressed={sortMode === mode}
                title={title}
                onClick={() => changeSortMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          {sortMode === "project" && (
            <div className="switcher-origin switcher-density" role="group" aria-label="Project view density">
              {([
                [false, "Sections", "A header per project"],
                [true, "Compact", "One continuous grid — the project is on each card"]
              ] as const).map(([compact, label, title]) => (
                <button
                  key={label}
                  type="button"
                  className={projectCompact === compact ? "active" : ""}
                  aria-pressed={projectCompact === compact}
                  title={title}
                  onClick={() => changeProjectCompact(compact)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {/* Always rendered: it is the palette's focus home. When it wasn't
              (coarse pointer + a short list) there was nowhere to put focus,
              so keystrokes fell through to the terminal behind. */}
          <input
            ref={filterInputRef}
            className={`switcher-filter${finePointer || visibleSessions.length > FILTER_THRESHOLD || filter ? "" : " compact"}`}
            placeholder="Filter…"
            value={filter}
            onChange={(e) => { setFocusedKey(null); setFilter(e.target.value); }}
            aria-label="Filter sessions"
          />
        </div>
        {/* Create form lives in the top bar so the header ＋ works from EVERY
            mode — the dashed grid card only exists in recent mode. */}
        {creating && (
          <form className="switcher-create-row inline-edit" onSubmit={submitCreate}>
            <input
              placeholder="session-name"
              value={createDraft}
              onChange={(e) => setCreateDraft(e.target.value)}
              maxLength={64}
              autoFocus
              aria-label="New session name"
            />
            <button type="submit">Create</button>
            <button type="button" onClick={() => { setCreating(false); setCreateDraft(""); }}>✕</button>
          </form>
        )}
      </div>
      <div className="switcher-scroll" ref={scrollRef} onContextMenu={openWallMenu}>
        {model.mode === "filter" ? (
          // Matches keep their terminal previews: search results are preview
          // cards at the current zoom, same as the wall — the screen content
          // is usually WHY you're looking for the session.
          <>
            {model.rows.length === 0 && extraContentMatches.length === 0 ? (
              <div className="switcher-empty">No sessions match “{filter.trim()}”</div>
            ) : (
              <div className="switcher-grid">{model.rows.map((s) => renderCard(s))}</div>
            )}
            {extraContentMatches.length > 0 && (
              <section className="switcher-group">
                <h3 className="switcher-group-label">found in terminal output</h3>
                <div className="switcher-grid">
                  {extraContentMatches.map(({ session: s, snippet }) => renderCard(s, snippet))}
                </div>
              </section>
            )}
          </>
        ) : model.mode === "project" ? (
          <>
            {originScope === "agent" && visibleSessions.length === 0 && (
              <div className="switcher-empty">No agent sessions</div>
            )}
            {projectCompact ? (
              // Compact: group ORDER is kept (recency-ranked projects), but
              // everything flows in one grid — the card's workdir line names
              // the project, so section headers only cost rows.
              <div className="switcher-grid">
                {model.groups.flatMap((group) => group.rows).map((s) => renderCard(s))}
              </div>
            ) : (
              model.groups.map((group) => (
                <section key={group.label} className="switcher-group">
                  <h3 className="switcher-group-label">{group.label}</h3>
                  <div className="switcher-grid">{group.rows.map((s) => renderCard(s))}</div>
                </section>
              ))
            )}
          </>
        ) : model.mode === "manual" ? (
          <>
            {model.rows.length === 0 && model.folders.every((f) => f.rows.length === 0) ? (
              <div className="switcher-empty">{filter.trim() ? "No matches" : "No sessions"}</div>
            ) : (
              <>
                <p className="switcher-hint">
                  {filter.trim()
                    ? "Showing matches in your order — drag one next to another (or ⌥↑/⌥↓); the move applies to the full list"
                    : "Drag tiles to reorder, or onto a folder to file them"}
                  <button type="button" className="switcher-folder-new" onClick={createFolder}>+ New folder</button>
                </p>
                {model.folders.map(({ folder, rows }) => (
                  <section
                    key={folder.id}
                    className={"switcher-group switcher-folder" + (dropFolder === folder.id ? " drop-target" : "")}
                    onDragOver={(e) => { e.preventDefault(); setDropFolder(folder.id); }}
                    onDragLeave={() => setDropFolder((cur) => (cur === folder.id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropFolder(null);
                      suppressTapRef.current = true;
                      if (dragKey) fileSession(dragKey, folder.id);
                      setDragKey(null);
                    }}
                  >
                    <h3 className="switcher-group-label" onContextMenu={(e) => openFolderMenu(e, folder)}>
                      {folder.name}
                      <span className="switcher-folder-count">{rows.length}</span>
                      <button type="button" onClick={() => renameFolder(folder)} title="Rename folder">✎</button>
                      <button type="button" onClick={() => deleteFolder(folder)} title="Delete folder">🗑</button>
                    </h3>
                    {rows.length === 0 ? (
                      <p className="switcher-folder-empty">Drag a session here</p>
                    ) : (
                      <div className="switcher-grid">{rows.map((s) => renderCard(s))}</div>
                    )}
                  </section>
                ))}
                {model.folders.length > 0 && model.rows.length > 0 && (
                  <h3
                    className={"switcher-group-label switcher-unfiled" + (dropFolder === "" ? " drop-target" : "")}
                    onDragOver={(e) => { e.preventDefault(); setDropFolder(""); }}
                    onDragLeave={() => setDropFolder((cur) => (cur === "" ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropFolder(null);
                      suppressTapRef.current = true;
                      if (dragKey) fileSession(dragKey, null); // drop here to unfile
                      setDragKey(null);
                    }}
                  >
                    Unfiled
                  </h3>
                )}
                <div className="switcher-grid">{model.rows.map((s) => renderCard(s))}</div>
              </>
            )}
          </>
        ) : (
          <>
            {originScope === "agent" && visibleSessions.length === 0 && (
              <div className="switcher-empty">No agent sessions</div>
            )}
            <div className="switcher-grid">
              {model.hero.map((s) => renderCard(s))}
              {originScope !== "agent" && !creating && (
                <button type="button" className="switcher-card new" onClick={() => setCreating(true)}>
                  <span className="switcher-new-plus">+</span>
                  <span>New session</span>
                </button>
              )}
            </div>
            {model.groups.map((group) => (
              <section key={group.label || "tail"} className="switcher-group">
                {group.label && <h3 className="switcher-group-label">{group.label}</h3>}
                <div className="switcher-grid">{group.rows.map((s) => renderCard(s))}</div>
              </section>
            ))}
          </>
        )}
        {model.mode !== "filter" && parkedSessions.length > 0 && (
          <section className="switcher-group switcher-parked">
            <button
              type="button"
              className="switcher-parked-toggle"
              aria-expanded={parkedOpen}
              onClick={() => setParkedOpen((v) => !v)}
            >
              {parkedOpen ? "▾" : "▸"} parked · {parkedSessions.length}
            </button>
            {parkedOpen && (
              <div className="switcher-rows">
                {parkedSessions.map((s) => {
                  const key = sessionKey(s);
                  return (
                    <div
                      key={key}
                      role="button"
                      tabIndex={0}
                      className="switcher-row parked"
                      onClick={() => handleTap(s)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) handleTap(s); }}
                      {...pressHandlers(s)}
                    >
                      {dots(s)}
                      <span className="switcher-row-name">{s.displayName}</span>
                      <span className="switcher-chip">{s.active ? "PARKED" : "STOPPED"}</span>
                      {s.tagline && <span className="switcher-row-dir">{s.tagline}</span>}
                      <span className="switcher-row-meta">{meta(s)}</span>
                      {inlineActions(s)}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
      {sheet && sheetSession && (
        <>
          <div className="switcher-sheet-backdrop" onClick={() => setSheet(null)} />
          <div
            className="switcher-sheet"
            role="menu"
            aria-label={`Actions for ${sheetSession.displayName}`}
            style={(() => {
              const width = 264;
              const estH = sheet.mode === "rename" ? 140 : 340;
              const left = Math.min(Math.max(8, sheet.anchor.x - width), window.innerWidth - width - 8);
              let top = sheet.anchor.y + 8;
              if (top + estH > window.innerHeight - 8) top = Math.max(8, sheet.anchor.y - estH - 8);
              return { left, top };
            })()}
          >
            <p className="switcher-sheet-title">{sheetSession.displayName}</p>
            {sheet.mode === "rename" ? (
              <form className="inline-edit" onSubmit={submitRename}>
                <input
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  maxLength={64}
                  autoFocus
                  aria-label="New session name"
                />
                <button type="submit">Save</button>
                <button type="button" onClick={() => setSheet({ session: sheetSession, mode: "menu", anchor: sheet.anchor })}>✕</button>
              </form>
            ) : (
              <>
                {!isCurrentSession(sheetSession) && (
                  <button type="button" onClick={() => handleTap(sheetSession)}>Switch to</button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setRenameDraft(sheetSession.displayName || sheetSession.name);
                    setSheet({ session: sheetSession, mode: "rename", anchor: sheet.anchor });
                  }}
                >
                  Rename
                </button>
                {sheetSession.type !== "port" && (
                  <button type="button" onClick={toggleAgentAccess}>
                    {sheetAgentPermitted ? "Disable agent access" : "Enable agent access"}
                  </button>
                )}
                {sheetSession.type !== "port" && (
                  <button type="button" onClick={toggleOrigin}>
                    {sheetSession.createdBy === "agent" ? "Move to user sessions" : "Move to agent sessions"}
                  </button>
                )}
                {sheetSession.type !== "port" && (
                  <button type="button" onClick={togglePark}>
                    {sheetSession.parked ? "Unpark session" : "Park session"}
                  </button>
                )}
                {sheetSession.type !== "port" && sheetSession.active && (
                  <button type="button" onClick={archiveSession}>
                    Stop &amp; park (resumable)
                  </button>
                )}
                <button type="button" className="danger" onClick={killSession}>
                  Kill session
                </button>
                <button type="button" onClick={() => setSheet(null)}>Cancel</button>
              </>
            )}
          </div>
        </>
      )}
      <ContextMenu request={menu} onClose={() => setMenu(null)} />
    </div>
  );
};
