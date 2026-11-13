// GENERATED from hay/apps/web/src/utils/markdown.ts — do not edit here.
// Edit the .ts and run `node scripts/gen-markdown-lib.mjs`.
// source-sha256: cea3596e988a4942
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  inlineText: () => inlineText,
  parseInline: () => parseInline,
  parseMarkdown: () => parseMarkdown,
  splitRow: () => splitRow
});
module.exports = __toCommonJS(stdin_exports);
const FENCE = /^( *)(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const ITEM = /^( *)([-*+•]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const DELIM_ROW = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
const isBlank = (l) => !l.trim();
const indentOf = (l) => l.length - l.trimStart().length;
const dedent = (l, n) => l.slice(Math.min(n, indentOf(l)));
const expandTabs = (l) => l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    "));
const closesFence = (l, mark) => new RegExp(`^ *${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`).test(l);
const startsBlock = (l) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l);
const splitRow = (line) => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  const cells = [];
  let cell = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cell += "|";
      i += 2;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      cell += c + s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(s.slice(i))[0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        cell += s.slice(i, end + run.length).replace(/\\\|/g, "|");
        i = end + run.length;
        continue;
      }
      cell += run;
      i += run.length;
      continue;
    }
    if (c === "|") {
      cells.push(cell.trim());
      cell = "";
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell.trim() || !/\|\s*$/.test(s)) cells.push(cell.trim());
  return cells;
};
const alignOf = (d) => {
  const t = d.trim();
  const l = t.startsWith(":"), r = t.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
};
const NUMBER = /^[-+−±~≈<>≤≥]?\s?[$€£]?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?\s?(?:%|×|x|[kKMGT]i?B?|ms|µs|us|ns|s|min|h|d)?$/;
const NOTHING = /^(?:|—|–|-|n\/a|na|none|\?)$/i;
const plainCell = (v) => v.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`_~]/g, "").trim();
const shortColumns = (head, rows) => head.map((h, c) => [h, ...rows.map((r) => r[c] ?? "")].every((v) => plainCell(v).length <= 24));
const numericColumns = (rows, width) => Array.from({ length: width }, (_, c) => {
  const vals = rows.map((r) => (r[c] ?? "").replace(/[*`_~]/g, "").trim()).filter((v) => !NOTHING.test(v));
  return vals.length > 0 && vals.every((v) => NUMBER.test(v));
});
const joinPara = (lines) => lines.map((l, k) => {
  if (k === lines.length - 1) return l.trim();
  const t = l.trim();
  if (/\\$/.test(t)) return t.slice(0, -1) + "\n";
  return t + (/ {2,}$/.test(l) ? "\n" : " ");
}).join("");
const parseMarkdown = (src) => parseLines(String(src ?? "").replace(/\r\n?/g, "\n").split("\n").map(expandTabs));
function parseLines(lines) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push({ kind: "p", text: joinPara(para) });
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      flush();
      i++;
      continue;
    }
    let m;
    if (m = FENCE.exec(line)) {
      flush();
      const ind = m[1].length, mark = m[2];
      const body = [];
      for (i++; i < lines.length; i++) {
        if (closesFence(lines[i], mark)) {
          i++;
          break;
        }
        body.push(dedent(lines[i], ind));
      }
      out.push({ kind: "code", lang: m[3] || "", text: body.join("\n") });
      continue;
    }
    if (HR.test(line)) {
      flush();
      out.push({ kind: "hr" });
      i++;
      continue;
    }
    if (m = HEADING.exec(line)) {
      flush();
      out.push({ kind: "h", level: m[1].length, text: (m[2] || "").trim() });
      i++;
      continue;
    }
    const next = lines[i + 1];
    if (line.includes("|") && next !== void 0 && next.includes("-") && DELIM_ROW.test(next)) {
      const head = splitRow(line);
      const delims = splitRow(next);
      if (next.includes("|") || head.length === delims.length) {
        flush();
        const rows = [];
        for (i += 2; i < lines.length && !isBlank(lines[i]) && lines[i].includes("|"); i++) rows.push(splitRow(lines[i]));
        const width = Math.max(head.length, ...rows.map((r) => r.length));
        const pad = (r) => r.concat(Array(width - r.length).fill(""));
        const align = Array.from({ length: width }, (_, c) => c < delims.length ? alignOf(delims[c]) : null);
        const body = rows.map(pad);
        const numeric = numericColumns(body, width).map((n, c) => n && !align[c]);
        out.push({ kind: "table", head: pad(head), align, rows: body, numeric, short: shortColumns(pad(head), body) });
        continue;
      }
    }
    if (QUOTE.test(line)) {
      flush();
      const inner = [];
      for (; i < lines.length && !isBlank(lines[i]); i++) {
        const q = QUOTE.exec(lines[i]);
        if (q) inner.push(q[1]);
        else if (!startsBlock(lines[i])) inner.push(lines[i]);
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
function parseList(lines, start) {
  var _a;
  const first = ITEM.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length > base + 1 || /\d/.test(m[2]) !== ordered) break;
    const markerEnd = m[1].length + m[2].length;
    const gap = indentOf(lines[i].slice(markerEnd));
    const contentCol = markerEnd + (gap >= 1 && gap <= 4 ? gap : 1);
    let firstLine = m[3] ?? "";
    let check = null;
    const box = /^\[([ xX])\][ \t]+/.exec(firstLine);
    if (box) {
      check = box[1] !== " ";
      firstLine = firstLine.slice(box[0].length);
    }
    const body = [firstLine];
    let fence = ((_a = FENCE.exec(firstLine)) == null ? void 0 : _a[2]) ?? null;
    let afterBlank = false;
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (fence) {
        body.push(dedent(l, contentCol));
        if (closesFence(l, fence)) fence = null;
        continue;
      }
      if (isBlank(l)) {
        body.push("");
        afterBlank = true;
        continue;
      }
      const ind = indentOf(l);
      if (ITEM.test(l) && ind <= base + 1) break;
      if (ind > base) {
        const d = dedent(l, contentCol);
        body.push(d);
        const f = FENCE.exec(d);
        if (f) fence = f[2];
      } else if (!afterBlank && !startsBlock(l)) {
        body.push(l.trim());
      } else break;
      afterBlank = false;
    }
    while (body.length > 1 && isBlank(body[body.length - 1])) body.pop();
    items.push({ check, blocks: parseLines(body) });
  }
  return [{ kind: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items }, i];
}
const PUNCT = /[\\`*_{}[\]()#+\-.!|~<>"'$]/;
const CODE_AT = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const AUTOLINK_AT = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/y;
const URL_AT = /https?:\/\/[^\s<>"]+/y;
const WORD = /[\p{L}\p{N}]/u;
function closeOf(s, from, d) {
  for (let j = from; j < s.length; ) {
    if (s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === "`") {
      CODE_AT.lastIndex = j;
      const m = CODE_AT.exec(s);
      j += m ? m[0].length : /^`+/.exec(s.slice(j))[0].length;
      continue;
    }
    if (d === "*" || d === "_") {
      if (s.startsWith(d + d, j)) {
        j += 2;
        continue;
      }
    }
    if (s.startsWith(d, j) && j > from && !/\s/.test(s[j - 1])) {
      const after = s[j + d.length];
      const fileDot = after === "." && WORD.test(s[j + d.length + 1] ?? "");
      if (d[0] !== "_" || after === void 0 || !WORD.test(after) && !fileDot) return j;
    }
    j++;
  }
  return -1;
}
function bracketClose(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "`") {
      CODE_AT.lastIndex = j;
      const m = CODE_AT.exec(s);
      if (m) {
        j += m[0].length - 1;
        continue;
      }
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return j;
  }
  return -1;
}
function destination(s, at) {
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
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
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
function trimUrl(u) {
  const tail = /[.,;:!?'"*_\]]+$/;
  let url = u.replace(tail, "");
  while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
    url = url.slice(0, -1).replace(tail, "");
  }
  return url;
}
function parseInline(s, inLink = false) {
  const out = [];
  let buf = "";
  const push = (n) => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
    out.push(n);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\n") {
      push({ t: "br" });
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
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
      const run = /^`+/.exec(s.slice(i))[0];
      buf += run;
      i += run.length;
      continue;
    }
    if (!inLink && (c === "[" || c === "!" && s[i + 1] === "[")) {
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
      if (m) {
        push({ t: "link", href: m[1], c: [{ t: "text", v: m[1].replace(/^mailto:/, "") }] });
        i += m[0].length;
        continue;
      }
    }
    if (!inLink && c === "h" && (i === 0 || /[\s(["'*_>]/.test(s[i - 1]))) {
      URL_AT.lastIndex = i;
      const m = URL_AT.exec(s);
      if (m) {
        const url = trimUrl(m[0]);
        if (url.length > 8) {
          push({ t: "link", href: url, c: [{ t: "text", v: url }] });
          i += url.length;
          continue;
        }
      }
    }
    if ((c === "*" || c === "_") && s.startsWith(c + c + c, i) && s[i + 3] !== void 0 && !/\s/.test(s[i + 3])) {
      const end = s.indexOf(c + c + c, i + 3);
      if (end > i + 3 && !/\s/.test(s[end - 1])) {
        push({ t: "strong", c: [{ t: "em", c: parseInline(s.slice(i + 3, end), inLink) }] });
        i = end + 3;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~" && s[i + 1] === "~") {
      const two = s[i + 1] === c;
      const d = c === "~" ? "~~" : two ? c + c : c;
      const okLeft = c !== "_" || i === 0 || !WORD.test(s[i - 1]);
      const inner = s[i + d.length];
      if (okLeft && inner !== void 0 && !/\s/.test(inner) && !(d.length === 1 && inner === c)) {
        const end = closeOf(s, i + d.length, d);
        if (end > i + d.length) {
          const kids = parseInline(s.slice(i + d.length, end), inLink);
          push({ t: d === "~~" ? "del" : d.length === 2 ? "strong" : "em", c: kids });
          i = end + d.length;
          continue;
        }
      }
      const run = new RegExp(`^\\${c}+`).exec(s.slice(i))[0];
      buf += run;
      i += run.length;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf) out.push({ t: "text", v: buf });
  return out;
}
const inlineText = (nodes) => nodes.map((n) => n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? "\n" : n.t === "img" ? n.alt : inlineText(n.c)).join("");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  inlineText,
  parseInline,
  parseMarkdown,
  splitRow
});
