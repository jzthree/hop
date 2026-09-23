// Find LaTeX in a line of terminal text.
//
// Agents write math the way papers do: `$…$`, `$$…$$`, `\(…\)`, `\[…\]` —
// and often bare, `\frac{a}{b}` in the middle of a sentence. A terminal
// shows all of that as source. The web client can do better: each span
// found here becomes a hover target rendered by KaTeX (utils/mathTooltip).
//
// Delimited forms are taken at face value (a `$` pair around something that
// looks like math, never around prices). Bare LaTeX is a run of math-like
// tokens that contains at least one command, with balanced braces, trimmed
// of the prose punctuation around it. Pure functions; see the tests.

export type MathSpan = {
  /** Offsets into the text; `end` exclusive. Covers the delimiters. */
  start: number;
  end: number;
  /** The LaTeX to render, delimiters stripped. */
  tex: string;
  /** Display (block) math vs inline. */
  display: boolean;
};

// Commands that mark a token as math even without braces.
const MATH_COMMANDS = new Set([
  "frac", "dfrac", "tfrac", "sqrt", "sum", "prod", "int", "iint", "oint", "lim", "log", "ln", "exp", "sin", "cos", "tan",
  "cdot", "times", "div", "pm", "mp", "leq", "geq", "le", "ge", "neq", "ne", "approx", "equiv", "sim", "simeq", "propto",
  "infty", "partial", "nabla", "hat", "bar", "vec", "tilde", "dot", "ddot", "overline", "underline", "mathbb", "mathcal",
  "mathbf", "mathrm", "mathit", "boldsymbol", "left", "right", "binom", "over", "to", "rightarrow", "leftarrow",
  "Rightarrow", "Leftarrow", "mapsto", "in", "notin", "subset", "subseteq", "cup", "cap", "forall", "exists", "ldots",
  "cdots", "vdots", "ddots", "prime", "circ", "degree", "angle", "perp", "parallel", "langle", "rangle", "lfloor",
  "rfloor", "lceil", "rceil", "text", "operatorname", "max", "min", "argmax", "argmin", "sup", "inf", "det", "tr",
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa",
  "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega"
]);

const COMMAND_RE = /\\([a-zA-Z]+)/g;

/** True when the text carries at least one recognisable LaTeX command. */
const hasMathCommand = (s: string): boolean => {
  COMMAND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMAND_RE.exec(s)) !== null) {
    if (MATH_COMMANDS.has(m[1])) return true;
    // Any command followed by a brace group is math enough (\foo{x}).
    if (s[m.index + m[0].length] === "{") return true;
  }
  return false;
};

/** Looks like math rather than prose or a price: a command, or structure. */
const looksLikeMath = (inner: string): boolean => {
  const s = inner.trim();
  if (!s) return false;
  if (hasMathCommand(s)) return true;
  // No command: a bare number is a price, never math. Otherwise structure
  // (sub/superscript, braces) or an operator next to a letter is enough —
  // and so is a lone variable, `$x$`, which papers write constantly.
  if (/^[\d.,\s]+$/.test(s)) return false;
  if (/^[A-Za-z]{1,2}$/.test(s)) return true;
  return /[\^_{}]/.test(s) || (/[=<>+\-*/|]/.test(s) && /[A-Za-z]/.test(s));
};

const braceBalance = (s: string): number => {
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "\\") { i += 1; continue; } // escaped brace
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
  }
  return depth;
};

const overlaps = (spans: MathSpan[], start: number, end: number) =>
  spans.some((sp) => start < sp.end && end > sp.start);

