import { useEffect, useRef, useState } from "react";
import { relativeTime } from "../utils/switcherModel";
import { accountLine, meterNote, setupProgress, waitingLine, type Account, type AccountsOverview, type AgentKind } from "../utils/accounts";
import { RemoveAccountAsk, RemoveAccountButton } from "./AccountRemove";
import { AccountSetup } from "./AccountSetup";

// Settings → Agent accounts: every login the agents have on this machine
// (one per folder: Claude Code's and Codex's own setting, and hop's for
// Antigravity), how much of each one's limits is used — read from the
// agents' own CLIs, which costs nothing — and the rotation: a session that
// stops at its account's limit is moved to one with room and told to
// continue. Signing in, and adding accounts, happen in Sign in to accounts
// (AccountSetup); an account other than the default is removed here, or there.

type Props = {
  onNotice: (text: string) => void;
  /** (Kept for callers; sign-ins now run on the page itself.) */
  onOpenNewSession?: (name: string) => void;
  now: number;
};

const AGENTS: Array<{ kind: AgentKind; title: string }> = [
  { kind: "claude", title: "Claude Code" },
  { kind: "codex", title: "Codex" },
  { kind: "antigravity", title: "Antigravity" }
];

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) as Record<string, unknown> }))
    .catch(() => ({ ok: false, data: {} as Record<string, unknown> }));

