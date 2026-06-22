#!/usr/bin/env node
'use strict';
// hop math — render a LaTeX math formula in the terminal.
//
// Picks the best output for *where it is printing*:
//   • inline image (Kitty / iTerm2 graphics) when run standalone in a
//     graphics-capable terminal, and
//   • a 2D Unicode layout otherwise — always available, zero dependencies.
//
// Inside a hop session (HOP_SESSION is set) it uses Unicode regardless, because
// inline-image escape sequences don't survive hop's re-rendering clients yet
// (the CLI repaints cell-by-cell; the web client has no image addon). See the
// "math" notes in the README/CHANGELOG.
//
// Image rendering uses mathjax-full (LaTeX→SVG, glyphs as vector paths) +
// @resvg/resvg-js (SVG→PNG). Both are optional: if they can't be loaded we fall
// back to the Unicode layout with a one-line note, so `hop math` never hard-fails.

const fs = require('fs');

// ───────────────────────── symbol tables ─────────────────────────
// LaTeX command → Unicode. Intentionally a practical subset; unknown commands
// degrade to their name without the backslash.
const SYMBOLS = {
  // greek (lower)
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε',
  '\\varepsilon': 'ε', '\\zeta': 'ζ', '\\eta': 'η', '\\theta': 'θ', '\\vartheta': 'ϑ',
  '\\iota': 'ι', '\\kappa': 'κ', '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν', '\\xi': 'ξ',
  '\\pi': 'π', '\\varpi': 'ϖ', '\\rho': 'ρ', '\\varrho': 'ϱ', '\\sigma': 'σ', '\\varsigma': 'ς',
  '\\tau': 'τ', '\\upsilon': 'υ', '\\phi': 'φ', '\\varphi': 'φ', '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
  // greek (upper)
  '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ', '\\Xi': 'Ξ', '\\Pi': 'Π',
  '\\Sigma': 'Σ', '\\Upsilon': 'Υ', '\\Phi': 'Φ', '\\Psi': 'Ψ', '\\Omega': 'Ω',
  // operators / relations
  '\\times': '×', '\\div': '÷', '\\cdot': '·', '\\pm': '±', '\\mp': '∓', '\\ast': '∗',
  '\\star': '⋆', '\\circ': '∘', '\\bullet': '∙', '\\oplus': '⊕', '\\otimes': '⊗',
  '\\leq': '≤', '\\le': '≤', '\\geq': '≥', '\\ge': '≥', '\\neq': '≠', '\\ne': '≠',
  '\\equiv': '≡', '\\approx': '≈', '\\sim': '∼', '\\simeq': '≃', '\\cong': '≅',
  '\\propto': '∝', '\\ll': '≪', '\\gg': '≫',
  // arrows
  '\\to': '→', '\\rightarrow': '→', '\\leftarrow': '←', '\\Rightarrow': '⇒',
  '\\Leftarrow': '⇐', '\\leftrightarrow': '↔', '\\Leftrightarrow': '⇔', '\\mapsto': '↦',
  '\\uparrow': '↑', '\\downarrow': '↓',
  // sets / logic
  '\\in': '∈', '\\notin': '∉', '\\ni': '∋', '\\subset': '⊂', '\\subseteq': '⊆',
  '\\supset': '⊃', '\\supseteq': '⊇', '\\cup': '∪', '\\cap': '∩', '\\setminus': '∖',
  '\\emptyset': '∅', '\\varnothing': '∅', '\\forall': '∀', '\\exists': '∃',
  '\\neg': '¬', '\\land': '∧', '\\wedge': '∧', '\\lor': '∨', '\\vee': '∨',
  // misc
  '\\infty': '∞', '\\partial': '∂', '\\nabla': '∇', '\\hbar': 'ℏ', '\\ell': 'ℓ',
  '\\Re': 'ℜ', '\\Im': 'ℑ', '\\aleph': 'ℵ', '\\angle': '∠', '\\perp': '⊥',
  '\\parallel': '∥', '\\cdots': '⋯', '\\ldots': '…', '\\dots': '…', '\\vdots': '⋮',
  '\\ddots': '⋱', '\\prime': '′', '\\degree': '°', '\\pm ': '±',
  '\\int': '∫', '\\oint': '∮', '\\nabla': '∇', '\\surd': '√',
  '\\langle': '⟨', '\\rangle': '⟩', '\\lceil': '⌈', '\\rceil': '⌉', '\\lfloor': '⌊', '\\rfloor': '⌋',
  '\\mathbb{R}': 'ℝ',
  // named functions render as themselves (no backslash)
};

