import { currentWsBase, noteSocketClosed } from "./localLink";

/**
 * Types one line into a session and presses Enter, without opening it — the
 * iOS app's QuickReply, for the briefing's reply chips. hop takes input only
 * over the terminal WebSocket, so this opens a throwaway, live-only
 * connection (replay=0, nudge=0, attached at the session's own size so it
 * reshapes nothing), sends, and closes. Resolves false when the line did not
 * land — the socket never said hello, or input was rejected because someone
 * else holds control — so the caller never shows "sent" for an answer the
 * agent didn't get.
 */
export const sendLineToSession = (
  wsBase: string,
  room: string,
  text: string,
  opts: { userName?: string; cols?: number; rows?: number } = {}
): Promise<boolean> =>
  new Promise((resolve) => {
    if (!text) { resolve(false); return; }
    const base = currentWsBase(wsBase);
    const sep = base.includes("?") ? "&" : "?";
    const cols = opts.cols && opts.cols >= 2 ? opts.cols : 80;
    const rows = opts.rows && opts.rows >= 2 ? opts.rows : 24;
    const url = base + sep + "room=" + encodeURIComponent(room)
      + "&name=" + encodeURIComponent((opts.userName || "user") + " (reply)")
      + `&replay=0&nudge=0&cols=${cols}&rows=${rows}`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { resolve(false); return; }
    let opened = false;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(giveUp);
      try { ws.close(); } catch { /* already closed */ }
      resolve(ok);
    };
    // A tunnel that is asleep must not leave the chip spinning forever.
    const giveUp = window.setTimeout(() => finish(false), 12000);
    ws.onopen = () => { opened = true; };
    ws.onmessage = (ev) => {
      let msg: { type?: string } | null = null;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg?.type === "hello") {
        ws.send(JSON.stringify({ type: "input", data: text + "\r" }));
        // A rejection arrives at once; past this, the line landed.
        window.setTimeout(() => finish(true), 600);
      } else if (msg?.type === "input_rejected" || msg?.type === "error" || msg?.type === "session_ended") {
        finish(false);
      }
    };
    ws.onerror = () => finish(false);
    ws.onclose = () => { noteSocketClosed(url, opened); finish(false); };
  });
