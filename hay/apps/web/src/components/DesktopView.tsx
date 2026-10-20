import { useEffect, useRef, useState } from "react";
import { currentWsBase, noteSocketClosed } from "../utils/localLink";

// The machine's own desktop, through hop. The daemon pipes /desktop/ws to
// the local VNC server (macOS Screen Sharing); noVNC draws it here. hop's
// login got you this far; the VNC server then asks for its own (the Mac
// account), which goes straight to it and is never stored. The viewer is
// live only while open: closing it drops the connection.

// The terminal socket's url, pointed at the desktop pipe instead.
export const desktopUrl = (wsBase: string) => wsBase.replace(/\/ws(\?|$)/, "/desktop/ws$1");

type Status =
  | { kind: "connecting" }
  | { kind: "login"; types: string[]; failed?: string }
  | { kind: "live"; name: string }
  | { kind: "closed"; why: string };

type Rfb = EventTarget & {
  scaleViewport: boolean;
  clipViewport: boolean;
  dragViewport: boolean;
  viewOnly: boolean;
  focusOnClick: boolean;
  qualityLevel: number;
  compressionLevel: number;
  sendCredentials: (c: { username?: string; password?: string }) => void;
  disconnect: () => void;
  focus: () => void;
};

const USER_KEY = "hop.desktop.user";
const readUser = () => { try { return localStorage.getItem(USER_KEY) || ""; } catch { return ""; } };
const saveUser = (u: string) => { try { localStorage.setItem(USER_KEY, u); } catch { /* private window */ } };

type Props = { wsBase: string; onClose: () => void };