// Big operators that take stacked (over/under) limits in display style.
const BIGOP = {
  '\\sum': '∑', '\\prod': '∏', '\\coprod': '∐',
  '\\bigcup': '⋃', '\\bigcap': '⋂', '\\bigvee': '⋁', '\\bigwedge': '⋀',
  '\\bigoplus': '⨁', '\\bigotimes': '⨂', '\\bigodot': '⨀',
  '\\lim': 'lim', '\\max': 'max', '\\min': 'min',
};

// Commands whose single-group argument is rendered as literal text.
const TEXTLIKE = new Set([
  '\\text', '\\textrm', '\\textbf', '\\textit', '\\mathrm', '\\mathbf',
  '\\mathit', '\\mathsf', '\\mathtt', '\\mathcal', '\\mathbb', '\\mathfrak',
  '\\operatorname', '\\boldsymbol', '\\bm',
]);

// Accent commands → Unicode combining marks applied over the argument.
const ACCENTS = {
  '\\vec': '⃗', '\\overrightarrow': '⃗', '\\hat': '̂', '\\widehat': '̂',
  '\\bar': '̅', '\\overline': '̅', '\\tilde': '̃', '\\widetilde': '̃',
  '\\dot': '̇', '\\ddot': '̈', '\\acute': '́', '\\grave': '̀', '\\check': '̌',
};

const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ' };
const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎' };

// ───────────────────────── 2D box layout ─────────────────────────
// A "box" is a stack of equal-purpose lines with a baseline row, so terms with
// fractions / stacked limits align by baseline when concatenated horizontally.
const cw = (s) => [...s].length; // display columns (code points; math glyphs are width 1)
function padR(s, width) { const p = width - cw(s); return p > 0 ? s + ' '.repeat(p) : s; }
function box(line) { return { lines: [line], baseline: 0, width: cw(line), height: 1 }; }
const empty = () => ({ lines: [''], baseline: 0, width: 0, height: 1 });
function centerLines(b, width) {
  const pad = Math.max(0, width - b.width);
  const left = Math.floor(pad / 2), right = pad - left;
  return b.lines.map((l) => ' '.repeat(left) + padR(l, b.width) + ' '.repeat(right));
}
function hcat(boxes) {
  boxes = boxes.filter(Boolean);
  if (!boxes.length) return empty();
  const above = Math.max(...boxes.map((b) => b.baseline));
  const below = Math.max(...boxes.map((b) => b.height - 1 - b.baseline));
  const H = above + below + 1;
  const lines = new Array(H).fill('');
  for (const b of boxes) {
    const top = above - b.baseline;
    for (let r = 0; r < H; r++) {
      const i = r - top;
      lines[r] += padR(i >= 0 && i < b.lines.length ? b.lines[i] : '', b.width);
    }
  }
  return { lines, baseline: above, width: cw(lines[0]), height: H };
}
function fracBox(num, den) {
  const width = Math.max(num.width, den.width, 1);
  const bar = '─'.repeat(width);
  const lines = [...centerLines(num, width), bar, ...centerLines(den, width)];
  return { lines, baseline: num.height, width, height: lines.length };
}
function sqrtBox(a) {
  const over = ' ' + '‾'.repeat(a.width);
  const body = hcat([box('√'), a]);
  // pad the overline to the body height, sitting one row above the radicand
  const lines = [over, ...body.lines];
  return { lines, baseline: body.baseline + 1, width: body.width, height: lines.length };
}
function flatten(b) { return b.lines.join(''); }
function mapAll(text, table) {
  let out = '';
  for (const ch of text) { if (!(ch in table)) return null; out += table[ch]; }
  return out;
}
function renderSup(b) {
  const t = flatten(b);
  const mapped = mapAll(t, SUP);
  if (mapped !== null) return mapped;
  return cw(t) > 1 ? '^(' + t + ')' : '^' + t;
}
function renderSub(b) {
  const t = flatten(b);
  const mapped = mapAll(t, SUB);
  if (mapped !== null) return mapped;
  return '_' + t; // letters stay inline (Unicode lacks most subscript letters)
}
function attachScripts(base, sub, sup, stack) {
  if (!sub && !sup) return base;
  if (stack) {
    const width = Math.max(base.width, sub ? sub.width : 0, sup ? sup.width : 0);
    const supL = sup ? centerLines(sup, width) : [];
    const baseL = centerLines(base, width);
    const subL = sub ? centerLines(sub, width) : [];
    const lines = [...supL, ...baseL, ...subL];
    return { lines, baseline: supL.length + base.baseline, width, height: lines.length };
  }
  let suffix = '';
  if (sub) suffix += renderSub(sub);
  if (sup) suffix += renderSup(sup);
  return hcat([base, box(suffix)]);
}

