import { useEffect, useState } from "react";

// Notify-only update notice: the daemon asks npm daily whether a newer hop
// is published (lib/update-check.js) and serves the answer at /api/update.
// Dismissing hides it until the next release.

type UpdateInfo = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  command: string;
};

const DISMISS_KEY = "hop.update.dismissed";
const POLL_MS = 6 * 60 * 60 * 1000;

function readDismissed(): string | null {
  try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
}

export function UpdateNotice() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [copied, setCopied] = useState(false);

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

  if (!info?.updateAvailable || !info.latest || dismissed === info.latest) return null;

  const copy = () => {
    navigator.clipboard?.writeText(info.command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, info.latest!); } catch { /* per-viewer only */ }
    setDismissed(info.latest);
  };

  return (
    <div className="update-notice" role="status">
      <span className="update-notice-icon" aria-hidden="true">✦</span>
      <span className="update-notice-text">
        hop <strong>{info.latest}</strong> is available (you're on {info.current}) — update with{" "}
        <button type="button" className="update-notice-cmd" onClick={copy} title="Copy command">
          {copied ? "copied" : info.command}
        </button>
        ; sessions keep running.
      </span>
      <a className="update-notice-link" href="https://github.com/jzthree/hop/commits/main" target="_blank" rel="noreferrer">
        what's new
      </a>
      <button type="button" className="update-notice-close" aria-label="Dismiss until the next release" title="Dismiss until the next release" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