export const DesktopView = ({ wsBase, onClose }: Props) => {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<Rfb | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const [fit, setFit] = useState(true);
  const [viewOnly, setViewOnly] = useState(false);
  const [user, setUser] = useState(readUser);
  const [password, setPassword] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let rfb: Rfb | null = null;
    // Say why when nothing is there to connect to, instead of a bare
    // "disconnected": the most likely miss is Screen Sharing being off.
    fetch("/api/desktop", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (disposed || !d) return;
        if (!d.enabled) setHint("Desktop sharing is off on this machine. Run hop desktop on there.");
        else if (!d.reachable) setHint(d.platform === "darwin"
          ? "No VNC server is answering. Turn on Screen Sharing: System Settings → General → Sharing → Screen Sharing."
          : `No VNC server is answering on port ${d.port}.`);
        else setHint(null);
      })
      .catch(() => { /* the connect below says what happened */ });

    const open = (base: string, retryOnTunnel: boolean) => {
      const url = desktopUrl(base);
      // The VNC server answered (a login prompt, a refusal, or the desktop):
      // the link works, so a failure from here on is not the fast path's.
      let opened = false;
      // The server names itself before the desktop is up.
      let name = "";
      setStatus({ kind: "connecting" });
      // noVNC ships as an ES module with a top-level await; load it only
      // when someone actually opens the desktop.
      import("@novnc/novnc").then(({ default: RFB }) => {
        const box = screenRef.current;
        if (disposed || !box) return;
        rfb = new RFB(box, url, { shared: true }) as Rfb;
        rfbRef.current = rfb;
        rfb.scaleViewport = fit;
        rfb.clipViewport = !fit;
        rfb.dragViewport = !fit;
        rfb.viewOnly = viewOnly;
        rfb.focusOnClick = true;
        // Through a tunnel, fewer bytes beat sharper pixels.
        rfb.qualityLevel = 5;
        rfb.compressionLevel = 6;
        rfb.addEventListener("connect", () => {
          opened = true;
          if (!disposed) setStatus({ kind: "live", name });
          rfb?.focus();
        });
        rfb.addEventListener("desktopname", (e) => {
          name = String((e as CustomEvent).detail?.name || "");
          if (!disposed) setStatus((s) => (s.kind === "live" ? { kind: "live", name } : s));
        });
        rfb.addEventListener("credentialsrequired", (e) => {
          opened = true;
          const types = ((e as CustomEvent).detail?.types as string[] | undefined) || ["password"];
          if (!disposed) setStatus((s) => ({ kind: "login", types, failed: s.kind === "login" ? s.failed : undefined }));
        });
        rfb.addEventListener("securityfailure", (e) => {
          opened = true;
          const reason = String((e as CustomEvent).detail?.reason || "");
          if (!disposed) setStatus({ kind: "closed", why: reason || "The desktop refused that login." });
        });
        rfb.addEventListener("disconnect", () => {
          if (rfbRef.current === rfb) rfbRef.current = null;
          noteSocketClosed(url, opened);
          if (disposed) return;
          // The same-machine fast path refused: go round through the tunnel.
          if (!opened && retryOnTunnel && base !== wsBase) { open(wsBase, false); return; }
          setStatus((s) => (s.kind === "closed" ? s : { kind: "closed", why: opened ? "The desktop connection closed." : "Could not reach the desktop." }));
        });
      }).catch(() => { if (!disposed) setStatus({ kind: "closed", why: "The desktop viewer failed to load." }); });
    };
    open(currentWsBase(wsBase), true);
    return () => {
      disposed = true;
      try { rfbRef.current?.disconnect(); } catch { /* already closed */ }
      rfbRef.current = null;
    };
    // fit and viewOnly are applied live below, not by reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsBase, attempt]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.scaleViewport = fit;
    rfb.clipViewport = !fit;
    rfb.dragViewport = !fit;
  }, [fit]);
  useEffect(() => { if (rfbRef.current) rfbRef.current.viewOnly = viewOnly; }, [viewOnly]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const rfb = rfbRef.current;
    if (!rfb || status.kind !== "login") return;
    const creds: { username?: string; password?: string } = { password };
    if (status.types.includes("username")) { creds.username = user; saveUser(user); }
    setPassword("");
    setStatus({ kind: "connecting" });
    rfb.sendCredentials(creds);
  };

  const label = status.kind === "live" ? (status.name || "Connected")
    : status.kind === "login" ? "Sign in"
    : status.kind === "connecting" ? "Connecting…"
    : "Disconnected";

  return (
    // Keys typed here are the desktop's (or its sign-in form's), never the
    // wall's underneath: its type-to-filter took every printable, and its
    // arrows and Escape would steer the wall while you worked remotely.
    <div className="desktop-view" role="dialog" aria-label="Remote desktop"
         onKeyDown={(e) => e.nativeEvent.stopPropagation()}
         onKeyUp={(e) => e.nativeEvent.stopPropagation()}>
      <div className="desktop-bar">
        <span className="views-badge">Desktop</span>
        <span className={"desktop-status " + status.kind}>{label}</span>
        <span className="views-head-spacer" />
        <button type="button" className="desktop-tool" aria-pressed={fit} onClick={() => setFit((f) => !f)}
                title={fit ? "Show at full size and drag to pan" : "Fit the whole screen in the window"}>
          {fit ? "Fit" : "1:1"}
        </button>
        <button type="button" className="desktop-tool" aria-pressed={viewOnly} onClick={() => setViewOnly((v) => !v)}
                title="Watch without sending mouse or keys">
          {viewOnly ? "Viewing" : "Control"}
        </button>
        <button type="button" className="views-close" aria-label="Close desktop" onClick={onClose}>×</button>
      </div>
      <div className="desktop-screen" ref={screenRef} />
      {status.kind === "login" && (
        <form className="desktop-card" onSubmit={submit}>
          <div className="desktop-card-title">Sign in to the desktop</div>
          <p className="desktop-card-note">
            {status.types.includes("username")
              ? "Use this machine's account. It goes straight to the machine and hop does not keep it."
              : "The VNC password set on this machine."}
          </p>
          {status.types.includes("username") && (
            <input className="desktop-input" autoComplete="username" placeholder="Username" value={user}
                   onChange={(e) => setUser(e.target.value)} autoFocus={!user} />
          )}
          <input className="desktop-input" type="password" autoComplete="current-password" placeholder="Password"
                 value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!user || !status.types.includes("username")} />
          <div className="desktop-card-actions">
            <button type="button" className="desktop-tool" onClick={onClose}>Cancel</button>
            <button type="submit" className="desktop-tool primary" disabled={!password}>Connect</button>
          </div>
        </form>
      )}
      {status.kind === "closed" && (
        <div className="desktop-card">
          <div className="desktop-card-title">{status.why}</div>
          {hint && <p className="desktop-card-note">{hint}</p>}
          <div className="desktop-card-actions">
            <button type="button" className="desktop-tool" onClick={onClose}>Close</button>
            <button type="button" className="desktop-tool primary" onClick={() => setAttempt((n) => n + 1)}>Reconnect</button>
          </div>
        </div>
      )}
    </div>
  );
};
