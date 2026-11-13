// The markdown agents write, parsed into plain data — never HTML — so a
// renderer can draw it as elements and nothing an agent says can script the
// page. Covers what shows up in replies and write-ups: paragraphs, headings,
// fenced code, lists (numbered, nested, task boxes), quotes, rules, and
// GitHub tables; inline code, bold, italics, strikethrough, links and bare
// URLs. Lenient where agents are sloppy (a list straight after a line of
// text, a nested bullet indented two spaces under "1."), strict where a
// guess would mangle (a table needs its separator row).
//
// The daemon's view renderer (lib/markdown.js) follows the same rules.

export type Align = "left" | "center" | "right" | null;

export type MdInline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "br" }
  | { t: "strong" | "em" | "del"; c: MdInline[] }
  | { t: "link"; href: string; c: MdInline[] }
  | { t: "img"; src: string; alt: string };

export type MdItem = { check: boolean | null; blocks: MdBlock[] };

export type MdBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: MdItem[] }
  | { kind: "quote"; blocks: MdBlock[] }
  | { kind: "table"; head: string[]; align: Align[]; rows: string[][]; numeric: boolean[]; short: boolean[] }
  | { kind: "hr" };

const FENCE = /^( *)(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const ITEM = /^( *)([-*+•]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const DELIM_ROW = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

const isBlank = (l: string) => !l.trim();
const indentOf = (l: string) => l.length - l.trimStart().length;
const dedent = (l: string, n: number) => l.slice(Math.min(n, indentOf(l)));
const expandTabs = (l: string) => l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    "));
const closesFence = (l: string, mark: string) => new RegExp(`^ *${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`).test(l);
const startsBlock = (l: string) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l);

/** A table row's cells: split on pipes outside code spans; `\|` is a pipe. */
export const splitRow = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cell += "|"; i += 2; continue; }
    if (c === "\\" && i + 1 < s.length) { cell += c + s[i + 1]; i += 2; continue; }
    if (c === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        // A pipe inside code is the code's (GitHub reads `\|` there as a pipe too).
        cell += s.slice(i, end + run.length).replace(/\\\|/g, "|");
        i = end + run.length;
        continue;
      }
      cell += run; i += run.length; continue;
    }
    if (c === "|") { cells.push(cell.trim()); cell = ""; i++; continue; }
    cell += c; i++;
  }
  if (cell.trim() || !/\|\s*$/.test(s)) cells.push(cell.trim());
  return cells;
};

const alignOf = (d: string): Align => {
  const t = d.trim();
  const l = t.startsWith(":"), r = t.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
};

const NUMBER = /^[-+−±~≈<>≤≥]?\s?[$€£]?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?\s?(?:%|×|x|[kKMGT]i?B?|ms|µs|us|ns|s|min|h|d)?$/;
const NOTHING = /^(?:|—|–|-|n\/a|na|none|\?)$/i;

const plainCell = (v: string) => v.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`_~]/g, "").trim();

/** Columns of short labels and figures, kept on one line: "held-out" split
 *  over two lines so a notes column can be wider reads badly. Wrapping is
 *  left to the columns of sentences. */
const shortColumns = (head: string[], rows: string[][]): boolean[] =>
  head.map((h, c) => [h, ...rows.map((r) => r[c] ?? "")].every((v) => plainCell(v).length <= 24));

/** Columns of figures, to set right-aligned in tabular numbers. */
const numericColumns = (rows: string[][], width: number): boolean[] =>
  Array.from({ length: width }, (_, c) => {
    const vals = rows.map((r) => (r[c] ?? "").replace(/[*`_~]/g, "").trim()).filter((v) => !NOTHING.test(v));
    return vals.length > 0 && vals.every((v) => NUMBER.test(v));
  });

// Lines of a paragraph join with a space (agents wrap long lines); two
// trailing spaces or a backslash ask for a line break.
const joinPara = (lines: string[]): string =>
  lines.map((l, k) => {
    if (k === lines.length - 1) return l.trim();
    const t = l.trim();
    if (/\\$/.test(t)) return t.slice(0, -1) + "\n";
    return t + (/ {2,}$/.test(l) ? "\n" : " ");
  }).join("");

export const parseMarkdown = (src: string): MdBlock[] =>
  parseLines(String(src ?? "").replace(/\r\n?/g, "\n").split("\n").map(expandTabs));

