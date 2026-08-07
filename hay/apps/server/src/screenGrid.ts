// Server-side screen state — the authoritative grid behind serialized attach.
//
// The attach snapshot used to be a raw byte TAIL of the output ring. For
// incremental TUIs (Claude Code/Ink) a tail is structurally incomplete: rows
// that haven't changed recently were emitted before the tail window began, so
// a freshly attached client rendered holes until the app happened to repaint.
// That is the whole "have to scroll before it renders correctly" bug — the
// wheel event reaches the app through mouse reporting and provokes a redraw
// that resends the pixels the snapshot never carried.
//
// Feeding the room's output through a headless terminal instead means every
// attach can serialize the complete current screen — a few KB, always whole —
// and the resize "wiggle" repaint trick becomes unnecessary on this path.
//
// Loaded lazily and failure-tolerant: when @xterm/headless is unavailable a
// room silently falls back to the raw-tail snapshot (+ wiggle), so a broken
// dependency degrades to the old behavior instead of breaking attach.

type HeadlessTerminal = {
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  loadAddon(addon: unknown): void;
  dispose(): void;
};

type SerializeAddonLike = {
  serialize(options?: { scrollback?: number }): string;
};

type GridDeps = {
  Terminal: new (options: Record<string, unknown>) => HeadlessTerminal;
  SerializeAddon: new () => SerializeAddonLike;
};

// Scrollback lines the grid retains (and serialized attaches can carry).
// This bounds host memory per room — deeper history stays in the raw output
// ring and reaches clients through the existing deep-history replay path.
export const GRID_SCROLLBACK = (() => {
  const env = Number(process.env.HAY_GRID_SCROLLBACK);
  return Number.isFinite(env) && env >= 0 ? Math.floor(env) : 1000;
})();
// Preserve ordinary shrink/grow sequences exactly while bounding an abusive
// resize storm's retained work behind a single xterm write marker.
const MAX_QUEUED_RESIZE_TRANSITIONS = 256;

let deps: GridDeps | null = null;
let loading: Promise<boolean> | null = null;

export const screenGridsAvailable = (): boolean => deps !== null;

export const loadScreenGridDeps = (): Promise<boolean> => {
  if (deps) return Promise.resolve(true);
  if (loading) return loading;
  loading = (async () => {
    try {
      // Some xterm builds touch browser globals at import time; shim the few
      // they reach for (same trick the daemon uses for preview rendering).
      const g = globalThis as Record<string, unknown>;
      if (!g.window) g.window = g;
      if (!g.self) g.self = g;
      const [headless, serialize] = await Promise.all([
        import("@xterm/headless"),
        import("@xterm/addon-serialize")
      ]);
      // Both packages ship UMD/CJS: under Node's ESM interop the named
      // exports may only exist on `default`, so check both shapes.
      type HeadlessModule = { Terminal?: GridDeps["Terminal"]; default?: { Terminal?: GridDeps["Terminal"] } };
      type SerializeModule = { SerializeAddon?: GridDeps["SerializeAddon"]; default?: { SerializeAddon?: GridDeps["SerializeAddon"] } };
      const Terminal = (headless as HeadlessModule).Terminal ?? (headless as HeadlessModule).default?.Terminal;
      const SerializeAddon = (serialize as SerializeModule).SerializeAddon
        ?? (serialize as SerializeModule).default?.SerializeAddon;
      if (typeof Terminal !== "function" || typeof SerializeAddon !== "function") {
        console.log("[hay] serialized attach unavailable (xterm exports not found) — raw-tail snapshots");
        return false;
      }
      deps = { Terminal, SerializeAddon };
      return true;
    } catch (error) {
      console.log(`[hay] serialized attach unavailable (${(error as Error)?.message || "load failed"}) — raw-tail snapshots`);
      return false;
    }
  })();
  return loading;
};

export type ScreenGrid = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /**
   * Serialize AFTER everything already written has been parsed (xterm's
   * write path is asynchronous). Calls back with null on failure so the
   * caller can fall back to the raw-tail snapshot. `scrollback` bounds how
   * many history lines ride along (tiles need far fewer than a full screen).
   */
  serialize(callback: (data: string | null) => void, scrollback?: number): void;
  dispose(): void;
};

export const createScreenGrid = (cols: number, rows: number): ScreenGrid | null => {
  if (!deps) return null;
  let term: HeadlessTerminal;
  let addon: SerializeAddonLike;
  try {
    term = new deps.Terminal({
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      scrollback: GRID_SCROLLBACK,
      allowProposedApi: true
    });
    addon = new deps.SerializeAddon();
    term.loadAddon(addon);
  } catch {
    return null;
  }
  let disposed = false;
  let coalescibleResizes: number[] | null = null;
  return {
    write(data: string) {
      if (disposed) return;
      // Output is an ordering boundary: a later resize must run after it,
      // rather than coalescing into a resize marker queued before it.
      if (data) coalescibleResizes = null;
      try { term.write(data); } catch { /* parser hiccup — next write continues */ }
    },
    resize(nextCols: number, nextRows: number) {
      if (disposed) return;
      const cols = Math.max(2, nextCols);
      const rows = Math.max(1, nextRows);
      if (coalescibleResizes) {
        if (coalescibleResizes.length < MAX_QUEUED_RESIZE_TRANSITIONS * 2) {
          coalescibleResizes.push(cols, rows);
        } else {
          coalescibleResizes[coalescibleResizes.length - 2] = cols;
          coalescibleResizes[coalescibleResizes.length - 1] = rows;
        }
        return;
      }
      const scheduled = [cols, rows];
      coalescibleResizes = scheduled;
      try {
        // xterm parses write() asynchronously. Queue the resize behind every
        // earlier byte so room order stays PTY output → SIGWINCH, while later
        // writes naturally queue behind this callback's synchronous resize.
        // Consecutive resizes share this marker. Replay ordinary geometry
        // changes exactly: shrink/grow transitions mutate xterm's grid even
        // without output. Only an abusive overflow degrades to the latest size.
        term.write("", () => {
          if (disposed) return;
          if (coalescibleResizes === scheduled) coalescibleResizes = null;
          for (let i = 0; i < scheduled.length; i += 2) {
            try { term.resize(scheduled[i], scheduled[i + 1]); } catch { /* keep previous size */ }
          }
        });
      } catch {
        if (coalescibleResizes === scheduled) coalescibleResizes = null;
      }
    },
    serialize(callback: (data: string | null) => void, scrollback: number = GRID_SCROLLBACK) {
      if (disposed) { callback(null); return; }
      // A later resize must not move ahead of this point-in-time snapshot.
      coalescibleResizes = null;
      try {
        // An empty write's callback fires once all queued data has parsed —
        // the serialize then reflects every byte up to this attach.
        term.write("", () => {
          if (disposed) { callback(null); return; }
          try {
            callback(addon.serialize({ scrollback: Math.max(0, Math.min(scrollback, GRID_SCROLLBACK)) }));
          } catch {
            callback(null);
          }
        });
      } catch {
        callback(null);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { term.dispose(); } catch { /* already gone */ }
    }
  };
};
