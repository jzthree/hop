// Inline blocks for `hop view` deliveries. The CLI prints, on a TTY, an OSC
// 7701 sequence carrying the delivery (session, file, title, size, URL) and
// then a four-line text box. The OSC is invisible to every terminal that
// does not know it, so the text box is what a plain terminal, the phone and
// a scrollback show; here the OSC anchors an xterm decoration over those
// four lines — a small card with the title, the file, a thumbnail for an
// image, and an Open button that lands in the Views reader on that item.
//
// The card rides in the output stream, so it survives a reconnect, a
// restore replay and scrolling: it is where the delivery happened.

export type ViewBlock = {
  session: string;
  name: string;
  title?: string;
  bytes?: number;
  url: string;
};

export const VIEW_BLOCK_OSC = 7701;
export const VIEW_BLOCK_ROWS = 4;

/** `hop-view;<base64 json>` → the delivery, or null for anything else. */
export const parseViewBlock = (data: string): ViewBlock | null => {
  const m = /^hop-view;([A-Za-z0-9+/=]+)$/.exec(String(data || "").trim());
  if (!m) return null;
  try {
    // UTF-8 inside base64: decode bytes, then text (a title can carry any script).
    const bin = atob(m[1]);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const o = JSON.parse(json);
    if (!o || typeof o.session !== "string" || typeof o.name !== "string" || typeof o.url !== "string") return null;
    return { session: o.session, name: o.name, url: o.url, title: typeof o.title === "string" ? o.title : undefined, bytes: Number.isFinite(o.bytes) ? Number(o.bytes) : undefined };
  } catch {
    return null;
  }
};

export const fmtBytes = (n?: number): string => {
  if (!Number.isFinite(n as number) || (n as number) < 0) return "";
  const b = n as number;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

export const viewKind = (name: string): "image" | "pdf" | "html" | "markdown" | "video" | "file" => {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["html", "htm"].includes(ext)) return "html";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["mp4", "webm", "mov"].includes(ext)) return "video";
  return "file";
};

const GLYPH: Record<ReturnType<typeof viewKind>, string> = { image: "🖼", pdf: "📄", html: "🌐", markdown: "📝", video: "🎞", file: "📎" };

/** Fill a decoration's element with the card. Idempotent per render. */
export const renderViewBlock = (el: HTMLElement, block: ViewBlock, onOpen: (b: ViewBlock) => void) => {
  if (el.dataset.viewBlock === block.url) return;
  el.dataset.viewBlock = block.url;
  el.classList.add("view-block-host");
  el.innerHTML = "";
  const kind = viewKind(block.name);
  const card = document.createElement("div");
  card.className = `view-block kind-${kind}`;
  card.title = "Open in the Views reader";
  if (kind === "image") {
    const img = document.createElement("img");
    img.className = "view-block-thumb";
    img.src = block.url;
    img.alt = "";
    img.loading = "lazy";
    card.appendChild(img);
  } else {
    const glyph = document.createElement("span");
    glyph.className = "view-block-glyph";
    glyph.textContent = GLYPH[kind];
    card.appendChild(glyph);
  }
  const text = document.createElement("div");
  text.className = "view-block-text";
  const title = document.createElement("div");
  title.className = "view-block-title";
  title.textContent = block.title || block.name;
  const meta = document.createElement("div");
  meta.className = "view-block-meta";
  meta.textContent = [block.title ? block.name : "", fmtBytes(block.bytes)].filter(Boolean).join(" · ") || "hop view";
  text.appendChild(title);
  text.appendChild(meta);
  card.appendChild(text);
  const open = document.createElement("button");
  open.type = "button";
  open.className = "view-block-open";
  open.textContent = "Open";
  card.appendChild(open);
  const go = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); onOpen(block); };
  card.addEventListener("click", go);
  card.addEventListener("mousedown", (ev) => ev.stopPropagation()); // not a terminal click: no focus steal, no size claim
  el.appendChild(card);
};

/**
 * The text box, recognised from the buffer: the OSC only reaches a client
 * attached while the output streamed, but an attach replay, a restore and
 * the scrollback all carry the box itself. `lines` are consecutive buffer
 * rows; the result names the box's top row index within them.
 */
