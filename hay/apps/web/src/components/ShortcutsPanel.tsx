import { useEffect } from "react";

// The keyboard, taught as a day's routine rather than a reference table:
// hop has many shortcuts, but a working day needs about six. They come
// first, in the order a day uses them; the handy extras sit under them, and
// the rest (panes, clipboard, scrollback, reordering) fold away.
//
// Chords are written per platform: ⌘ on a Mac; elsewhere Ctrl+Shift, which
// is what keeps them clear of the terminal's own Ctrl keys.

type Props = { isMac: boolean; onClose: () => void };

type Row = { keys: string; what: string };

export const shortcutKeys = (isMac: boolean) => {
  const mod = (k: string, shift = false) => (isMac ? `⌘${shift ? "⇧" : ""}${k}` : `Ctrl+Shift+${k}`);
  return { mod };
};

export const dayRoutine = (isMac: boolean): Array<Row & { title: string }> => {
  const { mod } = shortcutKeys(isMac);
  return [
    { keys: mod("K") + ", type, ⏎", title: "Switch", what: "Type part of a session's name (or what it is about); ↑ ↓ choose, ⏎ opens it. A name nobody has starts a new session." },
    { keys: mod("G"), title: "Catch up", what: "Jump to the next session with news — a question for you first, then finished turns you have not read." },
    { keys: mod("E"), title: "Go back", what: "To the session you were just in; again to return. " + mod("J") + " / " + mod("L") + " step left and right." },
    { keys: mod("K") + " " + mod("K"), title: "Survey", what: "The wall of every session. Arrows to move, ⏎ to step in, " + (isMac ? "⌘⏎" : "Ctrl+⏎") + " for full screen." },
    ...(isMac ? [{ keys: "⌘⇧V", title: "Read results", what: "The session's results — plots, PDFs, write-ups; ← → step through them. Again to go back to the session." }] : []),
    { keys: "Esc", title: "Back out", what: "Clears the search, then closes whatever is on top, one layer at a time." }
  ];
};

export const handyRows = (isMac: boolean): Row[] => {
  const { mod } = shortcutKeys(isMac);
  return [
    { keys: mod("F"), what: "find — in a terminal, or the session search on the wall" },
    { keys: mod("B"), what: "show / hide the sidebar" },
    { keys: mod("/"), what: "this guide" },
    { keys: "+ / −", what: "tile size on the wall" },
    { keys: isMac ? "⌘." : "Ctrl+.", what: "let go of a live tile" },
    { keys: mod(","), what: "settings" }
  ];
};

export const moreRows = (isMac: boolean): Row[] => [
  { keys: isMac ? "⌘D or ⌘\\" : "Ctrl+Shift+D", what: "split pane to the right" },
  { keys: isMac ? "⌘⇧D or ⌘⇧\\" : "Ctrl+Shift+|", what: "split pane below" },
  { keys: isMac ? "⌘⌥← ↑ ↓ →" : "Ctrl+Alt+arrows", what: "focus the pane in that direction" },
  { keys: isMac ? "⌘] / ⌘[" : "Ctrl+Shift+] / [", what: "next / previous pane" },
  { keys: isMac ? "⌘⇧⏎" : "Ctrl+Shift+⏎", what: "zoom the focused pane (again to restore)" },
  { keys: isMac ? "⌘⇧E" : "Ctrl+Shift+E", what: "swap pane with primary (with a pane open)" },
  { keys: isMac ? "⌘⇧K" : "Ctrl+Shift+K", what: "close focused pane (with a pane open)" },
  ...(isMac ? [{ keys: "⌘+ / ⌘− / ⌘0", what: "terminal font size" }] : []),
  { keys: "Ctrl+Shift+C / V", what: "copy / paste" },
  { keys: "Shift+PgUp / PgDn", what: "scrollback" },
  { keys: "⌥↑ / ⌥↓", what: "move a session in Manual order" }
];

export const ShortcutsPanel = ({ isMac, onClose }: Props) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <>
      <div className="views-backdrop shortcuts-backdrop" onClick={onClose} />
      <div className="shortcuts-panel" role="dialog" aria-label="Keyboard shortcuts">
        <div className="shortcuts-head">
          <div>
            <h3>A day without the mouse</h3>
            <p>Six chords cover a working day. The rest are below when you need them.</p>
          </div>
          <button type="button" className="views-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <ol className="shortcuts-day">
          {dayRoutine(isMac).map((r, i) => (
            <li key={r.title}>
              <span className="shortcuts-step" aria-hidden="true">{i + 1}</span>
              <span className="shortcuts-step-text">
                <span className="shortcuts-step-title">{r.title}</span>
                <span className="shortcuts-step-what">{r.what}</span>
              </span>
              <kbd>{r.keys}</kbd>
            </li>
          ))}
        </ol>
        <div className="shortcuts-label">Also handy</div>
        <div className="shortcuts-grid">
          {handyRows(isMac).map((r) => (
            <div key={r.keys} className="shortcuts-row"><kbd>{r.keys}</kbd><span>{r.what}</span></div>
          ))}
        </div>
        <details className="shortcuts-more">
          <summary>Panes, clipboard and the rest</summary>
          <div className="shortcuts-grid">
            {moreRows(isMac).map((r) => (
              <div key={r.keys} className="shortcuts-row"><kbd>{r.keys}</kbd><span>{r.what}</span></div>
            ))}
          </div>
        </details>
      </div>
    </>
  );
};
