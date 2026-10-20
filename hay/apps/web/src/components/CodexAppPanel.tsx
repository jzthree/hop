import { useEffect, useState } from "react";
import { relativeTime } from "../utils/switcherModel";

// The Codex desktop app's threads on the Mac hop runs on, continued in hop
// (the phone's "Codex app threads" sheet, same daemon API). Codex lets one
// process write a thread: a thread the app has open continues here as a
// fork — a copy, the app's own thread untouched — a free one resumes, and
// one a hop session already runs just opens that session.

type CodexAppThread = {
  id: string;
  title: string;
  cwd: string | null;
  updatedAt: number;
  pinned: boolean;
  holder: "app" | "terminal" | "daemon" | null;
  hopSession: { internalName: string; displayName: string; parked: boolean } | null;
};

type Props = {
  onClose: () => void;
  // The hop session now carrying the thread.
  onOpen: (internalName: string, displayName: string) => void;
};

const verb = (t: CodexAppThread) => (t.hopSession ? "Open in hop" : t.holder ? "Fork here" : "Continue");
const verbTitle = (t: CodexAppThread) =>
  t.hopSession ? `Already running in hop as ${t.hopSession.displayName}`
    : t.holder === "app" ? "The Codex app has this thread open — hop continues a copy"
      : t.holder ? "Another Codex process is writing this thread — hop continues a copy"
        : "Resume this conversation in a new hop session";

export const CodexAppPanel = ({ onClose, onOpen }: Props) => {
  const [threads, setThreads] = useState<CodexAppThread[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/codex/desktop", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setThreads(Array.isArray(d?.threads) ? d.threads : []); setFailed(false); })
      .catch(() => { setFailed(true); setThreads([]); });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const open = async (t: CodexAppThread) => {
    setBusy(t.id);
    setError(null);
    try {
      const r = await fetch("/api/codex/continue", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-hop-actor": "user" },
        body: JSON.stringify({ id: t.id })
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.internalName) throw new Error(d?.error || "Could not continue that thread");
      onOpen(d.internalName, d.name || d.internalName);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="views-backdrop" onClick={onClose} />
      <div className="views-panel checkbacks-panel codex-app-panel" role="dialog" aria-label="Codex app threads">
        <div className="views-head">
          <span className="views-badge">Codex app</span>
          <span className="checkbacks-session">threads on this Mac</span>
          <span className="views-head-spacer" />
          <button type="button" className="views-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {error && <p className="checkbacks-empty codex-app-error">{error}</p>}
        {threads === null ? (
          <p className="checkbacks-empty">Loading…</p>
        ) : failed ? (
          <p className="checkbacks-empty">Could not read the Codex app's threads.</p>
        ) : threads.length === 0 ? (
          <p className="checkbacks-empty">No Codex app threads on this Mac.</p>
        ) : (
          <div className="checkbacks-list">
            {threads.map((t) => (
              <button type="button" key={t.id} className="codex-app-row" disabled={busy !== null}
                      title={verbTitle(t)} onClick={() => void open(t)}>
                <span className="codex-app-main">
                  <span className="codex-app-title">{t.title}</span>
                  <span className="codex-app-meta">
                    {t.cwd ? t.cwd.split("/").filter(Boolean).pop() || "/" : ""}
                    {t.updatedAt ? ` · ${relativeTime(t.updatedAt, Date.now())}` : ""}
                    {t.hopSession ? ` · in hop: ${t.hopSession.displayName}` : t.holder === "app" ? " · open in the app" : ""}
                  </span>
                </span>
                <span className="codex-app-verb">{busy === t.id ? "…" : verb(t)}</span>
              </button>
            ))}
          </div>
        )}
        <p className="checkbacks-hint">In a Codex session, its menu's “Hand off to Codex app” goes the other way.</p>
      </div>
    </>
  );
};
