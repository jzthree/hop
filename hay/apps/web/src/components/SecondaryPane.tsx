import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { safeParseServerMessage } from "hay-shared";

// A lightweight additional pane: its own WS attach + xterm for one session,
// scaled-to-fit rendering, typing forwarded when focused. Deliberately
// NON-CLAIMING: it never sends resize, and connects with the room's current
// size, so it can watch (and poke) a session without fighting the primary
// viewer — or your phone — over the shared PTY size.
//
// Kept minimal by design (no optimistic echo, no find, no touch layer): the
// full-featured primary terminal is where heavy interaction happens; panes
// are for driving a fleet. Desktop-only.

type Props = {
  sessionName: string;
  procLabel?: string;
  wsUrl: string;
  userName: string;
  cols: number;
  rows: number;
  fontSize: number;
  theme: object;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onPromote?: () => void;
};

export const SecondaryPane = ({ sessionName, procLabel, wsUrl, userName, cols, rows, fontSize, theme, focused, onFocus, onClose, onPromote }: Props) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "ended" | "closed">("connecting");
  const [scale, setScale] = useState(1);
  const [activity, setActivity] = useState(false);
  const sizeRef = useRef({ cols, rows });
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const fitRef = useRef<() => void>(() => {});

  // Terminal + connection lifecycle.
  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      cols: sizeRef.current.cols,
      rows: sizeRef.current.rows,
      fontSize,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: theme as never,
      scrollback: 2000,
      convertEol: false
    });
    term.open(hostRef.current);
    termRef.current = term;

    let shouldReconnect = true;
    let reconnectTimer: number | null = null;
    let attempt = 0;

    const connect = () => {
      const sep = wsUrl.includes("?") ? "&" : "?";
      const ws = new WebSocket(
        `${wsUrl}${sep}room=${encodeURIComponent(sessionName)}&name=${encodeURIComponent(userName + " (pane)")}` +
          `&cols=${sizeRef.current.cols}&rows=${sizeRef.current.rows}`
      );
      wsRef.current = ws;
      setStatus("connecting");
      ws.onopen = () => setStatus("connected");
      ws.onmessage = (event) => {
        const message = safeParseServerMessage(String(event.data));
        if (!message) return;
        if (message.type === "output") {
          term.write(message.data);
          if (!focusedRef.current && message.data.trim()) setActivity(true);
        } else if (message.type === "snapshot") {
          term.reset();
          // The replay tail can't contain modes the app enabled once at
          // startup — seed them from the server-tracked flags so the pane
          // renders into the right buffer, and so xterm itself encodes wheel
          // events (SGR) that our onData then forwards: wheel-scrolling a
          // Claude pane scrolls Claude.
          let prelude = "";
          if (message.alternateScreen) prelude += "\x1b[?1049h";
          if (message.mouseReporting) prelude += "\x1b[?1002h";
          if (message.mouseSgr) prelude += "\x1b[?1006h";
          const coda = message.cursorHidden ? "\x1b[?25l" : "";
          term.write(prelude + message.data + coda, () => term.scrollToBottom());
        } else if (message.type === "session_ended") {
          shouldReconnect = false;
          setStatus("ended");
        } else if (message.type === "active_size") {
          // Someone else became active — follow the room's elected size. A
          // focused pane owns the size (it just claimed its box), so it
          // ignores foreign elections until the next box change.
          if (message.cols >= 2 && message.rows >= 2 && !focusedRef.current &&
              (message.cols !== sizeRef.current.cols || message.rows !== sizeRef.current.rows)) {
            sizeRef.current = { cols: message.cols, rows: message.rows };
            term.resize(message.cols, message.rows);
            requestAnimationFrame(fit);
          }
        }
      };
      ws.onclose = () => {
        if (!shouldReconnect) return;
        setStatus("connecting");
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** attempt, 15000));
      };
    };
    connect();

    // Typing routes to the session (input only — never resize).
    const dataSub = term.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    // A pane is a viewport. When FOCUSED it auto-fits like the main terminal:
    // it computes cols/rows for its box and CLAIMS that size (resize → wins the
    // active-size election), rendering crisp 1:1. When UNFOCUSED it can't claim
    // without fighting other viewers, so it renders the room's elected size
    // scaled to fit (letterboxed) — resizing its own term would garble output,
    // which was wrapped by the PTY at the room's width.
    const cellSize = () => {
      const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })
        ._core?._renderService?.dimensions?.css?.cell;
      return dims && dims.width > 0 && dims.height > 0 ? dims : null;
    };
    const fitFocused = () => {
      const box = boxRef.current;
      const cell = cellSize();
      if (!box || !cell) return;
      const cols = Math.max(20, Math.floor((box.clientWidth - 10) / cell.width));
      const rows = Math.max(6, Math.floor((box.clientHeight - 10) / cell.height));
      if (cols !== sizeRef.current.cols || rows !== sizeRef.current.rows) {
        sizeRef.current = { cols, rows };
        term.resize(cols, rows);
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
      setScale(1);
    };
    const scaleToFit = () => {
      const box = boxRef.current;
      const inner = hostRef.current;
      if (!box || !inner) return;
      const bw = box.clientWidth - 8;
      const bh = box.clientHeight - 8;
      const iw = inner.scrollWidth;
      const ih = inner.scrollHeight;
      if (iw > 0 && ih > 0 && bw > 0 && bh > 0) setScale(Math.min(bw / iw, bh / ih, 1.4));
    };
    const fit = () => (focusedRef.current ? fitFocused() : scaleToFit());
    fitRef.current = fit;
    const ro = new ResizeObserver(fit);
    if (boxRef.current) ro.observe(boxRef.current);
    const fitTimer = window.setTimeout(fit, 300);

    return () => {
      shouldReconnect = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      window.clearTimeout(fitTimer);
      ro.disconnect();
      dataSub.dispose();
      try { wsRef.current?.close(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionName, wsUrl]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = fontSize;
  }, [fontSize]);

  useEffect(() => {
    if (focused) { termRef.current?.focus(); setActivity(false); }
    // Focus change flips fit mode: gaining focus claims the box size (crisp),
    // losing it falls back to letterbox.
    requestAnimationFrame(() => fitRef.current());
  }, [focused]);

  return (
    <div
      className={`secondary-pane${focused ? " focused" : ""}`}
      onMouseDown={onFocus}
    >
      <div className="secondary-pane-bar">
        {activity && !focused && <span className="secondary-pane-dot" title="New output" />}
        <span className="secondary-pane-name">{sessionName}</span>
        {procLabel ? <span className="secondary-pane-proc">{procLabel}</span> : null}
        <span className={`secondary-pane-status ${status}`}>{status === "connected" ? "" : status}</span>
        {onPromote && (
          <button type="button" aria-label={`Swap ${sessionName} with primary`} title="Swap with primary (⌘⇧E)" onClick={(e) => { e.stopPropagation(); onPromote(); }}>
            ⇄
          </button>
        )}
        <button type="button" aria-label={`Close pane ${sessionName}`} onClick={(e) => { e.stopPropagation(); onClose(); }}>
          ✕
        </button>
      </div>
      <div className="secondary-pane-box" ref={boxRef}>
        <div className="secondary-pane-scale" style={{ transform: `scale(${scale})` }}>
          <div ref={hostRef} />
        </div>
      </div>
    </div>
  );
};
