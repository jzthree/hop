import { Fragment, useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { RemoveAccountAsk, RemoveAccountButton } from "./AccountRemove";
import { notifyAccountsChanged } from "../utils/accountsChanged";
import {
  AGENT_TITLE, accountFolder, accountLine, accountSlug, sameLogins, setupProgress, signInStatus,
  type Account, type AccountsOverview, type AgentKind, type SignInJob
} from "../utils/accounts";

// Sign in to accounts: the place to put every agent login on this host in
// order, one after another. Each account is a folder of its own (Claude
// Code's and Codex's own setting; for Antigravity, hop's — see
// lib/agy-accounts.js). Signing in runs the agent's own sign-in on the host;
// this page shows its link (open it, or copy it into a private window when
// the browser is signed in to someone else), takes the code a sign-in page
// may hand back, and says who the account turned out to be — and when it is
// a login another folder already has.
//
// The sign-in's steps open under the account being signed in, in view, and
// the code box is where the cursor is when the person comes back from the
// sign-in page (a paste anywhere on the sheet lands in it too): Antigravity's
// Google page always hands back a code, and nothing else said where it goes.

type Props = {
  data: AccountsOverview | null;
  /** Read the accounts again (after a sign-in or an added folder). */
  reload: (refresh?: boolean) => Promise<void> | void;
  onClose: () => void;
  onNotice: (text: string) => void;
  /** Open on this: sign an account in, or add one for an agent. */
  start?: { agent: AgentKind; dir?: string; add?: boolean } | null;
};

const ORDER: AgentKind[] = ["claude", "codex", "antigravity"];

// How each agent's sign-in goes, said once above its accounts.
const HOW: Record<AgentKind, string> = {
  claude: "Signs in through claude.ai. If the page hands you a code, paste it below.",
  codex: "Signs in through ChatGPT and finishes in a browser on the Mac running hop.",
  antigravity: "Signs in with Google, whose page then shows a code to paste here."
};

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) as Record<string, unknown> }))
    .catch(() => ({ ok: false, status: 0, data: {} as Record<string, unknown> }));

const copyText = async (text: string): Promise<boolean> => {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
};

