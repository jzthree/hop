import { useEffect, useState } from "react";
import { describeState, describeTrigger, orderForSession, type Checkback } from "../utils/checkbackText";

// What is waiting on a session: the check-backs hop will type into it, when,
// and the recent ones it already typed. Opened from the ⏰ chip on a card.
// Pending ones can be cancelled here; scheduling stays with `hop checkback`
// and the agent's own MCP tool.

type Props = {
  session: string;
  sessionName: string;
  onClose: () => void;
  // The wall's chip count comes from the session list; a cancel here should
  // show there without waiting for the next poll.
  onChanged?: () => void;
};

export const CheckbacksPanel = ({ session, sessionName, onClose, onChanged }: Props) => {
  const [items, setItems] = useState<Checkback[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.now();

  const load = () => {
    fetch("/api/checkbacks", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setItems(Array.isArray(d?.items) ? d.items : []); setFailed(false); })
      .catch(() => { setFailed(true); setItems([]); });
  };
  useEffect(() => { load(); }, [session]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const cancel = async (id: string) => {
    setBusy(id);
    try {
      await fetch("/api/checkbacks/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    } finally {
      setBusy(null);
      load();
      onChanged?.();
    }
  };

  const rows = items ? orderForSession(items, session) : [];
  const pending = rows.filter((c) => c.status === "pending");
  const past = rows.filter((c) => c.status !== "pending").slice(0, 8);

  return (
    <>
      <div className="views-backdrop" onClick={onClose} />
      <div className="views-panel checkbacks-panel" role="dialog" aria-label={`Check-backs for ${sessionName}`}>
        <div className="views-head">
          <span className="views-badge">⏰ Check-backs</span>
          <span className="checkbacks-session">{sessionName}</span>
          <span className="views-head-spacer" />
          <button type="button" className="views-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {items === null ? (
          <p className="checkbacks-empty">Loading…</p>
        ) : failed ? (
          <p className="checkbacks-empty">Could not load check-backs.</p>
        ) : (
          <div className="checkbacks-list">
            {pending.length === 0 && <p className="checkbacks-empty">Nothing waiting on this session.</p>}
            {pending.map((c) => (
              <div key={c.id} className={"checkback-row pending" + (c.firedAt ? " fired" : "")}>
                <div className="checkback-when">{describeTrigger(c.trigger, now)}{c.force ? " · typed even mid-turn" : ""}</div>
                <div className="checkback-message">{c.message}</div>
                <div className="checkback-foot">
                  <span className="checkback-state">{describeState(c, now)} · by {c.createdBy === "agent" ? "the agent" : "you"}</span>
                  <button type="button" className="checkback-cancel" disabled={busy === c.id} onClick={() => cancel(c.id)}>Cancel</button>
                </div>
              </div>
            ))}
            {past.length > 0 && (
              <>
                <div className="checkbacks-past-head">Recent</div>
                {past.map((c) => (
                  <div key={c.id} className={"checkback-row " + c.status}>
                    <div className="checkback-when">{describeState(c, now)} · {describeTrigger(c.trigger, now)}</div>
                    <div className="checkback-message">{c.message}</div>
                  </div>
                ))}
              </>
            )}
            <p className="checkbacks-hint">Schedule one with <code>hop checkback</code> inside the session, or the agent does it itself over MCP.</p>
          </div>
        )}
      </div>
    </>
  );
};
