// Drag-and-drop helpers. Browsers deliberately never expose a dropped file's
// real filesystem path. When hop runs on the machine the file is on, the
// daemon finds it by name, size and modified time (or the Mac app hands over
// the real path) and its own path is pasted — nothing copied. Otherwise hop
// uploads the BYTES to the host and pastes the path the file landed on. The
// path hint below survives as the fallback for when neither can happen.

/** Quote a path for a shell only when it needs it. A bare path stays bare —
 *  most drops land somewhere boring, and gratuitous quotes read as noise in
 *  an agent's composer. Single-quote style, with the standard '\'' escape. */
export const shellQuotePath = (filePath: string): string => {
  if (filePath === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(filePath)) return filePath;
  return `'${filePath.replace(/'/g, `'\\''`)}'`;
};

/** Join uploaded paths into one paste: space-separated, each quoted only if
 *  it must be. Reads as a command argument list, which is what it usually
 *  becomes. */
export const pasteableUploadPaths = (paths: string[]): string =>
  paths.map(shellQuotePath).join(" ");

/** OS-specific "copy the file's path" hotkey hint. Pass a platform string
 *  (navigator.platform + userAgent); pure so it's unit-testable. */
export const originalPathHint = (platform: string): string => {
  if (/Mac|iPhone|iPad/i.test(platform)) {
    return "Browsers can't see file paths — select the file in Finder, press ⌘⌥C, then paste here.";
  }
  if (/Win/i.test(platform)) {
    return "Browsers can't see file paths — select the file in Explorer, press Ctrl+Shift+C, then paste here.";
  }
  return "Browsers can't see file paths — copy the path in your file manager, then paste here.";
};

/** Where each dropped file already is on the hop machine, or null to upload
 *  it. The Mac app hands over the real paths as the files are dragged over
 *  its window (window.__hopDragPaths, taken once here); a browser only has
 *  name, size and modified time, which the daemon searches for. Bounded: a
 *  slow or absent daemon means "upload", never a drop that hangs. */
export const locateDroppedFiles = async (session: string, files: File[], timeoutMs = 8000): Promise<Array<string | null>> => {
  const w = window as { __hopDragPaths?: string[] };
  const native = w.__hopDragPaths;
  w.__hopDragPaths = undefined;
  const none = files.map(() => null);
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? window.setTimeout(() => ctl.abort(), timeoutMs) : 0;
  try {
    const res = await fetch("/api/files/locate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: ctl?.signal,
      body: JSON.stringify({
        name: session,
        files: files.map((f) => ({
          name: f.name, size: f.size, lastModified: f.lastModified,
          path: native?.find((p) => p.split("/").pop() === f.name)
        }))
      })
    });
    if (!res.ok) return none;
    const d = await res.json().catch(() => null) as { paths?: Array<string | null> } | null;
    return Array.isArray(d?.paths) && d!.paths.length === files.length ? d!.paths : none;
  } catch {
    return none; // an older daemon, none reachable, or too slow: upload
  } finally {
    if (timer) window.clearTimeout(timer);
  }
};
