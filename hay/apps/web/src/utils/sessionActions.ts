import type { AgentHome } from "./switcherModel";

// What can be done to a session, for every menu that offers it (the wall's
// tile sheet, the sidebar's right-click). One implementation, so the two can
// never disagree about an endpoint, a confirmation or a sentence.

export type ActionTarget = {
  name: string;
  displayName?: string;
  internalName?: string;
  parked?: boolean;
  createdBy?: "user" | "agent";
  agentPermitted?: boolean;
};
export type ActionContext = { notice: (text: string) => void; refresh: () => void };

const keyOf = (s: ActionTarget) => s.internalName || s.name;
const labelOf = (s: ActionTarget) => s.displayName || s.name;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

/** The agent CLIs a conversation can be continued in, in menu order. */
export const AGENT_TARGETS = ["claude", "codex", "antigravity"] as const;
export type AgentTarget = typeof AGENT_TARGETS[number];
export const agentName = (a: AgentTarget) => (a === "codex" ? "Codex" : a === "antigravity" ? "Antigravity" : "Claude");

/** Fork (same tool) or hand off (target names a tool). The result says what came of it; null on failure. */
export const forkSession = async ({ notice, refresh }: ActionContext, s: ActionTarget, target?: AgentTarget) => {
  notice(target ? `Condensing for ${agentName(target)}…` : "Forking…");
  try {
    const res = await post("/api/sessions/fork", { internalName: keyOf(s), ...(target ? { target, condense: true } : {}) });
    const data = await res.json().catch(() => ({} as { error?: string; name?: string; internalName?: string; kind?: string; extract?: { turns?: number; bytes?: number } }));
    if (!res.ok) { notice(data.error || (target ? "Handoff failed" : "Fork failed")); return null; }
    if (data.kind === "handoff") {
      const kb = Math.max(1, Math.round((data.extract?.bytes || 0) / 1024));
      notice(`${data.name} — ${data.extract?.turns ?? "?"} turns handed off (${kb} KB); it reads them first`);
    } else {
      notice(
        data.kind === "claude" ? `Forked conversation → ${data.name}`
          : data.kind === "codex" ? `${data.name} opened — resuming the conversation`
          : `Forked → ${data.name} (new shell, same directory)`
      );
    }
    refresh();
    return data as { name?: string; internalName?: string };
  } catch {
    notice(target ? "Handoff failed" : "Fork failed");
    return null;
  }
};

export const switchAccount = async ({ notice, refresh }: ActionContext, s: ActionTarget, home: AgentHome) => {
  if (home.login && !home.login.loggedIn && !window.confirm(`The ${home.label} account is logged out. Switch anyway? You will need to run /login in the session.`)) return;
  notice(`Moving ${labelOf(s)} to the ${home.label} account…`);
  try {
    const res = await post("/api/sessions/agent-home", { name: keyOf(s), home: home.dir });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; restarted?: boolean } | null;
    if (!res.ok || !data?.ok) { notice(data?.error || `Switch failed (${res.status})`); return; }
    notice(data.restarted ? `${labelOf(s)} now runs as ${home.label}` : `${labelOf(s)} is set to ${home.label}; it switches on its next start`);
    refresh();
  } catch {
    notice("Switch failed");
  }
};

// Back to the agent's desktop app on the Mac: Codex lets one process write a
// thread, and the Claude app adopts the CLI transcript in place — either way
// this session's agent stops first (Stop & park, resumable).
export const handOffToApp = async ({ notice, refresh }: ActionContext, s: ActionTarget, app: "codex" | "claude") => {
  const name = labelOf(s);
  const label = app === "codex" ? "Codex app" : "Claude app";
  if (!window.confirm(`Stop ${name} here and open it in the ${label} on the Mac?\n\nIt is parked, and opening it in hop again picks it back up.`)) return;
  try {
    const res = await post(`/api/${app}/open-in-app`, { internalName: keyOf(s), handOff: true }, { "x-hop-actor": "user" });
    const data = await res.json().catch(() => ({} as { error?: string }));
    notice(res.ok ? `${name} handed to the ${label}` : (data.error || `Could not open the ${label}`));
    if (res.ok) refresh();
  } catch {
    notice(`Could not open the ${label}`);
  }
};

// The reverse: the Codex app keeps a thread for hours after its window
// closes, and while it does the CLI here cannot resume it. The only way to
// make it let go is to quit the app; then this session relaunches on it.
export const takeFromCodexApp = async ({ notice, refresh }: ActionContext, s: ActionTarget) => {
  const name = labelOf(s);
  if (!window.confirm(`Take ${name}'s conversation back from the Codex app?\n\nThis quits the Codex app (all its windows; it reopens normally) and pauses any app automation in this conversation, then resumes it here if its codex has exited (a running codex is left alone).`)) return;
  notice(`Taking ${name} back from the Codex app…`);
  try {
    const res = await post("/api/codex/take", { internalName: keyOf(s) }, { "x-hop-actor": "user" });
    const data = await res.json().catch(() => ({})) as { error?: string; freed?: boolean; paused?: string[]; restarted?: boolean; skipped?: string | null };
    if (!res.ok) { notice(data.error || "Could not take the conversation back"); return; }
    const paused = data.paused?.length ? ` (paused app automation ${data.paused.map((a) => `“${a}”`).join(", ")})` : "";
    // A codex still running in the session is left alone: retry there.
    notice(data.restarted
      ? `${name} resumed here${data.freed ? " — the Codex app let go" : ""}${paused}`
      : data.freed
        ? `The Codex app let go of ${name}'s conversation${paused} — retry in the session`
        : `The Codex app was not holding ${name}'s conversation — nothing changed`);
    refresh();
  } catch {
    notice("Could not take the conversation back");
  }
};

