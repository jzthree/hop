import { useState } from "react";
import type { Account } from "../utils/accounts";

// Removing an account (Settings → Agent accounts, and the sign-in sheet):
// asked in the row itself, never in a browser dialog. The host takes it out
// of the lists and the rotation and forgets its login; the folder, with its
// conversations, is kept in hop's removed-accounts folder. The agent's own
// folder (the default account) has no Remove.

const shortPath = (dir: string) => dir.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");

/** The row's Remove…; nothing for the default account. */
export const RemoveAccountButton = ({ account: a, onAsk, disabled }: { account: Account; onAsk: () => void; disabled?: boolean }) =>
  a.isDefault ? null : (
    <button type="button" className="set-btn quiet danger acct-remove" disabled={disabled}
            aria-label={`Remove ${a.label}`} onClick={onAsk}>Remove…</button>
  );

type AskProps = {
  account: Account;
  onNotice: (text: string) => void;
  /** It went: read the accounts again. */
  onRemoved: () => void;
  onCancel: () => void;
};

/** Are you sure — or, while sessions run on it, what to do first. */
export const RemoveAccountAsk = ({ account: a, onNotice, onRemoved, onCancel }: AskProps) => {
  const [busy, setBusy] = useState(false);
  const name = a.label;
  const inUse = a.sessions > 0;
  const one = a.sessions === 1;

  const remove = async () => {
    setBusy(true);
    const r = await fetch("/api/accounts/remove", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: a.agent, dir: a.dir })
    }).then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => ({})) as Record<string, unknown> }))
      .catch(() => ({ ok: false, data: {} as Record<string, unknown> }));
    setBusy(false);
    if (!r.ok) { onNotice(typeof r.data.error === "string" ? r.data.error : "Could not remove it"); return; }
    onNotice(`Removed ${name}${typeof r.data.movedTo === "string" ? `. Its folder is kept in ${r.data.movedTo}` : ""}`);
    onRemoved();
  };

  return (
    <div className="acct-remove-ask" role="group" aria-label={`Remove ${name}?`}>
      {inUse ? (
        <p>
          {a.sessions} running {one ? "session uses" : "sessions use"} <b>{name}</b>. Move {one ? "it" : "them"} to another
          account, or close {one ? "it" : "them"}, before removing it.
        </p>
      ) : (
        <p>
          Remove <b>{name}</b>? It leaves hop's lists and the rotation, and this Mac forgets its sign-in. Its folder,{" "}
          <code>{shortPath(a.dir)}</code>, is kept with its conversations in hop's <code>removed-accounts</code> folder.
        </p>
      )}
      <span className="acct-remove-actions">
        {!inUse && <button type="button" className="set-btn danger" disabled={busy} onClick={() => { void remove(); }}>{busy ? "Removing…" : `Remove ${name}`}</button>}
        <button type="button" className="set-btn quiet" disabled={busy} onClick={onCancel}>{inUse ? "OK" : "Cancel"}</button>
      </span>
    </div>
  );
};