function parseLines(lines: string[]): MdBlock[] {
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ kind: "p", text: joinPara(para) }); para = []; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { flush(); i++; continue; }
    let m: RegExpExecArray | null;

    if ((m = FENCE.exec(line))) {
      flush();
      const ind = m[1].length, mark = m[2];
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        if (closesFence(lines[i], mark)) { i++; break; }
        body.push(dedent(lines[i], ind));
      }
      out.push({ kind: "code", lang: m[3] || "", text: body.join("\n") });
      continue;
    }
    if (HR.test(line)) { flush(); out.push({ kind: "hr" }); i++; continue; }
    if ((m = HEADING.exec(line))) { flush(); out.push({ kind: "h", level: m[1].length, text: (m[2] || "").trim() }); i++; continue; }

    // A table: a row with a pipe, then its separator row.
    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && next.includes("-") && DELIM_ROW.test(next)) {
      const head = splitRow(line);
      const delims = splitRow(next);
      if (next.includes("|") || head.length === delims.length) {
        flush();
        const rows: string[][] = [];
        for (i += 2; i < lines.length && !isBlank(lines[i]) && lines[i].includes("|"); i++) rows.push(splitRow(lines[i]));
        const width = Math.max(head.length, ...rows.map((r) => r.length));
        const pad = (r: string[]) => r.concat(Array(width - r.length).fill(""));
        const align = Array.from({ length: width }, (_, c): Align => (c < delims.length ? alignOf(delims[c]) : null));
        const body = rows.map(pad);
        const numeric = numericColumns(body, width).map((n, c) => n && !align[c]);
        out.push({ kind: "table", head: pad(head), align, rows: body, numeric, short: shortColumns(pad(head), body) });
        continue;
      }
    }

    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      for (; i < lines.length && !isBlank(lines[i]); i++) {
        const q = QUOTE.exec(lines[i]);
        if (q) inner.push(q[1]);
        else if (!startsBlock(lines[i])) inner.push(lines[i]); // a wrapped line of the quote
        else break;
      }
      out.push({ kind: "quote", blocks: parseLines(inner) });
      continue;
    }

    if (ITEM.test(line)) {
      flush();
      const [list, end] = parseList(lines, i);
      out.push(list);
      i = end;
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
  return out;
}

function parseList(lines: string[], start: number): [MdBlock, number] {
  const first = ITEM.exec(lines[start])!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: MdItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length > base + 1 || /\d/.test(m[2]) !== ordered) break;
    const markerEnd = m[1].length + m[2].length;
    const gap = indentOf(lines[i].slice(markerEnd));
    const contentCol = markerEnd + (gap >= 1 && gap <= 4 ? gap : 1);
    let firstLine = m[3] ?? "";
    let check: boolean | null = null;
    const box = /^\[([ xX])\][ \t]+/.exec(firstLine);
    if (box) { check = box[1] !== " "; firstLine = firstLine.slice(box[0].length); }
    const body = [firstLine];
    let fence: string | null = FENCE.exec(firstLine)?.[2] ?? null;
    let afterBlank = false;
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (fence) {
        body.push(dedent(l, contentCol));
        if (closesFence(l, fence)) fence = null;
        continue;
      }
      if (isBlank(l)) { body.push(""); afterBlank = true; continue; }
      const ind = indentOf(l);
      if (ITEM.test(l) && ind <= base + 1) break; // the next item, or another list
      if (ind > base) {
        const d = dedent(l, contentCol);
        body.push(d);
        const f = FENCE.exec(d);
        if (f) fence = f[2];
      } else if (!afterBlank && !startsBlock(l)) {
        body.push(l.trim()); // a hard-wrapped line of the item
      } else break;
      afterBlank = false;
    }
    while (body.length > 1 && isBlank(body[body.length - 1])) body.pop();
    items.push({ check, blocks: parseLines(body) });
  }
  return [{ kind: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items }, i];
}

// ── Inline ──────────────────────────────────────────────────────────────