// ───────────────────────── parse LaTeX → box ─────────────────────────
function tokenize(src) {
  // strip math delimiters and size/spacing-only commands
  src = src
    .replace(/\$\$?/g, ' ')
    .replace(/\\left|\\right|\\!|\\bigg?l?|\\Bigg?l?|\\bigg?r?|\\Bigg?r?/g, '')
    .replace(/\\Big|\\big|\\bigg|\\Bigg/g, '')
    .replace(/\\[,;:>]/g, ' ')
    .replace(/\\quad|\\qquad/g, '  ');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      let j = i + 1, name = '\\';
      while (j < src.length && /[A-Za-z]/.test(src[j])) { name += src[j]; j++; }
      if (name === '\\') { name = '\\' + (src[j] || ''); j++; } // e.g. \{ \} \\
      tokens.push({ t: 'cmd', v: name }); i = j;
    } else if (c === '{') { tokens.push({ t: '{' }); i++; }
    else if (c === '}') { tokens.push({ t: '}' }); i++; }
    else if (c === '^') { tokens.push({ t: '^' }); i++; }
    else if (c === '_') { tokens.push({ t: '_' }); i++; }
    else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (tokens.length && tokens[tokens.length - 1].t !== 'sp') tokens.push({ t: 'sp' });
      i++;
    } else { tokens.push({ t: 'ch', v: c }); i++; }
  }
  return tokens;
}

function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];

  function parseGroup() {
    next(); // consume '{'
    const b = parseSeq();
    if (peek() && peek().t === '}') next();
    return b;
  }
  function literalGroup() {
    next(); // consume '{'
    let s = '';
    while (peek() && peek().t !== '}') {
      const tk = next();
      if (tk.t === 'ch') s += tk.v;
      else if (tk.t === 'sp') s += ' ';
      else if (tk.t === 'cmd') s += SYMBOLS[tk.v] || tk.v.slice(1);
      else if (tk.t === '^') s += '^';
      else if (tk.t === '_') s += '_';
    }
    if (peek() && peek().t === '}') next();
    return box(s);
  }
  function groupOrAtom() {
    while (peek() && peek().t === 'sp') next();
    if (peek() && peek().t === '{') return parseGroup();
    return parseAtomCore();
  }
  function parseAtomCore() {
    const tk = peek();
    if (!tk) return empty();
    if (tk.t === 'sp') { next(); return box(' '); }
    if (tk.t === '{') return parseGroup();
    if (tk.t === 'ch') { next(); return box(tk.v); }
    if (tk.t === '^' || tk.t === '_' || tk.t === '}') { next(); return empty(); }
    // command
    const cmd = next().v;
    if (cmd === '\\frac' || cmd === '\\dfrac' || cmd === '\\tfrac') {
      return fracBox(groupOrAtom(), groupOrAtom());
    }
    if (cmd === '\\sqrt') {
      // ignore an optional [n] index for v1
      if (peek() && peek().t === 'ch' && peek().v === '[') { while (peek() && !(peek().t === 'ch' && peek().v === ']')) next(); if (peek()) next(); }
      return sqrtBox(groupOrAtom());
    }
    if (TEXTLIKE.has(cmd)) {
      while (peek() && peek().t === 'sp') next();
      if (peek() && peek().t === '{') return literalGroup();
      return empty();
    }
    if (cmd in ACCENTS) {
      const arg = flatten(groupOrAtom());
      let out = '';
      for (const ch of arg) out += ch + ACCENTS[cmd]; // combining mark per code point
      return box(out);
    }
    if (cmd in BIGOP) { const b = box(BIGOP[cmd]); b.bigop = true; return b; }
    if (cmd in SYMBOLS) return box(SYMBOLS[cmd]);
    if (/^\\[A-Za-z]+$/.test(cmd)) return box(cmd.slice(1)); // unknown name → literal
    return box(cmd.slice(1));
  }
  function parseSeq() {
    const parts = [];
    while (peek() && peek().t !== '}') {
      if (peek().t === 'sp') { next(); parts.push(box(' ')); continue; }
      let atom = parseAtomCore();
      const stack = atom.bigop === true;
      let sub = null, sup = null;
      while (peek() && (peek().t === '_' || peek().t === '^')) {
        const which = next().t;
        const s = groupOrAtom();
        if (which === '_') sub = s; else sup = s;
      }
      parts.push(attachScripts(atom, sub, sup, stack));
    }
    return hcat(parts);
  }
  return parseSeq();
}

