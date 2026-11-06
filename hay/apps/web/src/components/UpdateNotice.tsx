import { useCallback, useEffect, useState } from "react";

// Notify-only update notice: the daemon asks npm daily whether a newer hop
// is published (lib/update-check.js) and serves the answer at /api/update.
// Dismissing hides it until the next release. With the sidebar it is an
// item at the bottom of the strip (seen from anywhere, full screen too) that
// opens UpdatePop; without one, the banner on the wall.

// What the update means for the terminals (the daemon's keeperUpdateStatus):
// requiresRestart — the new code needs a new terminal keeper, so every
// terminal ends (hop reopens them and resumes their conversations); stale —
// the running keeper predates fixes to it, which only a restart applies.
export type KeeperStatus = {
  keeper: boolean;
  requiresRestart: boolean;
  stale: boolean;
  reason: string | null;
  terminals: number;
  startedAt: number | null;
};
type UpdateInfo = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  command: string;
  keeper?: KeeperStatus | null;
};
type Progress = { active?: boolean; phase: string; error?: string; sessions?: number };

const PHASES: Record<string, string> = {
  starting: "Starting…",
  checking: "Checking what changed…",
  installing: "Installing the new hop…",
  pulling: "Getting the new code…",
  building: "Building…",
  restarting: "Restarting hop — this page reconnects in a moment…",
  "restarting-terminals": "Ending the terminals to replace the keeper…",
  restoring: "Reopening your sessions and resuming their conversations…",
  done: "Updated. Reloading…"
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

/** One click: start the update, then follow it through hop's restart. */
function useApplyUpdate() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!progress || progress.phase === "failed") return;
    let alive = true;
    const t = window.setInterval(() => {
      // The daemon restarts mid-update: a failed poll is that, not news.
      fetch("/api/update/progress", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((p: Progress | null) => {
          if (!alive || !p) return;
          setProgress(p);
          if (p.phase === "done") { window.clearInterval(t); window.setTimeout(() => window.location.reload(), 1200); }
          if (p.phase === "failed") { window.clearInterval(t); setError(p.error || "The update stopped."); }
        })
        .catch(() => {});
    }, 2000);
    return () => { alive = false; window.clearInterval(t); };
  }, [progress === null]);
  const apply = async (restartTerminals: boolean) => {
    setError(null);
    try {
      const r = await fetch("/api/update/apply", {
        method: "POST", headers: { "Content-Type": "application/json", "x-hop-actor": "user" },
        body: JSON.stringify({ restartTerminals })
      });
      const d = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) { setError(d.error || "hop did not start the update."); return; }
      setProgress({ phase: "starting", active: true });
    } catch { setError("hop did not start the update."); }
  };
  return { progress, error, apply };
}

/** The strip's update panel: what is new, what it means for your sessions, and the one click. */
export function UpdatePop({ update, onDismiss, onClose, live = 0, working = 0 }: {
  update: UpdateInfo; onDismiss: () => void; onClose: () => void;
  /** Sessions running now, and agents mid-turn (they would lose that turn). */
  live?: number; working?: number;
}) {
  const { copied, copy } = useCopy();
  const { progress, error, apply } = useApplyUpdate();
  const keeper = update.keeper;
  const ends = !!keeper?.requiresRestart;
  const [alsoRestart, setAlsoRestart] = useState(false);
  const sessions = keeper?.terminals || live;
  const busy = !!progress && progress.phase !== "failed";
  // Open until it is done: this panel follows the update and reloads the page.
  const close = () => { if (!busy) onClose(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!busy) onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, busy]);
  return (
    <>
      <div className="update-pop-backdrop" onClick={close} />
      <div className="update-pop" role="dialog" aria-label="hop update">
        <div className="update-pop-head">
          <span className="place-spark" aria-hidden="true">✦</span>
          <span>hop <strong>{update.latest}</strong> is out</span>
        </div>
        {busy ? (
          <p className="update-pop-text update-pop-progress" role="status">
            <span className="update-pop-spinner" aria-hidden="true" />{PHASES[progress!.phase] || "Updating…"}
          </p>
        ) : ends ? (
          <div className="update-pop-warn" role="alert">
            <strong>This update restarts every terminal.</strong> It replaces hop's terminal keeper, so all {sessions} session{sessions === 1 ? "" : "s"} end
            {working > 0 ? <>, and <strong>{working} agent{working === 1 ? " is" : "s are"} mid-turn</strong> and will lose that turn</> : null}.
            hop then reopens each one and resumes its conversation.
          </div>
        ) : (
          <p className="update-pop-text">You're on {update.current}. Updating keeps every session running — agents mid-turn included.</p>
        )}
        {!busy && !ends && keeper?.stale && (
          <label className="update-pop-also">
            <input type="checkbox" checked={alsoRestart} onChange={(e) => setAlsoRestart(e.target.checked)} />
            <span>Also restart the terminals, to pick up fixes to the terminal keeper — ends all {sessions} session{sessions === 1 ? "" : "s"}
              {working > 0 ? ` (${working} mid-turn)` : ""}, then reopens them.</span>
          </label>
        )}
        {error && <p className="update-pop-error" role="alert">{error}</p>}
        {!busy && (
          <div className="update-pop-go">
            <button type="button" className={"update-pop-now" + (ends || alsoRestart ? " ends" : "")}
                    onClick={() => void apply(ends || alsoRestart)}>
              {ends || alsoRestart ? `Update and restart ${sessions} session${sessions === 1 ? "" : "s"}` : "Update now"}
            </button>
            <button type="button" className="update-pop-cmd" onClick={() => copy(update.command)} title="Or run it yourself: copy the command">
              <code>{update.command}</code><span>{copied ? "copied" : "copy"}</span>
            </button>
          </div>
        )}
        <div className="update-pop-actions">
          <a href={WHATS_NEW} target="_blank" rel="noreferrer">What's new ↗</a>
          <span className="place-spacer" />
          {!busy && <button type="button" className="update-pop-later" onClick={() => { onDismiss(); onClose(); }} title="Hide until the next release">Later</button>}
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
