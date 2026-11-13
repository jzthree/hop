import { Fragment, useState, type ReactNode } from "react";
import { parseInline, parseMarkdown, type MdBlock, type MdInline } from "./markdown";

// An agent's markdown — a reply, a pulse, a briefing — drawn as React
// elements, never as HTML, so nothing in it can script the page (see
// ./markdown for what is understood). Links leave hop in a new tab: they
// point elsewhere. Wide tables and code scroll sideways inside their own
// box, so a card never grows wider than the screen.

/** Where a link may go: the web, mail, or one of hop's own views. */
const safeHref = (href: string): string | null =>
  /^(https?:|mailto:)/i.test(href) || /^\/view\//.test(href) ? href : null;

const drawInline = (nodes: MdInline[], key: string): ReactNode[] =>
  nodes.map((n, i) => {
    const k = key + i;
    switch (n.t) {
      case "text": return <Fragment key={k}>{n.v}</Fragment>;
      case "code": return <code key={k}>{n.v}</code>;
      case "br": return <br key={k} />;
      case "strong": return <strong key={k}>{drawInline(n.c, k + ".")}</strong>;
      case "em": return <em key={k}>{drawInline(n.c, k + ".")}</em>;
      case "del": return <del key={k}>{drawInline(n.c, k + ".")}</del>;
      case "img": {
        const href = safeHref(n.src);
        const label = n.alt || "image";
        return href ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <Fragment key={k}>{label}</Fragment>;
      }
      case "link": {
        const href = safeHref(n.href);
        const kids = drawInline(n.c, k + ".");
        // A link hop can't follow (a file path, a relative link) keeps its
        // words, with the target on hover.
        return href
          ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{kids}</a>
          : <span key={k} className="prose-deadlink" title={n.href}>{kids}</span>;
      }
    }
  });

/** Inline markdown as elements. */
export const inline = (text: string, key = ""): ReactNode[] => drawInline(parseInline(text), key);

const CodeBlock = ({ text, lang }: { text: string; lang: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const done = () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
    navigator.clipboard?.writeText(text).then(done, () => {});
  };
  return (
    <div className="prose-code">
      <pre data-lang={lang || undefined}><code>{text}</code></pre>
      <button type="button" className="prose-copy" onClick={copy} aria-label="Copy code">{copied ? "Copied" : "Copy"}</button>
    </div>
  );
};

const FIGURE_LINE = /^\*Figure: (.+)\*$/;
type Figure = { caption: string; src: string };

const drawBlocks = (bs: MdBlock[], key: string, figures?: Figure[], tight = false): ReactNode[] =>
  bs.map((b, i) => {
    const k = key + i;
    switch (b.kind) {
      case "p": {
        const cap = FIGURE_LINE.exec(b.text)?.[1]?.trim();
        const fig = cap && figures?.find((f) => f.caption.trim() === cap);
        if (fig) {
          return (
            <figure key={k} className="prose-figure">
              <a href={fig.src} target="_blank" rel="noreferrer"><img src={fig.src} alt={cap} loading="lazy" /></a>
              <figcaption>{inline(cap!, k + ".")}</figcaption>
            </figure>
          );
        }
        // A list item that is one line of text is that text, not a paragraph.
        return tight && bs.length === 1 ? <Fragment key={k}>{inline(b.text, k + ".")}</Fragment> : <p key={k}>{inline(b.text, k + ".")}</p>;
      }
      case "h": {
        const H = b.level <= 3 ? "h4" : "h5";
        return <H key={k} className={`prose-h${b.level}`}>{inline(b.text, k + ".")}</H>;
      }
      case "code": return <CodeBlock key={k} text={b.text} lang={b.lang} />;
      case "hr": return <hr key={k} />;
      case "quote": return <blockquote key={k}>{drawBlocks(b.blocks, k + ".", figures)}</blockquote>;
      case "list": {
        const items = b.items.map((it, j) => (
          <li key={j} className={it.check === null ? undefined : "prose-task"}>
            {it.check !== null && <span className={"prose-box" + (it.check ? " done" : "")} aria-label={it.check ? "done" : "not done"} role="img">{it.check ? "✓" : ""}</span>}
            {drawBlocks(it.blocks, `${k}.${j}.`, figures, true)}
          </li>
        ));
        return b.ordered
          ? <ol key={k} start={b.start !== 1 ? b.start : undefined}>{items}</ol>
          : <ul key={k}>{items}</ul>;
      }
      case "table": {
        const style = (c: number) => (b.align[c] ? { textAlign: b.align[c]! } : undefined);
        const cls = (c: number) => [b.numeric[c] && "num", b.short[c] && "nw"].filter(Boolean).join(" ") || undefined;
        return (
          <div key={k} className="prose-table" tabIndex={0} role="region" aria-label="Table">
            <table>
              <thead><tr>{b.head.map((h, c) => <th key={c} style={style(c)} className={cls(c)}>{inline(h, `${k}.h${c}.`)}</th>)}</tr></thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>{r.map((cell, c) => <td key={c} style={style(c)} className={cls(c)}>{inline(cell, `${k}.${ri}.${c}.`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
    }
  });

/** Prose as paragraphs, headings, lists, tables and code; a
 *  "*Figure: caption*" line whose figure is given is drawn as the image
 *  with its caption. */
export const Prose = ({ text, className, figures }: { text: string; className?: string; figures?: Figure[] }) => (
  <div className={"prose" + (className ? " " + className : "")}>{drawBlocks(parseMarkdown(text), "", figures)}</div>
);

/** Plain text of a piece of prose (for copying): markup removed. */
export const plainText = (text: string): string =>
  (text || "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