function latexToBox(latex) {
  try { return parse(tokenize(latex)); }
  catch (e) { return box(latex); } // never throw on the text path
}

// ───────────────────────── terminal capability ─────────────────────────
function detectProtocol(opts) {
  if (opts.protocol) return opts.protocol;       // explicit --kitty/--iterm
  if (opts.unicode) return 'unicode';            // explicit --unicode
  if (process.env.HOP_SESSION) return 'unicode'; // images don't survive hop yet
  if (!process.stdout.isTTY) return 'unicode';   // piped/redirected
  const term = process.env.TERM || '';
  const prog = process.env.TERM_PROGRAM || '';
  if (process.env.KITTY_WINDOW_ID || /kitty/i.test(term) ||
      /ghostty/i.test(prog) || process.env.GHOSTTY_RESOURCES_DIR || process.env.GHOSTTY_BIN_DIR) return 'kitty';
  if (process.env.WEZTERM_PANE || prog === 'WezTerm') return 'kitty'; // WezTerm speaks kitty graphics
  if (process.env.KONSOLE_VERSION) return 'kitty';
  if (prog === 'iTerm.app' || process.env.LC_TERMINAL === 'iTerm2') return 'iterm';
  return 'unicode';
}
function detectDark() {
  const v = process.env.COLORFGBG;
  if (v) {
    const parts = v.split(';');
    const bg = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(bg)) return bg === 0 || bg === 8; // 0/8 ≈ black background
  }
  return false; // default to light (matches the common preference); use --dark to flip
}

// ───────────────────────── image path (lazy deps) ─────────────────────────
function svgForLatex(latex) {
  const { mathjax } = require('mathjax-full/js/mathjax.js');
  const { TeX } = require('mathjax-full/js/input/tex.js');
  const { SVG } = require('mathjax-full/js/output/svg.js');
  const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
  const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');
  const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js');
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({ packages: AllPackages });
  const svg = new SVG({ fontCache: 'none' }); // inline path glyphs → no font deps to rasterize
  const doc = mathjax.document('', { InputJax: tex, OutputJax: svg });
  const node = doc.convert(latex.replace(/\$\$?/g, ''), { display: true });
  const html = adaptor.outerHTML(node);
  const m = html.match(/<svg[\s\S]*<\/svg>/);
  if (!m) throw new Error('no SVG produced');
  return m[0];
}
function renderImagePng(latex, opts) {
  const { Resvg } = require('@resvg/resvg-js');
  let svg = svgForLatex(latex);
  // MathJax paints glyphs in `currentColor`; resvg needs a concrete color.
  svg = svg.split('currentColor').join(opts.fg);
  // estimate height in rows from the SVG's ex-height
  const hm = svg.match(/height="([\d.]+)ex"/);
  const exH = hm ? parseFloat(hm[1]) : 2.4;
  const rows = Math.min(40, Math.max(1, Math.round(exH * opts.scale)));
  const pxH = rows * 44; // generous DPI so the terminal downscale stays crisp
  const r = new Resvg(svg, {
    fitTo: { mode: 'height', value: pxH },
    background: opts.transparent ? undefined : opts.bg,
    font: { loadSystemFonts: false },
  });
  const png = Buffer.from(r.render().asPng());
  return { png, rows };
}
function encodeKitty(png, rows) {
  const b64 = png.toString('base64');
  const chunks = [];
  for (let i = 0; i < b64.length; i += 4096) chunks.push(b64.slice(i, i + 4096));
  let out = '';
  chunks.forEach((c, idx) => {
    const ctrl = [];
    if (idx === 0) ctrl.push('a=T', 'f=100', `r=${rows}`); // transmit+display PNG, height in rows
    ctrl.push(`m=${idx === chunks.length - 1 ? 0 : 1}`);
    out += `\x1b_G${ctrl.join(',')};${c}\x1b\\`;
  });
  return out + '\n';
}
function encodeIterm(png, rows) {
  const b64 = png.toString('base64');
  return `\x1b]1337;File=inline=1;height=${rows};preserveAspectRatio=1:${b64}\x07\n`;
}