/** True when the rename is done (or there was nothing to do); false keeps the editor open. */
export const renameSession = async ({ notice, refresh }: ActionContext, s: ActionTarget, nextName: string): Promise<boolean> => {
  const next = nextName.trim();
  const oldName = labelOf(s);
  if (!next || next === oldName) return true;
  if (!/^[a-zA-Z0-9_-]+$/.test(next)) { notice("Only letters, numbers, - and _ allowed"); return false; }
  try {
    // Address by internal name: display names can collide, and then renaming
    // by display name picks an arbitrary one of the two.
    const res = await post("/api/sessions/rename", { oldName, newName: next, internalName: keyOf(s) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({} as { error?: string }));
      notice(data.error || "Rename failed");
      return false;
    }
    notice(`Renamed to ${next}`);
    refresh();
    return true;
  } catch {
    notice("Rename failed");
    return false;
  }
};

const simple = async ({ notice, refresh }: ActionContext, path: string, body: unknown, done: string, failed: string) => {
  try {
    const res = await post(path, body);
    if (!res.ok) { notice(failed); return false; }
    notice(done);
    refresh();
    return true;
  } catch {
    notice(failed);
    return false;
  }
};

export const toggleAgentAccess = (ctx: ActionContext, s: ActionTarget) => {
  const allowed = s.agentPermitted !== true;
  return simple(ctx, "/api/sessions/agent-permission", { internalName: keyOf(s), allowed },
    allowed ? "Agent access enabled" : "Agent access disabled", "Failed to update agent access");
};

// Reclassify origin (user <-> agent): adopting an agent-spawned session you
// now drive yourself moves it to the user side of the origin filter — and
// into default restore.
export const toggleOrigin = (ctx: ActionContext, s: ActionTarget) => {
  const next = s.createdBy === "agent" ? "user" : "agent";
  return simple(ctx, "/api/sessions/origin", { internalName: keyOf(s), createdBy: next },
    next === "user" ? "Moved to user sessions" : "Moved to agent sessions", "Failed to change session origin");
};

export const togglePark = (ctx: ActionContext, s: ActionTarget) => {
  const next = s.parked !== true;
  return simple(ctx, "/api/sessions/park", { internalName: keyOf(s), parked: next },
    next ? "Parked — find it under “parked” at the bottom" : "Back on the wall", "Failed to update park state");
};

// Stop the process but stay resumable: the daemon pre-writes the resume
// command into the session's startup, so reopening it picks the conversation
// back up.
export const stopAndPark = async ({ notice, refresh }: ActionContext, s: ActionTarget) => {
  try {
    const res = await post("/api/sessions/archive", { internalName: keyOf(s) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({} as { error?: string }));
      notice(data.error || "Failed to stop session");
      return;
    }
    notice("Stopped & parked — opening it later resumes the conversation");
    refresh();
  } catch {
    notice("Failed to stop session");
  }
};

export const killSession = async ({ notice, refresh }: ActionContext, s: ActionTarget) => {
  const label = labelOf(s);
  if (!window.confirm(`Kill session "${label}" for all participants? Its running process is terminated — "Recently closed" in the sidebar can bring it back.`)) return false;
  try {
    const res = await post("/api/sessions/delete", { internalName: keyOf(s) });
    if (!res.ok) { notice("Failed to kill session"); return false; }
    notice(`Killed ${label} — Recently closed can bring it back`);
    refresh();
    return true;
  } catch {
    notice("Failed to kill session");
    return false;
  }
};

export const moveToFolder = (ctx: ActionContext, s: ActionTarget, folderId: string | null, folderName: string) =>
  simple(ctx, "/api/sessions/move", { internalName: keyOf(s), folderId },
    folderId ? `Filed under ${folderName}` : "Moved out of its folder", "Could not move session");

/** The created folder (the daemon mints the id), or null. */
export const createFolder = async ({ notice, refresh }: ActionContext, name: string): Promise<{ id: string; name: string } | null> => {
  try {
    const res = await post("/api/folders", { name });
    const data = await res.json().catch(() => ({} as { error?: string; folder?: { id?: string; name?: string } }));
    if (!res.ok || !data.folder?.id) { notice(data.error || "Could not create folder"); return null; }
    refresh();
    return { id: data.folder.id, name: data.folder.name || name };
  } catch {
    notice("Could not create folder");
    return null;
  }
};

export const renameFolder = (ctx: ActionContext, id: string, name: string) =>
  simple(ctx, "/api/folders/rename", { id, name }, `Renamed to ${name}`, "Could not rename folder");

export const deleteFolder = (ctx: ActionContext, id: string, name: string) => {
  // Deleting a folder releases its sessions; it never kills them, so this
  // needs no scarier confirmation than the sentence itself.
  if (!window.confirm(`Delete folder "${name}"? Its sessions move back to unfiled.`)) return Promise.resolve(false);
  return simple(ctx, "/api/folders/delete", { id }, `Deleted ${name}`, "Could not delete folder");
};