export const AccountSetup = ({ data, reload, onClose, onNotice, start }: Props) => {
  const [job, setJob] = useState<SignInJob | null>(null);
  const [adding, setAdding] = useState<AgentKind | null>(start?.add ? start.agent : null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // The account whose Remove is being asked about.
  const [removing, setRemoving] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const alive = useRef(true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  // A sign-in already running on the host (from another browser, or before a reload).
  const fetchJob = () => fetch("/api/accounts/signin", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (alive.current && d) setJob(d.job || null); })
    .catch(() => { /* the next poll tries again */ });
  useEffect(() => { void fetchJob(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // While one runs, follow it; when it ends, read the accounts again.
  const running = job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => { void fetchJob(); }, 1500);
    return () => window.clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastState = useRef<string | null>(null);
  useEffect(() => {
    const s = job ? `${job.id}:${job.state}` : null;
    if (lastState.current && s !== lastState.current && job && job.state !== "running") { void reload(true); notifyAccountsChanged(); }
    lastState.current = s;
  }, [job]); // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = async (agent: AgentKind, dir: string, withEmail?: string) => {
    setBusy(true);
    setCode(""); setCopied(false);
    const r = await post("/api/accounts/signin", { agent, dir, email: withEmail || undefined });
    setBusy(false);
    const made = r.data.job as SignInJob | undefined;
    if (made) setJob(made);
    if (!r.ok) onNotice(typeof r.data.error === "string" ? r.data.error : "Could not start the sign-in");
  };
  // Opened on an account's Sign in: start it straight away.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !start?.dir || start.add) return;
    started.current = true;
    void signIn(start.agent, start.dir);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addAccount = async (agent: AgentKind) => {
    const slug = accountSlug(name);
    if (!slug) { onNotice("A short name is needed: letters, digits, - or _"); return; }
    setBusy(true);
    const r = await post("/api/accounts/add", { agent, name: slug });
    setBusy(false);
    const home = r.data.home as { dir?: string } | undefined;
    if (!r.ok || !home?.dir) { onNotice(typeof r.data.error === "string" ? r.data.error : "Could not add the account"); return; }
    const mail = agent === "claude" ? email.trim() : "";
    setAdding(null); setName(""); setEmail("");
    await reload();
    notifyAccountsChanged();
    void signIn(agent, home.dir, mail);
  };

  const sendCode = async () => {
    if (!job || !code.trim()) return;
    const r = await post("/api/accounts/signin/input", { id: job.id, text: code.trim() });
    if (r.ok) { setCode(""); if (r.data.job) setJob(r.data.job as SignInJob); }
    else onNotice(typeof r.data.error === "string" ? r.data.error : "That didn't go through");
  };
  const cancel = async () => {
    if (!job) return;
    const r = await post("/api/accounts/signin/cancel", { id: job.id });
    if (r.data.job) setJob(r.data.job as SignInJob);
  };

  const agents = data?.agents;
  const progress = agents ? setupProgress(agents) : null;
  const signingIn = (a: Account) => running && job?.dir === a.dir;
  // The sign-in goes under its account's row; on top only when that row is not listed.
  const jobRowShown = !!job && !!agents?.[job.agent]?.some((a) => a.dir === job.dir);
  const card = job && (
    <SignInCard job={job} code={code} setCode={setCode} copied={copied} codeRef={codeRef}
                onCopy={async () => { if (job.url && await copyText(job.url)) { setCopied(true); window.setTimeout(() => setCopied(false), 2000); } else onNotice("Could not copy — select the link instead"); }}
                onSend={() => { void sendCode(); }} onCancel={() => { void cancel(); }}
                onAgain={() => { void signIn(job.agent, job.dir); }} onDismiss={() => setJob(null)} />
  );
  // A code pasted anywhere on the sheet (not into another box) is the code.
  const onPaste = (e: React.ClipboardEvent) => {
    if (!job || job.state !== "running" || !codeStepFor(job) || !codeRef.current) return;
    const t = e.target as HTMLElement;
    if (t === codeRef.current || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const text = e.clipboardData.getData("text").trim();
    if (!text) return;
    e.preventDefault();
    setCode(text);
    codeRef.current.focus({ preventScroll: true });
  };

  // On the document itself: inside Settings, whose page makes its own frame
  // for fixed boxes, the sheet centred in that page and its left side went
  // under the sidebar.
  return createPortal(
    <>
      <div className="acct-setup-backdrop" onClick={onClose} />
      <div className="acct-setup" role="dialog" aria-modal="true" aria-labelledby="acct-setup-title" tabIndex={-1} ref={rootRef}
           onPaste={onPaste}
           onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <header className="acct-setup-head">
          <div>
            <h2 id="acct-setup-title">Sign in to your accounts</h2>
            <p>
              Each account gets its own folder. Sign each one in once: hop keeps them apart, shows how much of
              each one's limits is used, and can move a session that runs out to an account with room.
            </p>
          </div>
          <div className="acct-setup-head-side">
            {progress && progress.total > 0 && (
              <span className="acct-setup-progress" aria-label={`${progress.signedIn} of ${progress.total} accounts signed in`}>
                <b>{progress.signedIn}</b> of {progress.total} signed in
              </span>
            )}
            <button type="button" className="set-btn quiet" onClick={onClose} aria-label="Close">Done</button>
          </div>
        </header>

        {job && !jobRowShown && card}

        {!agents && <p className="acct-setup-empty">Reading the accounts on this host…</p>}

        {agents && ORDER.map((agent) => {
          const list = agents[agent] || [];
          const dupes = sameLogins(list);
          return (
            <section key={agent} className="acct-setup-agent" aria-labelledby={`acct-setup-${agent}`}>
              <div className="acct-setup-agent-head">
                <h3 id={`acct-setup-${agent}`}>{AGENT_TITLE[agent]}</h3>
                <span>{HOW[agent]}</span>
              </div>
              <ul className="acct-setup-list">
                {list.map((a) => {
                  const out = a.login?.loggedIn === false;
                  const unknown = !a.login;
                  const dupe = dupes.get(a.dir);
                  const state = signingIn(a) ? "busy" : out ? "out" : dupe ? "dupe" : unknown ? "unknown" : "in";
                  return (
                    <Fragment key={a.dir}>
                      <li className={`acct-setup-row ${state}`}>
                        <span className="acct-setup-mark" aria-hidden="true" />
                        <span className="acct-setup-name">
                          <b>{a.isDefault ? "default" : a.label}</b>
                          <code title={a.dir}>{a.dir.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~")}</code>
                        </span>
                        <span className="acct-setup-who">
                          {state === "busy" ? "Signing in…"
                            : out ? "Not signed in"
                            : dupe ? `${accountLine(a)} — same login as ${dupe}`
                            : unknown ? "Not checked yet"
                            : accountLine(a) || "Signed in"}
                        </span>
                        {!signingIn(a) && removing !== a.dir && (
                          <span className="acct-setup-acts">
                            <button type="button" className={"set-btn" + (out || dupe ? " accent" : " quiet")} disabled={busy || running}
                                    onClick={() => { void signIn(agent, a.dir); }}>
                              {out ? "Sign in" : dupe ? "Sign in as someone else" : "Sign in again"}
                            </button>
                            <RemoveAccountButton account={a} disabled={busy || running} onAsk={() => setRemoving(a.dir)} />
                          </span>
                        )}
                        {removing === a.dir && (
                          <RemoveAccountAsk account={a} onNotice={onNotice} onCancel={() => setRemoving(null)}
                                            onRemoved={() => { setRemoving(null); void reload(true); }} />
                        )}
                      </li>
                      {job && job.dir === a.dir && <li className="acct-setup-signin">{card}</li>}
                    </Fragment>
                  );
                })}
                {!list.length && <li className="acct-setup-row none">{agent === "antigravity" ? "Antigravity (agy) has not run on this host." : "None on this host yet."}</li>}
              </ul>
              {adding === agent ? (
                <form className="acct-setup-add" onSubmit={(e) => { e.preventDefault(); void addAccount(agent); }}>
                  <label>
                    <span>Name</span>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="work, lab, personal…" maxLength={40}
                           aria-describedby={`acct-setup-folder-${agent}`} />
                  </label>
                  {agent === "claude" && (
                    <label>
                      <span>Email (optional)</span>
                      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="fills in the sign-in page" />
                    </label>
                  )}
                  <span className="acct-setup-folder" id={`acct-setup-folder-${agent}`}>
                    {accountSlug(name) ? <>Folder <code>{accountFolder(agent, accountSlug(name))}</code></> : " "}
                  </span>
                  <div className="acct-setup-add-actions">
                    <button type="submit" className="set-btn accent" disabled={busy || running || !accountSlug(name)}>Add and sign in</button>
                    <button type="button" className="set-btn quiet" onClick={() => { setAdding(null); setName(""); setEmail(""); }}>Cancel</button>
                  </div>
                </form>
              ) : (
                <button type="button" className="set-btn quiet acct-setup-addbtn" disabled={running || (agent === "antigravity" && !list.length)}
                        onClick={() => { setAdding(agent); setName(""); setEmail(""); }}>
                  + Add {agent === "antigravity" ? "an" : "a"} {AGENT_TITLE[agent]} account
                </button>
              )}
            </section>
          );
        })}

        <footer className="acct-setup-foot">
          A sign-in page uses whichever account your browser is signed in to. For a different one, copy the link into a
          private window, or another browser profile.
          {" "}Antigravity accounts beyond the default run sandboxed: agy cannot reach the macOS keychain there, so it
          keeps that login in the account's folder.
        </footer>
      </div>
    </>,
    document.body
  );
};

type CardProps = {
  job: SignInJob; code: string; setCode: (s: string) => void; copied: boolean;
  codeRef: MutableRefObject<HTMLInputElement | null>;
  onCopy: () => void; onSend: () => void; onCancel: () => void; onAgain: () => void; onDismiss: () => void;
};

/** Whether this sign-in may hand back a code: Codex finishes in the browser on this Mac; the others can hand one back. */
const codeStepFor = (job: SignInJob) => job.agent !== "codex" || job.wantsCode;

// Where the code goes, said for each agent.
const CODE_STEP: Record<AgentKind, { title: string; note: string }> = {
  antigravity: {
    title: "Copy the code Google shows, and paste it here",
    note: "After you choose your Google account, the page shows an authorization code. Antigravity is waiting for it."
  },
  claude: {
    title: "If the page shows a code, paste it here",
    note: "It does when the page cannot reach this Mac, as when you sign in on a phone."
  },
  codex: { title: "Paste the code it asks for", note: "" }
};

const SignInCard = ({ job, code, setCode, copied, codeRef, onCopy, onSend, onCancel, onAgain, onDismiss }: CardProps) => {
  const running = job.state === "running";
  const codeStep = codeStepFor(job);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Back from the sign-in page, or asked for the code: this is where to type.
  const [lookHere, setLookHere] = useState(false);
  const codeNow = running && codeStep && (job.agent === "antigravity" ? job.wantsCode || lookHere : lookHere);

  // A new sign-in: in view, under its account.
  useEffect(() => { cardRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }, [job.id]);

  const focusCode = () => {
    const el = codeRef.current;
    if (!el) return;
    const active = document.activeElement as HTMLElement | null;
    // Not from a box someone is typing in.
    if (active && active !== el && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  };
  // Antigravity asks for its code once the page is out: the cursor goes there.
  useEffect(() => { if (running && job.wantsCode && job.agent === "antigravity") focusCode(); }, [running, job.wantsCode, job.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  // Coming back to hop from the sign-in page (a tab, the browser): the box, lit.
  useEffect(() => {
    if (!running || !codeStep || !job.url) return;
    let away = document.hidden || !document.hasFocus();
    const leave = () => { away = true; };
    const back = () => {
      if (document.hidden || !away) return;
      away = false;
      setLookHere(true);
      focusCode();
    };
    const vis = () => (document.hidden ? leave() : back());
    window.addEventListener("blur", leave);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [running, codeStep, job.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = CODE_STEP[job.agent];
  return (
    <div ref={cardRef} className={`acct-signin ${job.state}${job.duplicateOf ? " dupe" : ""}`} aria-live="polite">
      <div className="acct-signin-head">
        <span className="acct-signin-title">{AGENT_TITLE[job.agent]} · {job.label}</span>
        <span className="acct-signin-state">{signInStatus(job)}</span>
      </div>
      {running && (
        <ol className="acct-signin-steps">
          <li className={job.url ? "" : "waiting"}>
            <span className="acct-signin-step-title">Open the sign-in page</span>
            {job.url ? (
              <span className="acct-signin-actions">
                <a className="set-btn accent" href={job.url} target="_blank" rel="noreferrer"
                   onClick={() => { if (codeStep) window.setTimeout(() => codeRef.current?.focus({ preventScroll: true }), 0); }}>Open sign-in page</a>
                <button type="button" className="set-btn" onClick={onCopy}>{copied ? "Copied" : "Copy link"}</button>
              </span>
            ) : <span className="set-note">Waiting for the sign-in link…</span>}
            {job.url && <span className="set-note">A browser tab may have opened on the host already.</span>}
          </li>
          {codeStep && (
            <li className={codeNow ? "now" : ""}>
              <span className="acct-signin-step-title">{step.title}</span>
              {step.note && <span className="set-note">{step.note}</span>}
              <form className="acct-signin-code" onSubmit={(e) => { e.preventDefault(); onSend(); }}>
                <input ref={codeRef} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code here"
                       autoComplete="off" autoCapitalize="off" spellCheck={false} aria-label="Code from the sign-in page" />
                <button type="submit" className={"set-btn" + (code.trim() ? " accent" : "")} disabled={!code.trim()}>Send</button>
              </form>
            </li>
          )}
        </ol>
      )}
      {job.state === "done" && job.duplicateOf && (
        <p className="acct-signin-warn">
          This folder now holds the same login as <b>{job.duplicateOf}</b>, so it adds no room. Sign it in again with a different
          account — a private window keeps the browser from reusing the one it knows.
        </p>
      )}
      {job.lines.length > 0 && (
        <details className="acct-signin-log">
          <summary>What the sign-in says</summary>
          <pre>{job.lines.join("\n")}</pre>
        </details>
      )}
      <div className="acct-signin-foot">
        {running && <button type="button" className="set-btn quiet danger" onClick={onCancel}>Cancel</button>}
        {!running && (job.state !== "done" || job.duplicateOf) && <button type="button" className="set-btn" onClick={onAgain}>Try again</button>}
        {!running && <button type="button" className="set-btn quiet" onClick={onDismiss}>Close</button>}
      </div>
    </div>
  );
};
