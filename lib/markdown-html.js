'use strict';
// Markdown views as HTML. ./markdown.js parses (the same rules the web app
// draws Answers and the digest with); this writes the page body. All text is
// escaped, so raw HTML in a write-up shows as text. A link may be relative —
// a view's sibling file — or http(s)/mailto; any other scheme keeps only
// its words.

const { parseMarkdown, parseInline } = require('./markdown');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const schemeOf = (u) => (/^([a-z][a-z0-9+.-]*):/i.exec(String(u).trim()) || [])[1];
const okHref = (u) => { const s = schemeOf(u); return !s || /^(https?|mailto)$/i.test(s) ? String(u).trim() : null; };
const okSrc = (u) => { const s = schemeOf(u); return !s || /^https?$/i.test(s) || /^data:image\//i.test(String(u).trim()) ? String(u).trim() : null; };

function inlineHtml(nodes) {
    return nodes.map((n) => {
        switch (n.t) {
            case 'text': return esc(n.v);
            case 'code': return `<code>${esc(n.v)}</code>`;
            case 'br': return '<br>';
            case 'strong': case 'em': case 'del': return `<${n.t}>${inlineHtml(n.c)}</${n.t}>`;
            case 'img': { const src = okSrc(n.src); return src ? `<img alt="${esc(n.alt)}" src="${esc(src)}">` : esc(n.alt); }
            case 'link': { const href = okHref(n.href); const inner = inlineHtml(n.c); return href ? `<a href="${esc(href)}">${inner}</a>` : inner; }
            default: return '';
        }
    }).join('');
}
const inline = (s) => inlineHtml(parseInline(s));

function blocksHtml(bs, tight) {
    return bs.map((b) => {
        switch (b.kind) {
            // A list item that is one line of text is that text, not a paragraph.
            case 'p': return tight && bs.length === 1 ? inline(b.text) : `<p>${inline(b.text)}</p>`;
            case 'h': return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
            case 'code': return `<pre class="code"><code>${esc(b.text)}</code></pre>`;
            case 'hr': return '<hr>';
            case 'quote': return `<blockquote>${blocksHtml(b.blocks)}</blockquote>`;
            case 'list': {
                const tag = b.ordered ? 'ol' : 'ul';
                const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
                const items = b.items.map((it) => (it.check === null
                    ? `<li>${blocksHtml(it.blocks, true)}</li>`
                    : `<li class="task"><input type="checkbox" disabled${it.check ? ' checked' : ''}> ${blocksHtml(it.blocks, true)}</li>`));
                return `<${tag}${start}>${items.join('')}</${tag}>`;
            }
            case 'table': {
                const attrs = (c) => {
                    // Labels and figures on one line; a column of sentences wraps, never narrower than a phrase.
                    const cls = [b.numeric[c] && 'num', b.short[c] ? 'nw' : 'wrap'].filter(Boolean).join(' ');
                    return (cls ? ` class="${cls}"` : '') + (b.align[c] ? ` style="text-align:${b.align[c]}"` : '');
                };
                return '<table><thead><tr>' + b.head.map((h, c) => `<th${attrs(c)}>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'
                    + b.rows.map((r) => '<tr>' + r.map((v, c) => `<td${attrs(c)}>${inline(v)}</td>`).join('') + '</tr>').join('')
                    + '</tbody></table>';
            }
            default: return '';
        }
    }).join('\n');
}

/** The body HTML for a markdown document. */
const markdownToHtml = (src) => blocksHtml(parseMarkdown(src));

module.exports = { markdownToHtml };