export const AccountsSection = ({ onNotice, now }: Props) => {
  const [data, setData] = useState<AccountsOverview | null>(null);
  // Sign in to accounts, open — on an account's sign-in, an agent's new account, or the whole list.
  const [setup, setSetup] = useState<{ agent: AgentKind; dir?: string; add?: boolean } | "all" | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The account whose Remove is being asked about.
  const [removing, setRemoving] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = (refresh = false) => {
    setBusy(true);
    return fetch(`/api/accounts${refresh ? "?refresh=1" : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!alive.current) return; if (d && d.agents) { setData(d); setFailed(false); } else setFailed(true); })
      .catch(() => { if (alive.current) setFailed(true); })
      .finally(() => { if (alive.current) setBusy(false); });
  };
  // Once on opening, then every minute while the page is up (the daemon
  // keeps each reading that long, so this asks the CLIs at most that often).
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => window.clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setRotation = async (on: boolean) => {
    setData((d) => (d ? { ...d, autoSwitch: on } : d));
    const r = await post("/api/accounts/settings", { autoSwitch: on });
    if (!r.ok) onNotice("That didn't work");
    void load();
  };
  const setPooled = async (a: Account, pooled: boolean) => {
    setData((d) => (d ? { ...d, agents: { ...d.agents, [a.agent]: d.agents[a.agent].map((x) => (x.dir === a.dir ? { ...x, pooled } : x)) } } : d));
    const r = await post("/api/accounts/settings", { dir: a.dir, pooled });
    if (!r.ok) { onNotice("That didn't work"); void load(); }
  };
  const checked = data ? Math.max(0, ...Object.values(data.agents).flat().map((a) => a.usageAt || 0)) : 0;
  const waiting = data ? waitingLine(data.waiting, now) : "";
  const progress = data ? setupProgress(data.agents) : null;

  return (
    <section className="set-section" aria-labelledby="set-accounts">
      <h2 className="set-section-head" id="set-accounts">Agent accounts</h2>
      <div className="set-card">
        <div className="set-row">
          <div className="set-label">
            <span className="set-title">Keep going past a limit</span>
            <span className="set-note">
              When a session stops at its account's usage limit, hop moves it to an account with room and tells it to
              continue. With no room anywhere, it continues when a limit resets.
            </span>
            {data?.autoSwitch && waiting && <span className="set-note acct-waiting">{waiting}</span>}
          </div>
          <div className="set-control">
            <span className="set-seg" role="radiogroup" aria-label="Keep going past a limit">
              {([["off", "Off"], ["on", "On"]] as const).map(([v, text]) => {
                const on = (data?.autoSwitch ? "on" : "off") === v;
                return (
                  <button key={v} type="button" role="radio" aria-checked={on} className={on ? "on" : ""} disabled={!data}
                          onClick={() => { if (!on) void setRotation(v === "on"); }}>{text}</button>
                );
              })}
            </span>
          </div>
        </div>

        <div className="set-row">
          <div className="set-label">
            <span className="set-title">Sign in to accounts</span>
            <span className="set-note">
              Add an account for each login you have, Claude Code, Codex or Antigravity, and sign each one in once.
              {progress && progress.total > 0 ? ` ${progress.signedIn} of ${progress.total} signed in.` : ""}
            </span>
          </div>
          <div className="set-control">
            <button type="button" className="set-btn accent" onClick={() => setSetup("all")}>Sign in to accounts…</button>
          </div>
        </div>

        {!data && <div className="set-row"><span className="set-note">{failed ? "The accounts could not be read." : "Reading each account's usage…"}</span></div>}

        {data && AGENTS.map(({ kind, title }) => {
          const list = data.agents[kind] || [];
          if (!list.length && kind === "antigravity") return null;
          return (
            <div key={kind} className="set-row wide">
              <div className="set-label">
                <span className="set-title">{title}</span>
              </div>
              <div className="set-control">
                <div className="acct-list">
                  {list.map((a) => {
                    const out = a.login?.loggedIn === false;
                    return (
                      <div key={a.dir} className={"acct" + (out ? " out" : "")}>
                        <div className="acct-head">
                          <span className="acct-name" title={a.dir}>{a.isDefault ? "default" : a.label}</span>
                          <span className="acct-who">{accountLine(a)}</span>
                          <span className="acct-spacer" />
                          {a.sessions > 0 && <span className="acct-sessions">{a.sessions} {a.sessions === 1 ? "session" : "sessions"}</span>}
                          {!out && list.length > 1 && (
                            <label className="acct-pool" title="Whether a stopped session may be moved to this account">
                              <input type="checkbox" checked={a.pooled !== false} onChange={(e) => { void setPooled(a, e.target.checked); }} />
                              In rotation
                            </label>
                          )}
                          {out && <button type="button" className="set-btn" onClick={() => setSetup({ agent: a.agent, dir: a.dir })}>Sign in</button>}
                          {removing !== a.dir && <RemoveAccountButton account={a} onAsk={() => setRemoving(a.dir)} />}
                        </div>
                        {removing === a.dir && (
                          <RemoveAccountAsk account={a} onNotice={onNotice} onCancel={() => setRemoving(null)}
                                            onRemoved={() => { setRemoving(null); void load(true); }} />
                        )}
                        {!out && a.usage && a.usage.meters.length > 0 && (
                          <div className="acct-meters">
                            {a.usage.meters.map((m) => {
                              const pct = Math.min(100, Math.round(m.percent));
                              return (
                                <div key={m.id} className={"acct-meter" + (pct >= 100 ? " full" : pct >= 80 ? " high" : "")}
                                     title={m.models?.length ? m.models.join(", ") : undefined}>
                                  <span className="acct-meter-label">{m.label}</span>
                                  <span className="acct-bar" role="meter" aria-label={`${m.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                                    <span style={{ width: `${pct}%` }} />
                                  </span>
                                  <span className="acct-meter-note">{meterNote(m, now)}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {!out && (!a.usage || a.usage.meters.length === 0) && (
                          <div className="acct-none">
                            {a.usage && a.usage.available === false ? "No plan limits on this sign-in (an API key, or no subscription)." : "Its usage could not be read."}
                          </div>
                        )}
                        {!out && typeof a.usage?.resets === "number" && a.usage.resets > 0 && (
                          <div className="acct-none">{a.usage.resets} banked {a.usage.resets === 1 ? "reset" : "resets"}</div>
                        )}
                      </div>
                    );
                  })}
                  {!list.length && <div className="acct-none">Not set up on this machine.</div>}
                </div>
                <button type="button" className="set-btn quiet acct-add" onClick={() => setSetup({ agent: kind, add: true })}>Add {kind === "antigravity" ? "an" : "a"} {title} account…</button>
              </div>
            </div>
          );
        })}

        {data && data.actions.length > 0 && (
          <div className="set-row wide">
            <div className="set-label"><span className="set-title">Lately</span></div>
            <div className="set-control">
              <div className="acct-log">
                {data.actions.map((x, i) => (
                  <div key={`${x.at}-${i}`} className="acct-log-row" title={x.why || undefined}>
                    <span className="acct-log-what">
                      {x.kind === "move" ? <>Moved <b>{x.name}</b> from {x.from} to {x.to}</> : <>Told <b>{x.name}</b> to continue on {x.to}</>}
                    </span>
                    <span className="acct-log-when">{relativeTime(x.at, now)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {data && (
          <div className="set-row">
            <div className="set-label">
              <span className="set-note">
                Read from each agent's own command line; reading it uses none of the limit.
                {checked ? ` Checked ${relativeTime(checked, now)}.` : ""}
              </span>
            </div>
            <div className="set-control">
              <button type="button" className="set-btn" disabled={busy} onClick={() => { void load(true); }}>{busy ? "Reading…" : "Refresh"}</button>
            </div>
          </div>
        )}
      </div>
      {setup && (
        <AccountSetup data={data} reload={(refresh) => load(refresh)} onNotice={onNotice}
                      start={setup === "all" ? null : setup} onClose={() => { setSetup(null); void load(); }} />
      )}
    </section>
  );
};