const PUNCT = /[\\`*_{}[\]()#+\-.!|~<>"'$]/;
const CODE_AT = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const AUTOLINK_AT = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/y;
const URL_AT = /https?:\/\/[^\s<>"]+/y;
const WORD = /[\p{L}\p{N}]/u;

/** Where the closing delimiter is, skipping code spans and escapes; -1 if none. */
function closeOf(s: string, from: number, d: string): number {
  for (let j = from; j < s.length; ) {
    if (s[j] === "\\") { j += 2; continue; }
    if (s[j] === "`") {
      CODE_AT.lastIndex = j;
      const m = CODE_AT.exec(s);
      j += m ? m[0].length : /^`+/.exec(s.slice(j))![0].length;
      continue;
    }
    if (d === "*" || d === "_") {
      if (s.startsWith(d + d, j)) { j += 2; continue; } // a pair of the other weight
    }
    if (s.startsWith(d, j) && j > from && !/\s/.test(s[j - 1])) {
      // An underscore closes only at a word's end — and not before ".py":
      // __init__.py is a file name, not bold "init".
      const after = s[j + d.length];
      const fileDot = after === "." && WORD.test(s[j + d.length + 1] ?? "");
      if (d[0] !== "_" || after === undefined || (!WORD.test(after) && !fileDot)) return j;
    }
    j++;
  }
  return -1;
}

/** The "]" that closes the "[" at `open`, or -1. */
function bracketClose(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") {
      CODE_AT.lastIndex = j;
      const m = CODE_AT.exec(s);
      if (m) { j += m[0].length - 1; continue; }
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return j;
  }
  return -1;
}

/** "(url)" or "(url "title")" at `at`: the url and where it ends. */
function destination(s: string, at: number): { href: string; end: number } | null {
  if (s[at] !== "(") return null;
  let j = at + 1;
  while (s[j] === " ") j++;
  let href = "";
  if (s[j] === "<") {
    const e = s.indexOf(">", j);
    if (e < 0) return null;
    href = s.slice(j + 1, e);
    j = e + 1;
  } else {
    let depth = 0;
    for (; j < s.length; j++) {
      const c = s[j];
      if (/\s/.test(c)) break;
      if (c === "(") depth++;
      else if (c === ")") { if (depth === 0) break; depth--; }
      href += c;
    }
  }
  while (s[j] === " ") j++;
  if (s[j] === '"' || s[j] === "'") {
    const e = s.indexOf(s[j], j + 1);
    if (e < 0) return null;
    j = e + 1;
    while (s[j] === " ") j++;
  }
  if (s[j] !== ")") return null;
  return { href, end: j + 1 };
}

/** A bare URL's end: trailing punctuation is the sentence's, not the URL's. */
function trimUrl(u: string): string {
  const tail = /[.,;:!?'"*_\]]+$/;
  let url = u.replace(tail, "");
  while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
    url = url.slice(0, -1).replace(tail, "");
  }
  return url;
}

export function parseInline(s: string, inLink = false): MdInline[] {
  const out: MdInline[] = [];
  let buf = "";
  const push = (n: MdInline) => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } out.push(n); };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\n") { push({ t: "br" }); i++; continue; }
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === "`") {
      CODE_AT.lastIndex = i;
      const m = CODE_AT.exec(s);
      if (m) {
        let v = m[2];
        if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ") && v.trim()) v = v.slice(1, -1);
        push({ t: "code", v });
        i += m[0].length;
        continue;
      }
      const run = /^`+/.exec(s.slice(i))![0];
      buf += run; i += run.length; continue;
    }
    if (!inLink && (c === "[" || (c === "!" && s[i + 1] === "["))) {
      const open = c === "!" ? i + 1 : i;
      const close = bracketClose(s, open);
      const dest = close > 0 ? destination(s, close + 1) : null;
      if (dest) {
        const label = s.slice(open + 1, close);
        if (c === "!") push({ t: "img", src: dest.href, alt: label });
        else push({ t: "link", href: dest.href, c: parseInline(label, true) });
        i = dest.end;
        continue;
      }
    }
    if (!inLink && c === "<") {
      AUTOLINK_AT.lastIndex = i;
      const m = AUTOLINK_AT.exec(s);
      if (m) { push({ t: "link", href: m[1], c: [{ t: "text", v: m[1].replace(/^mailto:/, "") }] }); i += m[0].length; continue; }
    }
    if (!inLink && c === "h" && (i === 0 || /[\s(["'*_>]/.test(s[i - 1]))) {
      URL_AT.lastIndex = i;
      const m = URL_AT.exec(s);
      if (m) {
        const url = trimUrl(m[0]);
        if (url.length > 8) { push({ t: "link", href: url, c: [{ t: "text", v: url }] }); i += url.length; continue; }
      }
    }
    if ((c === "*" || c === "_") && s.startsWith(c + c + c, i) && s[i + 3] !== undefined && !/\s/.test(s[i + 3])) {
      // ***both***
      const end = s.indexOf(c + c + c, i + 3);
      if (end > i + 3 && !/\s/.test(s[end - 1])) {
        push({ t: "strong", c: [{ t: "em", c: parseInline(s.slice(i + 3, end), inLink) }] });
        i = end + 3;
        continue;
      }
    }
    if (c === "*" || c === "_" || (c === "~" && s[i + 1] === "~")) {
      const two = s[i + 1] === c;
      const d = c === "~" ? "~~" : two ? c + c : c;
      const okLeft = c !== "_" || i === 0 || !WORD.test(s[i - 1]);
      const inner = s[i + d.length];
      if (okLeft && inner !== undefined && !/\s/.test(inner) && !(d.length === 1 && inner === c)) {
        const end = closeOf(s, i + d.length, d);
        if (end > i + d.length) {
          const kids = parseInline(s.slice(i + d.length, end), inLink);
          push({ t: d === "~~" ? "del" : d.length === 2 ? "strong" : "em", c: kids });
          i = end + d.length;
          continue;
        }
      }
      // A run of the same mark with nothing to close it is just the mark.
      const run = new RegExp(`^\\${c}+`).exec(s.slice(i))![0];
      buf += run; i += run.length; continue;
    }
    buf += c;
    i++;
  }
  if (buf) out.push({ t: "text", v: buf });
  return out;
}

/** Plain text of inline markdown (copying, tooltips). */
export const inlineText = (nodes: MdInline[]): string =>
  nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? "\n" : n.t === "img" ? n.alt : inlineText(n.c))).join("");
