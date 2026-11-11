// File paths in the terminal are links, the way URLs are: a figure, PDF,
// page, write-up, table or notebook an agent names opens in the Views
// reader. hop finds the file relative to where the session works and serves
// it from where it is (lib/session-files.js on the daemon). Only the kinds
// hop shows are links; URLs stay the web-links addon's.
import type { ILink, ILinkProvider, IDisposable, Terminal } from "@xterm/xterm";

const EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "html", "htm", "md", "markdown", "csv", "tsv", "ipynb", "mp4", "mov", "webm"];
const ALT = [...EXTS].sort((a, b) => b.length - a.length).join("|");
const SEG = "[\\w@%+=.\\-]+";
// Same shape as the daemon's: after a space or an opening mark, before a
// space, a closing mark or sentence punctuation; no spaces inside.
const PATH_RE = new RegExp(
  `(?:^|(?<=[\\s(\\[{<"'\`=:*]))((?:~/|/|\\.{1,2}/)?(?:${SEG}/)*${SEG}\\.(?:${ALT}))(?=$|[\\s)\\]}>"'\`,;:!?*]|\\.(?:\\s|$))`,
  "gi"
);
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]>"'`]+/gi;

export type PathSpan = { start: number; end: number; path: string };

/** The showable file paths in a line of text, with their offsets (end exclusive). */
export const findPathSpans = (text: string): PathSpan[] => {
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const out: PathSpan[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1];
    const start = m.index ?? 0;
    const end = start + p.length;
    if (urls.some(([a, b]) => start < b && end > a)) continue;
    if (!p.includes("/") && /^\.+[^/]*$/.test(p)) continue;
    out.push({ start, end, path: p });
  }
  return out;
};

const MAX_WRAP_ROWS = 8;

/** Make paths in `term` open through `onOpen`. */
export const enablePathLinks = (term: Terminal, onOpen: (path: string, event: MouseEvent) => void): IDisposable => {
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      const row = y - 1;
      // The logical line: soft-wrapped rows joined, so a long path that
      // wrapped is one link.
      let first = row;
      while (first > 0 && row - first < MAX_WRAP_ROWS && buf.getLine(first)?.isWrapped) first -= 1;
      let last = row;
      while (last + 1 < buf.length && last - row < MAX_WRAP_ROWS && buf.getLine(last + 1)?.isWrapped) last += 1;
      let text = "";
      const from: number[] = [];
      for (let r = first; r <= last; r += 1) {
        from.push(text.length);
        text += buf.getLine(r)?.translateToString(false) ?? "";
      }
      const cell = (offset: number) => {
        let i = from.length - 1;
        while (i > 0 && from[i] > offset) i -= 1;
        return { x: offset - from[i] + 1, y: first + i + 1 };
      };
      const links: ILink[] = [];
      for (const span of findPathSpans(text)) {
        const start = cell(span.start);
        const end = cell(span.end - 1);
        if (y < start.y || y > end.y) continue;
        links.push({ range: { start, end }, text: span.path, activate: (event) => onOpen(span.path, event) });
      }
      callback(links.length ? links : undefined);
    }
  };
  return term.registerLinkProvider(provider);
};
