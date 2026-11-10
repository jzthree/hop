import { useEffect, useRef, useState, type ReactNode } from "react";
import { relativeTime } from "../utils/switcherModel";
import { setTipsOff, tipsAreOff } from "./TipCard";
import type { UpdateInfo } from "./UpdateNotice";

// Settings: how hop looks and behaves in this browser, who you are to the
// others watching, where you are signed in, and which hop this is. A place
// of its own (⌘, or the sidebar's Settings) beside the sidebar, or a full
// sheet where there is none (a phone, a narrow window), reachable with or
// without a session open.
//
// What is NOT here: what you do to one session (rename, fit, redraw, copy,
// who may type, kill) — that is the session's menu (its ⋯ in the header, or
// a right-click in the sidebar), where the session is. Preferences are per
// browser (localStorage) unless a row says otherwise.

export type ThemeMode = "system" | "light" | "dark";

type AuthLogin = {
  id: string; label: string | null; via: string; ip?: string | null; userAgent?: string | null;
  createdAt?: number; lastSeenAt?: number; expiresAt?: number | null; current?: boolean;
};
// (The passkey store keeps its times as ISO text; logins as ms.)
type Passkey = { id: string; rpID: string; label?: string | null; createdAt?: number | string; lastUsedAt?: number | string | null };

type Props = {
  /** "page": beside the docked sidebar; "sheet": the whole window. */
  placement: "page" | "sheet";
  onClose: () => void;
  isMac: boolean;
  /** A touch device: Touch and Haptics rows; no keyboard hints. */
  touch: boolean;
  themeMode: ThemeMode;
  onTheme: (m: ThemeMode) => void;
  fontSize: number;
  onFontSize: (n: number) => void;
  viewMode: "fit" | "full";
  onViewMode: (m: "fit" | "full") => void;
  selectionMode?: boolean;
  onSelectionMode?: (on: boolean) => void;
  haptics?: boolean;
  onHaptics?: (on: boolean) => void;
  /** Absent where the browser has no notifications. */
  notify?: boolean;
  onNotify?: (on: boolean) => void;
  name: string;
  onName: (next: string) => void;
  /** Absent where a passkey cannot be made (an IP address, the Mac app). */
  onAddPasskey?: () => Promise<void> | void;
  /** The Mac app signs itself in: no Sign out here. */
  native: boolean;
  build: string;
  onShowUpdate?: (u: UpdateInfo) => void;
  onShowShortcuts: () => void;
  onNotice: (text: string) => void;
  now?: number;
};

// How each login was made (the daemon's issueAuthSession / device tokens).
const VIA: Record<string, string> = {
  totp: "authenticator code", passkey: "passkey", handoff: "moved from another address", "device-token": "device token"
};

const Seg = <T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string;
}) => (
  <span className="set-seg" role="radiogroup" aria-label={label}>
    {options.map(([v, text]) => (
      <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""}
              onClick={() => { if (value !== v) onChange(v); }}>{text}</button>
    ))}
  </span>
);

const Row = ({ title, note, children, wide }: { title: string; note?: ReactNode; children?: ReactNode; wide?: boolean }) => (
  <div className={"set-row" + (wide ? " wide" : "")}>
    <div className="set-label">
      <span className="set-title">{title}</span>
      {note && <span className="set-note">{note}</span>}
    </div>
    {children && <div className="set-control">{children}</div>}
  </div>
);

const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section className="set-section" aria-labelledby={`set-${id}`}>
    <h2 className="set-section-head" id={`set-${id}`}>{title}</h2>
    <div className="set-card">{children}</div>
  </section>
);

