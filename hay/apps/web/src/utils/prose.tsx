import { Fragment, type ReactNode } from "react";

// The little markdown an agent's prose uses — paragraphs, "- " bullets,
// "#"-headings, **bold**, *emphasis*, `code` and [links](https://…) — drawn
// as React elements, never as HTML, so nothing in a pulse or a briefing can
// script the page. Links leave hop in a new tab: they point elsewhere.

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))/g;

export const inline = (text: string, key = ""): ReactNode[] =>
  text.split(INLINE).filter((s) => s !== "").map((part, i) => {
    const k = key + i;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={k}>{part.slice(1, -1)}</code>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={k}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) return <a key={k} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    return <Fragment key={k}>{part}</Fragment>;
  });

type Block = { kind: "p" | "li" | "h"; text: string };

export const blocks = (text: string): Block[] => {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ kind: "p", text: para.join(" ") }); para = []; } };
  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^[-*•] /.test(line)) { flush(); out.push({ kind: "li", text: line.slice(2) }); continue; }
    if (/^#{1,4} /.test(line)) { flush(); out.push({ kind: "h", text: line.replace(/^#+ /, "") }); continue; }
    para.push(line);
  }
  flush();
  return out;
};

const FIGURE_LINE = /^\*Figure: (.+)\*$/;

/** Prose as paragraphs, lists and subheads; a "*Figure: caption*" line
 *  whose figure is given is drawn as the image with its caption. */
export const Prose = ({ text, className, figures }: { text: string; className?: string; figures?: Array<{ caption: string; src: string }> }) => {
  const bs = blocks(text);
  const nodes: ReactNode[] = [];
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (b.kind === "li") {
      const items: Block[] = [];
      while (i < bs.length && bs[i].kind === "li") items.push(bs[i++]);
      i--;
      nodes.push(<ul key={i}>{items.map((it, j) => <li key={j}>{inline(it.text, `${i}.${j}.`)}</li>)}</ul>);
    } else if (b.kind === "h") nodes.push(<h4 key={i}>{inline(b.text, `${i}.`)}</h4>);
    else if (figures?.length && FIGURE_LINE.test(b.text) && figures.some((f) => f.caption.trim() === FIGURE_LINE.exec(b.text)![1].trim())) {
      const cap = FIGURE_LINE.exec(b.text)![1].trim();
      const fig = figures.find((f) => f.caption.trim() === cap)!;
      nodes.push(
        <figure key={i} className="prose-figure">
          <a href={fig.src} target="_blank" rel="noreferrer"><img src={fig.src} alt={cap} loading="lazy" /></a>
          <figcaption>{inline(cap, `${i}.`)}</figcaption>
        </figure>
      );
    }
    else nodes.push(<p key={i}>{inline(b.text, `${i}.`)}</p>);
  }
  return <div className={"prose" + (className ? " " + className : "")}>{nodes}</div>;
};

/** Plain text of a piece of prose (for copying): markup removed. */
export const plainText = (text: string): string =>
  (text || "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
