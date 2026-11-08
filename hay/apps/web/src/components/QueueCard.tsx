// Messages waiting for an agent's turn to end — a briefing reply, another
// agent's `hopa send`, your own ⌘⌥⏎ — held by hop and typed only when the
// turn is over (see lib/checkbacks.js `queued` in the daemon). Nothing waits
// inside the agent's input box any more, so what is pending is shown here:
// who it is from, what it says, and why it has not gone yet.
//
// A card floating at the terminal's top right — never over the input box at
// the bottom, and never taking rows from the terminal (that would resize the
// session every time something queued or went).
import { useEffect, useRef, useState } from "react";

export type QueuedMessage = {
  id: string;
  from?: string | null;
  message: string;
  createdAt?: number;
  /** Why it has not gone yet, when there is more to say than "the turn". */
  note?: string;
  /** "mixed": typing joined it in the input box, so hop left it there unsent. */
  paused?: string;
  failed?: boolean;
  sending?: boolean;
};

/** The list's `queued` field, kept only when well formed (fetchSessions copies fields one by one). */
export const normalizeQueued = (raw: unknown): QueuedMessage[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((q): q is QueuedMessage => !!q && typeof q.id === "string" && typeof q.message === "string")
    .map((q) => ({
      id: q.id, message: q.message,
      from: typeof q.from === "string" ? q.from : null,
      createdAt: Number(q.createdAt) || undefined,
      note: typeof q.note === "string" ? q.note : undefined,
      paused: typeof q.paused === "string" ? q.paused : undefined,
      failed: q.failed === true || undefined,
      sending: q.sending === true || undefined
    }));
  return out.length ? out : undefined;
};

type Props = {
  items: QueuedMessage[];
  agentLabel: string;
  onSendNow: (id: string) => Promise<void> | void;
  onEdit: (id: string, text: string) => Promise<void> | void;
  onCancel: (id: string) => Promise<void> | void;
  onRetry: (id: string) => Promise<void> | void;
  onCollapse: () => void;
};

const stateLine = (q: QueuedMessage, agentLabel: string): string => {
  if (q.sending) return "typing it now…";
  if (q.failed) return q.note || "it would not send";
  if (q.paused === "mixed") return "typing joined it in the input box, so it was not sent. Check the box.";
  return q.note || `sends when ${agentLabel}'s turn ends`;
};

export const QueueCard = ({ items, agentLabel, onSendNow, onEdit, onCancel, onRetry, onCollapse }: Props) => {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing]);
  // A message that went (or was cancelled elsewhere) leaves the editor.
  useEffect(() => { if (editing && !items.some((q) => q.id === editing)) setEditing(null); }, [items, editing]);
  const run = async (id: string, fn: () => Promise<void> | void) => {
    setBusy(id);
    try { await fn(); } finally { setBusy(null); }
  };
  return (
    <div className="queue-card" role="region" aria-label="Queued messages" onClick={(e) => e.stopPropagation()}>
      <div className="queue-head">
        <span className="queue-glyph" aria-hidden="true">⧗</span>
        <span className="queue-title">{items.length === 1 ? "1 message queued" : `${items.length} messages queued`}</span>
        <span className="queue-spacer" />
        <button type="button" className="queue-collapse" aria-label="Hide queued messages" title="Hide (the ⧗ in the bar below shows it again)" onClick={onCollapse}>–</button>
      </div>
      {items.map((q) => (
        <div key={q.id} className={"queue-row" + (q.failed || q.paused ? " trouble" : "") + (q.sending ? " sending" : "")}>
          <div className="queue-meta">
            <span className="queue-from">from {q.from || "you"}</span>
            <span className="queue-state">{stateLine(q, agentLabel)}</span>
          </div>
          {editing === q.id ? (
            <div className="queue-edit">
              <textarea ref={editRef} value={draft} rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void run(q.id, async () => { await onEdit(q.id, draft); setEditing(null); }); }
                        }} />
              <div className="queue-acts">
                <button type="button" className="queue-btn primary" disabled={!draft.trim() || busy === q.id}
                        onClick={() => void run(q.id, async () => { await onEdit(q.id, draft); setEditing(null); })}>Save</button>
                <button type="button" className="queue-btn" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <div className="queue-text" title={q.message}>{q.message}</div>
              <div className="queue-acts">
                {q.failed ? (
                  <button type="button" className="queue-btn primary" disabled={busy === q.id || q.sending}
                          onClick={() => void run(q.id, () => onRetry(q.id))}>Try again</button>
                ) : q.paused !== "mixed" && (
                  <button type="button" className="queue-btn" disabled={busy === q.id || q.sending}
                          title={`Type it now, mid-turn (${agentLabel} takes it as it would an Enter while working)`}
                          onClick={() => void run(q.id, () => onSendNow(q.id))}>Send now</button>
                )}
                {q.paused !== "mixed" && (
                  <button type="button" className="queue-btn" disabled={busy === q.id || q.sending}
                          onClick={() => { setDraft(q.message); setEditing(q.id); }}>Edit</button>
                )}
                <button type="button" className="queue-btn" disabled={busy === q.id || q.sending}
                        aria-label={q.paused === "mixed" ? "Dismiss" : "Cancel this message"}
                        onClick={() => void run(q.id, () => onCancel(q.id))}>{q.paused === "mixed" ? "Dismiss" : "Cancel"}</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
};
