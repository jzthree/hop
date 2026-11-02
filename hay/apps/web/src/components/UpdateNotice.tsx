import { useCallback, useEffect, useState } from "react";

// Notify-only update notice: the daemon asks npm daily whether a newer hop
// is published (lib/update-check.js) and serves the answer at /api/update.
// Dismissing hides it until the next release. With the sidebar it is an
// item at the bottom of the strip (seen from anywhere, full screen too) that
// opens UpdatePop; without one, the banner on the wall.

type UpdateInfo = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  command: string;
};

const DISMISS_KEY = "hop.update.dismissed";
const POLL_MS = 6 * 60 * 60 * 1000;
const WHATS_NEW = "https://github.com/jzthree/hop/commits/main";

function readDismissed(): string | null {
  try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
}

/** The update, when there is one this viewer hasn't put off; and how to put it off. */
export function useUpdateInfo() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/update", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive && d) setInfo(d); })
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, []);
  const pending = !!info?.updateAvailable && !!info.latest && dismissed !== info.latest ? info : null;
  const dismiss = useCallback(() => {
    if (!info?.latest) return;
    try { localStorage.setItem(DISMISS_KEY, info.latest); } catch { /* per-viewer only */ }
    setDismissed(info.latest);
  }, [info]);
  return { update: pending, dismiss };
}

const useCopy = () => {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return { copied, copy };
};

/** The strip's update panel: the version, the command, what's new, later. */
export function UpdatePop({ update, onDismiss, onClose }: { update: UpdateInfo; onDismiss: () => void; onClose: () => void }) {
  const { copied, copy } = useCopy();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <>
      <div className="update-pop-backdrop" onClick={onClose} />
      <div className="update-pop" role="dialog" aria-label="hop update">
        <div className="update-pop-head">
          <span className="place-spark" aria-hidden="true">✦</span>
          <span>hop <strong>{update.latest}</strong> is out</span>
        </div>
        <p className="update-pop-text">You're on {update.current}. Updating keeps every session running.</p>
        <button type="button" className="update-pop-cmd" onClick={() => copy(update.command)} title="Copy the command">
          <code>{update.command}</code><span>{copied ? "copied" : "copy"}</span>
        </button>
        <div className="update-pop-actions">
          <a href={WHATS_NEW} target="_blank" rel="noreferrer">What's new ↗</a>
          <span className="place-spacer" />
          <button type="button" className="update-pop-later" onClick={() => { onDismiss(); onClose(); }} title="Hide until the next release">Later</button>
        </div>
      </div>
    </>
  );
}

/** The wall's banner, where there is no sidebar to carry the notice. */
export function UpdateNotice() {
  const { update, dismiss } = useUpdateInfo();
  const { copied, copy } = useCopy();
  if (!update) return null;
  return (
    <div className="update-notice" role="status">
      <span className="update-notice-icon" aria-hidden="true">✦</span>
      <span className="update-notice-text">
        hop <strong>{update.latest}</strong> is available (you're on {update.current}) — update with{" "}
        <button type="button" className="update-notice-cmd" onClick={() => copy(update.command)} title="Copy command">
          {copied ? "copied" : update.command}
        </button>
        ; sessions keep running.
      </span>
      <a className="update-notice-link" href={WHATS_NEW} target="_blank" rel="noreferrer">
        what's new
      </a>
      <button type="button" className="update-notice-close" aria-label="Dismiss until the next release" title="Dismiss until the next release" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
