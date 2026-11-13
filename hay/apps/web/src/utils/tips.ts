// Tips: the small things hop does that nobody finds by looking — one a day on
// the sessions overview (components/TipCard), all of them in the shortcuts
// panel. Each says what to do and what happens, in a line; keys are written
// per platform as the shortcuts panel writes them (⌘ on a Mac; elsewhere
// Ctrl+Shift, which keeps clear of the terminal's own Ctrl keys).

export type Tip = { id: string; text: string };

export const tips = (isMac: boolean): Tip[] => {
  const mod = (k: string, shift = false) => (isMac ? `⌘${shift ? "⇧" : ""}${k}` : `Ctrl+Shift+${k}`);
  return [
    { id: "queue", text: `${isMac ? "⌘⌥⏎" : "Ctrl+Alt+⏎"} sends what you typed when the agent's turn ends (Codex's Tab, for Claude too). It waits in a card above the terminal, not in the input box.` },
    { id: "math", text: "Point at LaTeX in a terminal, like $E = mc^2$, to see it drawn; click to keep it open, select inside to copy." },
    { id: "side", text: "Views, Briefing, Pulse and Calendar can sit beside the terminal: the ◫ button in each moves it there. While that column is open, whatever you open goes into it." },
    { id: "back", text: `${mod("E")} goes back to the session you were just in; press it again to return.` },
    { id: "switch", text: `${mod("K")}, then type part of a session's name (or what it's about) and ⏎. A name nobody has starts a new session.` },
    { id: "drop", text: "Drop a file on a terminal: its path is typed into the session for the agent to use. A file on this machine is used where it is; from anywhere else it is uploaded first." },
    { id: "menu", text: "The ⋯ in a session's header is its menu: fit, redraw, copy the screen, rename, fork, kill. Right-clicking a session in the sidebar opens the same menu." },
    { id: "newline", text: "Shift+⏎ starts a new line in Claude's input box instead of sending." },
    { id: "replies", text: "The reply buttons on a briefing story type your answer into that session, or queue it if the agent is busy. No need to open it." },
    { id: "view", text: "Agents can hand you plots, PDFs and write-ups with `hop view`; they land in Views, newest first." },
    { id: "checkback", text: "`hop checkback --in 30m \"…\"` has hop type a message into a session later. Agents use it to keep their \"I'll check back\" promises; the Calendar shows what's coming." },
    { id: "calendar", text: `${mod("S", true)} opens the session's calendar: the check-backs and Codex automations coming up.` },
    { id: "find", text: `${mod("F")} searches a terminal's whole scrollback, not just the screen.` },
    { id: "redraw", text: "A garbled screen? \"redraw\" in the bar under the terminal repaints it, and asks Claude to repaint too." },
    { id: "port", text: "`hop port 5173` puts a dev server running in a session on hop's link, so you can open it from your phone." },
    { id: "mathcli", text: "`hop math '\\frac{a}{b}'` prints a formula in the terminal, for a quick look without leaving it." },
    { id: "sidebar", text: `${mod("B")} shows or hides the sidebar; drag its edge to resize it.` },
    { id: "settings", text: `${mod(",")} opens Settings: theme, text size, notifications, and every browser and device signed in to hop.` },
    { id: "keys", text: `${mod("/")} lists every keyboard shortcut. Six of them cover a working day.` }
  ];
};

const DAY_MS = 86_400_000;
/** Days since the epoch in local time: the tip changes at local midnight. */
export const localDay = (now = Date.now()): number => {
  const d = new Date(now);
  return Math.floor((now - d.getTimezoneOffset() * 60_000) / DAY_MS);
};

/** The tip for a day, `step` tips on from it (Next). Every tip comes round in turn. */
export const tipFor = (list: Tip[], day: number, step = 0): Tip => {
  const n = list.length;
  return list[(((day + step) % n) + n) % n];
};