// A token belongs to a bare-math run when it is built of math characters.
// Prose words break the run; short function names and single letters do not.
const MATH_TOKEN_RE = /^[\\A-Za-z0-9_^{}()[\]|+\-*/=<>.,:;!'`&~]+$/;
const FUNCTION_WORDS = new Set(["sin", "cos", "tan", "log", "ln", "exp", "max", "min", "lim", "det", "tr", "mod", "dx", "dy", "dt"]);
const isMathToken = (tok: string): boolean => {
  if (!MATH_TOKEN_RE.test(tok)) return false;
  if (tok.includes("\\")) return true;
  // A plain word is prose ("so", "is", "then") unless it is a single letter
  // (x, n) or a function name (sin, log). Words with math punctuation stuck
  // to them (x_i, f(x), a+b) are math.
  const bare = tok.replace(/[.,;:!?)]+$/, "");
  if (/^[A-Za-z]+$/.test(bare)) return bare.length === 1 || FUNCTION_WORDS.has(bare);
  if (/[A-Za-z]{4,}/.test(tok) && !/[\\^_{}=+\-*/]/.test(tok)) return false; // "hello," "world."
  return true;
};

const trimSpan = (text: string, start: number, end: number): [number, number] => {
  let s = start;
  let e = end;
  while (s < e && /[\s,;:.!?]/.test(text[s])) s += 1;
  while (e > s && /[\s,;:.!?]/.test(text[e - 1])) e -= 1;
  // A trailing ")" that was never opened inside the span is prose punctuation.
  while (e > s && text[e - 1] === ")" && (text.slice(s, e).split("(").length - 1) < (text.slice(s, e).split(")").length - 1)) e -= 1;
  return [s, e];
};

/**
 * Bare LaTeX runs in `text`, avoiding regions already claimed. A run needs
 * a math command; tokens are extended left and right while they still read
 * as math, then trimmed to balanced braces.
 */
const findBareRuns = (text: string, claimed: MathSpan[], out: MathSpan[]) => {
  // Token boundaries by whitespace, remembering offsets.
  const tokens: Array<{ s: number; e: number; t: string }> = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) tokens.push({ s: m.index, e: m.index + m[0].length, t: m[0] });
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!hasMathCommand(tok.t) || overlaps(claimed, tok.s, tok.e)) { i += 1; continue; }
    // Grow left.
    let a = i;
    while (a > 0 && isMathToken(tokens[a - 1].t) && !overlaps(claimed, tokens[a - 1].s, tokens[a - 1].e) && tokens[a].s - tokens[a - 1].e <= 1) a -= 1;
    // Grow right.
    let b = i;
    while (b + 1 < tokens.length && isMathToken(tokens[b + 1].t) && !overlaps(claimed, tokens[b + 1].s, tokens[b + 1].e) && tokens[b + 1].s - tokens[b].e <= 1) b += 1;
    // Shrink from the right until braces balance.
    while (b >= a && braceBalance(text.slice(tokens[a].s, tokens[b].e)) !== 0) b -= 1;
    if (b < a) { i += 1; continue; }
    const [s, e] = trimSpan(text, tokens[a].s, tokens[b].e);
    const tex = text.slice(s, e);
    if (e > s && hasMathCommand(tex) && braceBalance(tex) === 0) {
      out.push({ start: s, end: e, tex, display: false });
    }
    i = b + 1;
  }
};

/** Every math span in `text`, delimited forms first, then bare runs. Sorted, non-overlapping. */
export const findMathSpans = (text: string): MathSpan[] => {
  const out: MathSpan[] = [];
  const claim = (start: number, end: number, tex: string, display: boolean) => {
    if (overlaps(out, start, end)) return;
    const t = tex.trim();
    if (!t || t.length > 600) return;
    out.push({ start, end, tex: t, display });
  };
  const delimited: Array<[RegExp, boolean]> = [
    [/\$\$([\s\S]+?)\$\$/g, true],
    [/\\\[([\s\S]+?)\\\]/g, true],
    [/\\\(([\s\S]+?)\\\)/g, false]
  ];
  for (const [re, display] of delimited) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (looksLikeMath(m[1]) || display) claim(m.index, m.index + m[0].length, m[1], display);
    }
  }
  // Inline dollars: no space just inside either `$`, no `$` within, and the
  // inside has to read as math (so "$5 and $10" stays money).
  const inline = /\$(?!\s)([^$\n]{1,200}?)(?<!\s)\$(?![\d$])/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(text)) !== null) {
    if (looksLikeMath(m[1])) claim(m.index, m.index + m[0].length, m[1], false);
  }
  findBareRuns(text, out, out);
  return out.sort((p, q) => p.start - q.start);
};