export const findViewBoxes = (lines: string[]): Array<{ top: number; block: ViewBlock }> => {
  const out: Array<{ top: number; block: ViewBlock }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*┌─ ◧ hop view/.test(lines[i])) continue;
    const strip = (t: string) => t.replace(/^\s*│\s?/, "").replace(/\s*│\s*$/, "").trim();
    const l1 = strip(lines[i + 1] || "");
    const l2 = strip(lines[i + 2] || "");
    let url = "";
    for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
      const m = /View:\s+(\S+)/.exec(lines[k] || "");
      if (m) { url = m[1]; break; }
    }
    if (!url) continue;
    const um = /\/view\/([^/]+)\/([^/]+)\/inline\/?$/.exec(url);
    if (!um) continue;
    const session = decodeURIComponent(um[1]);
    const name = decodeURIComponent(um[2]);
    const kb = /(\d+(?:\.\d+)?)\s*KB/.exec(l2);
    const titled = l1 && l1 !== name;
    out.push({ top: i, block: { session, name, url, title: titled ? l1 : undefined, bytes: kb ? Math.round(Number(kb[1]) * 1024) : undefined } });
  }
  return out;
};

type DecoTerminal = {
  cols: number;
  rows: number;
  parser: { registerOscHandler: (id: number, cb: (data: string) => boolean) => { dispose: () => void } };
  buffer: { active: { baseY: number; cursorY: number; length: number; getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined } };
  onWriteParsed?: (cb: () => void) => { dispose: () => void };
  registerMarker: (offset?: number) => { dispose: () => void; isDisposed?: boolean; line: number } | undefined;
  registerDecoration: (o: { marker: unknown; width?: number; height?: number; layer?: "top" | "bottom"; x?: number }) => { onRender: (cb: (el: HTMLElement) => void) => unknown; dispose: () => void } | undefined;
};

/** Install the OSC handler on a terminal. Returns the uninstaller. */
export const enableViewBlocks = (terminal: DecoTerminal, onOpen: (b: ViewBlock) => void): (() => void) => {
  const decos: Array<{ dispose: () => void }> = [];
  const markers: Array<{ dispose: () => void; isDisposed?: boolean; line: number }> = [];
  const taken = (line: number) => markers.some((m) => !m.isDisposed && m.line === line);
  const place = (cursorOffset: number, block: ViewBlock) => {
    try {
      const marker = terminal.registerMarker(cursorOffset);
      if (!marker || taken(marker.line)) { marker?.dispose(); return; }
      const deco = terminal.registerDecoration({ marker, x: 0, width: Math.min(terminal.cols, 72), height: VIEW_BLOCK_ROWS, layer: "top" });
      if (!deco) return;
      deco.onRender((el) => renderViewBlock(el, block, onOpen));
      decos.push(deco);
      markers.push(marker);
    } catch { /* an older xterm without decorations: the text box stands */ }
  };
  // Live path: the OSC the CLI printed, exact fields, anchored at the cursor.
  const handler = terminal.parser.registerOscHandler(VIEW_BLOCK_OSC, (data) => {
    const block = parseViewBlock(data);
    if (block) place(0, block);
    return true; // ours either way: never let it print
  });
  // Replay/scrollback path: the text box itself, scanned near the cursor
  // after each write (cheap: a dozen lines).
  const scan = () => {
    try {
      const buf = terminal.buffer.active;
      const cursorAbs = buf.baseY + buf.cursorY;
      const from = Math.max(0, cursorAbs - 16);
      const to = Math.min(buf.length - 1, cursorAbs + 2);
      const lines: string[] = [];
      for (let i = from; i <= to; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      for (const { top, block } of findViewBoxes(lines)) {
        const abs = from + top;
        if (taken(abs)) continue;
        place(abs - cursorAbs, block);
      }
    } catch { /* buffer mid-change */ }
  };
  const parsed = terminal.onWriteParsed ? terminal.onWriteParsed(scan) : null;
  return () => {
    handler.dispose();
    parsed?.dispose();
    for (const d of decos) { try { d.dispose(); } catch { /* gone */ } }
    for (const m of markers) { try { m.dispose(); } catch { /* gone */ } }
    decos.length = 0; markers.length = 0;
  };
};