// ───────────────────────── CLI ─────────────────────────
function printHelp(out = process.stdout) {
  out.write(`hop math — render a LaTeX formula in the terminal

Usage:
  hop math '<latex>'            Render a formula (quote it to protect $, \\, {})
  echo '<latex>' | hop math     Read the formula from stdin

Output is chosen automatically: an inline image in graphics-capable terminals
(Kitty/Ghostty/WezTerm/iTerm2) when run standalone, or a 2D Unicode layout
everywhere else (including inside a hop session).

Options:
  -u, --unicode     Force the Unicode layout
      --image       Prefer an inline image (auto-detect the protocol)
      --kitty       Force the Kitty graphics protocol
      --iterm       Force the iTerm2 inline-image protocol
      --scale N     Image size multiplier (default 1.0)
      --dark        Render light glyphs on a dark card (default: dark on light)
      --light       Render dark glyphs on a light card
      --transparent No background card (image mode)
      --fg <color>  Glyph color (e.g. '#1a1a1a')
      --bg <color>  Card color (e.g. '#ffffff')
  -h, --help        This help

Examples:
  hop math 'e^{i\\pi} + 1 = 0'
  hop math '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}'
`);
}

function runMathCli(argv) {
  const opts = { scale: 1.0, transparent: false };
  let darkFlag;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-u' || a === '--unicode') opts.unicode = true;
    else if (a === '--image') opts.forceImage = true;
    else if (a === '--kitty') opts.protocol = 'kitty';
    else if (a === '--iterm') opts.protocol = 'iterm';
    else if (a === '--dark') darkFlag = true;
    else if (a === '--light') darkFlag = false;
    else if (a === '--transparent') opts.transparent = true;
    else if (a === '--scale') opts.scale = parseFloat(argv[++i]) || 1.0;
    else if (a === '--fg') opts.fg = argv[++i];
    else if (a === '--bg') opts.bg = argv[++i];
    else if (a === '-h' || a === '--help') { printHelp(); return 0; }
    else if (a.startsWith('--')) { process.stderr.write(`hop math: unknown option ${a}\n`); return 1; }
    else positional.push(a);
  }

  let latex = positional.join(' ').trim();
  if (!latex && !process.stdin.isTTY) {
    try { latex = fs.readFileSync(0, 'utf8').trim(); } catch { /* ignore */ }
  }
  if (!latex) { printHelp(process.stderr); return 1; }

  const dark = darkFlag !== undefined ? darkFlag : detectDark();
  opts.fg = opts.fg || (dark ? '#e8e8e8' : '#1a1a1a');
  opts.bg = opts.bg || (dark ? '#1e1e1e' : '#ffffff');

  let proto = detectProtocol(opts);
  if (opts.forceImage && proto === 'unicode' && !opts.unicode && !process.env.HOP_SESSION && process.stdout.isTTY) {
    proto = 'kitty'; // best-effort when the user insists on an image
  }

  if (proto !== 'unicode') {
    try {
      const { png, rows } = renderImagePng(latex, opts);
      process.stdout.write(proto === 'kitty' ? encodeKitty(png, rows) : encodeIterm(png, rows));
      return 0;
    } catch (e) {
      const hint = /Cannot find module/.test(e.message)
        ? "install image support with: npm i -g mathjax-full @resvg/resvg-js"
        : e.message;
      process.stderr.write(`hop math: image render unavailable (${hint}); using text layout.\n`);
    }
  }

  const b = latexToBox(latex);
  process.stdout.write(b.lines.join('\n') + '\n');
  return 0;
}

module.exports = { runMathCli, latexToBox, detectProtocol, renderImagePng };

if (require.main === module) {
  process.exit(runMathCli(process.argv.slice(2)));
}