const LOGINS_SHOWN = 5;
/** A time the daemon sent as ms or as ISO text; 0 when there is none. */
const msOf = (t?: number | string | null) => {
  const n = typeof t === "number" ? t : t ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const day = (t?: number | string | null) => (msOf(t) ? new Date(msOf(t)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");

export const SettingsPage = (p: Props) => {
  const now = p.now ?? Date.now();
  const sheet = p.placement === "sheet";
  // Keys as the shortcuts panel writes them (off a Mac, Ctrl+Shift).
  const key = (k: string) => (p.isMac ? `⌘${k}` : `Ctrl+Shift+${k}`);
  const [tipsOn, setTipsOn] = useState(() => !tipsAreOff());
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(p.name);
  const [logins, setLogins] = useState<AuthLogin[] | null>(null);
  const [allLogins, setAllLogins] = useState(false);
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  // The page takes the keyboard from the terminal under it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  const loadLogins = () => {
    fetch("/api/auth/sessions", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && Array.isArray(d.sessions)) setLogins(d.sessions); })
      .catch(() => {});
  };
  const loadPasskeys = () => {
    fetch("/api/passkeys/list", { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && Array.isArray(d.passkeys)) setPasskeys(d.passkeys); })
      .catch(() => {});
  };
  useEffect(() => {
    loadLogins();
    loadPasskeys();
    fetch("/api/update", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) setUpdate(d); }).catch(() => {});
    fetch("/api/instance", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.canonicalUrl) setAddress(d.canonicalUrl); }).catch(() => {});
  }, []);

  // Esc leaves, unless a name is being typed (its Esc is its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest?.(".set-name-edit")) return;
      e.preventDefault();
      p.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveName = () => {
    const next = nameDraft.trim();
    setEditingName(false);
    if (next && next !== p.name) p.onName(next);
  };
  const signOutLogin = async (l: AuthLogin) => {
    if (!window.confirm(`Sign out ${l.label || "this login"}? It will need to sign in again.`)) return;
    const r = await fetch("/api/auth/sessions/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: l.id }) }).catch(() => null);
    p.onNotice(r?.ok ? `Signed out ${l.label || "that login"}` : "That didn't work");
    loadLogins();
  };
  const signOutHere = async () => {
    if (!window.confirm("Sign out of hop in this browser?")) return;
    await fetch("/api/logout", { method: "POST" }).catch(() => null);
    window.location.href = "/";
  };
  const removePasskey = async (k: Passkey) => {
    if (!window.confirm(`Remove the passkey for ${k.rpID}? Sign-in there falls back to the password.`)) return;
    const r = await fetch("/api/passkeys/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: k.id }) }).catch(() => null);
    p.onNotice(r?.ok ? "Passkey removed" : "That didn't work");
    loadPasskeys();
  };
  const copy = (text: string, what: string) => {
    const done = navigator.clipboard?.writeText(text);
    if (!done) { p.onNotice("The browser would not copy here"); return; }
    done.then(() => p.onNotice(`Copied ${what}`)).catch(() => p.onNotice("The browser would not copy here"));
  };

  return (
    <div className={"place-page settings-page" + (sheet ? " sheet" : "")} role={sheet ? "dialog" : "region"} aria-label="Settings" tabIndex={-1} ref={rootRef}>
      <header className="place-head">
        <span className="place-title">Settings</span>
        <span className="place-spacer" />
        {!p.touch && <span className="set-key-hint"><kbd>{key(",")}</kbd></span>}
        <button type="button" className="views-close" aria-label="Close settings" onClick={p.onClose}>×</button>
      </header>
      <div className="place-col set-col">
        <Section id="look" title="Appearance">
          <Row title="Theme" note="Auto follows the system.">
            <Seg label="Theme" value={p.themeMode} onChange={p.onTheme}
                 options={[["system", "Auto"], ["light", "Light"], ["dark", "Dark"]]} />
          </Row>
          <Row title="Terminal text" note={p.isMac && !p.touch ? "⌘+ and ⌘− change it anywhere, ⌘0 resets." : undefined}>
            <span className="set-stepper">
              <button type="button" aria-label="Smaller text" disabled={p.fontSize <= 8} onClick={() => p.onFontSize(Math.max(8, p.fontSize - 1))}>−</button>
              <span className="set-stepper-v" aria-live="polite">{p.fontSize}px</span>
              <button type="button" aria-label="Larger text" disabled={p.fontSize >= 24} onClick={() => p.onFontSize(Math.min(24, p.fontSize + 1))}>+</button>
            </span>
          </Row>
        </Section>

        <Section id="term" title="Terminals">
          <Row title="Window size"
               note={p.viewMode === "fit"
                 ? "A session takes the size of the window you look at it from; others watching follow."
                 : "A session keeps its own size; a smaller window scrolls around it."}>
            <Seg label="Window size" value={p.viewMode} onChange={p.onViewMode} options={[["fit", "Fit window"], ["full", "Keep size"]]} />
          </Row>
          {p.touch && p.onSelectionMode && (
            <Row title="Touch" note="What a drag on the terminal does.">
              <Seg label="Touch" value={p.selectionMode ? "select" : "scroll"} onChange={(v) => p.onSelectionMode!(v === "select")}
                   options={[["scroll", "Scroll"], ["select", "Select text"]]} />
            </Row>
          )}
          {p.touch && p.onHaptics && (
            <Row title="Haptics" note="A tap you can feel on hop's keys.">
              <Seg label="Haptics" value={p.haptics ? "on" : "off"} onChange={(v) => p.onHaptics!(v === "on")} options={[["on", "On"], ["off", "Off"]]} />
            </Row>
          )}
        </Section>

        <Section id="attention" title="Attention & help">
          {p.onNotify && (
            <Row title="Notifications" note="A system notification when a session rings for you while you are elsewhere.">
              <Seg label="Notifications" value={p.notify ? "on" : "off"} onChange={(v) => p.onNotify!(v === "on")} options={[["off", "Off"], ["on", "On"]]} />
            </Row>
          )}
          <Row title="Tip of the day" note="One line on the sessions overview about something hop can do.">
            <Seg label="Tip of the day" value={tipsOn ? "on" : "off"} options={[["on", "On"], ["off", "Off"]]}
                 onChange={(v) => { setTipsOff(v === "off"); setTipsOn(v === "on"); }} />
          </Row>
          <Row title="Keyboard shortcuts" note="Every key hop knows, and all the tips.">
            <button type="button" className="set-btn" onClick={p.onShowShortcuts}>Show{!p.touch && <kbd>{key("/")}</kbd>}</button>
          </Row>
        </Section>

        <Section id="you" title="You">
          <Row title="Your name" note="Shown to anyone else watching the same session.">
            {editingName ? (
              <form className="set-name-edit" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
                <input value={nameDraft} maxLength={24} autoFocus aria-label="Your name"
                       onChange={(e) => setNameDraft(e.target.value)}
                       onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditingName(false); } }} />
                <button type="submit" className="set-btn">Save</button>
              </form>
            ) : (
              <button type="button" className="set-btn quiet" onClick={() => { setNameDraft(p.name); setEditingName(true); }}>
                {p.name} <span aria-hidden="true">✎</span>
              </button>
            )}
          </Row>
        </Section>

        <Section id="signin" title="Sign-in">
          {(p.onAddPasskey || (passkeys && passkeys.length > 0)) && (
            <Row wide title="Passkeys" note="Touch ID or Face ID instead of the password, on hop's web address.">
              <div className="set-list">
                {(passkeys || []).map((k) => (
                  <div key={k.id} className="set-item">
                    <span className="set-item-main">{k.label || k.rpID}</span>
                    <span className="set-item-meta">{k.rpID}{msOf(k.createdAt) ? ` · added ${day(k.createdAt)}` : ""}{msOf(k.lastUsedAt) ? ` · used ${relativeTime(msOf(k.lastUsedAt), now)}` : ""}</span>
                    <button type="button" className="set-btn quiet danger" onClick={() => { void removePasskey(k); }}>Remove</button>
                  </div>
                ))}
                {p.onAddPasskey && (
                  <button type="button" className="set-btn" onClick={() => { void Promise.resolve(p.onAddPasskey!()).then(loadPasskeys); }}>Add a passkey for this device</button>
                )}
              </div>
            </Row>
          )}
          <Row wide title="Signed in" note="Every browser, app and device token that can open hop. Sign out any you do not know.">
            <div className="set-list">
              {logins === null && <span className="set-item-meta">Loading…</span>}
              {/* This browser first, then the most recently seen; a long list folds. */}
              {[...(logins || [])].sort((a, b) => Number(!!b.current) - Number(!!a.current)).slice(0, allLogins ? undefined : LOGINS_SHOWN).map((l) => (
                <div key={l.id} className={"set-item" + (l.current ? " current" : "")}>
                  <span className="set-item-main">{l.label || "Unnamed login"}{l.current && <span className="set-chip">this browser</span>}</span>
                  <span className="set-item-meta">
                    {VIA[l.via] || l.via}
                    {msOf(l.lastSeenAt) ? ` · seen ${relativeTime(msOf(l.lastSeenAt), now)}` : ""}
                    {l.expiresAt ? ` · until ${day(l.expiresAt)}` : " · no expiry"}
                  </span>
                  {!l.current && <button type="button" className="set-btn quiet danger" onClick={() => { void signOutLogin(l); }}>Sign out</button>}
                </div>
              ))}
              {!allLogins && (logins?.length || 0) > LOGINS_SHOWN && (
                <button type="button" className="set-btn quiet" onClick={() => setAllLogins(true)}>{(logins!.length - LOGINS_SHOWN)} more…</button>
              )}
              {!p.native && <button type="button" className="set-btn" onClick={() => { void signOutHere(); }}>Sign out of this browser</button>}
            </div>
          </Row>
        </Section>

        <Section id="about" title="About">
          <Row title="hop" note={<>build <code>{p.build}</code></>}>
            {update?.updateAvailable && update.latest ? (
              <button type="button" className="set-btn accent" onClick={() => p.onShowUpdate?.(update)}>Update to {update.latest}…</button>
            ) : (
              <span className="set-value">{update?.current ? `${update.current} · up to date` : ""}</span>
            )}
          </Row>
          {address && (
            <Row title="Web address" note={<code className="set-addr">{address.replace(/^https?:\/\//, "")}</code>}>
              <button type="button" className="set-btn" onClick={() => copy(address, "the address")}>Copy</button>
            </Row>
          )}
        </Section>
      </div>
    </div>
  );
};
