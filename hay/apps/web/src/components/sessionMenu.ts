import type { MenuItem } from "./ContextMenu";
import * as actions from "../utils/sessionActions";
import type { AgentHomes } from "../utils/switcherModel";
import { describeAccount } from "../utils/switcherModel";

// The sidebar's right-click on a session: everything the wall's tile sheet
// offers, in the same words (utils/sessionActions.ts does the work), plus what
// a sidebar is for — the session's other views, a new tab, its path to copy.

export type MenuSession = actions.ActionTarget & {
  type?: "terminal" | "port";
  active?: boolean;
  archived?: boolean;
  folderId?: string | null;
  cwd?: string;
  agent?: "claude" | "codex" | "antigravity" | null;
  agentHome?: { dir: string; label: string; isDefault: boolean } | null;
  views?: { count?: number } | null;
  checkbacks?: number;
};
export type SessionPlace = "views" | "briefing" | "pulse" | "calendar";

export type SessionMenuDeps = {
  ctx: actions.ActionContext;
  folders: Array<{ id: string; name: string }>;
  homes: AgentHomes;
  isCurrent: (s: MenuSession) => boolean;
  onOpen: (s: MenuSession) => void;
  onStartRename: (s: MenuSession) => void;
  /** A session's other views; absent where they cannot open (no sidebar). */
  onOpenPlace?: (s: MenuSession, place: SessionPlace) => void;
};

/** "~/Code/hop" from a home-rooted path. */
export const shortPath = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^\/root(?=\/|$)/, "~");
const linkTo = (s: MenuSession) => `${window.location.origin}/s/${encodeURIComponent(s.displayName || s.name)}/`;

export const copyText = (ctx: actions.ActionContext, what: string, text: string) => {
  const done = navigator.clipboard?.writeText(text);
  if (!done) { ctx.notice("The browser would not copy here"); return; }
  done.then(() => ctx.notice(`Copied ${what}`)).catch(() => ctx.notice("The browser would not copy here"));
};

export const newFolderThen = async (ctx: actions.ActionContext, then?: (f: { id: string; name: string }) => void) => {
  const name = window.prompt("Folder name")?.trim();
  if (!name) return;
  const made = await actions.createFolder(ctx, name);
  if (made) { if (then) then(made); else ctx.notice(`Created ${name}`); }
};

export const sessionMenuItems = (s: MenuSession, d: SessionMenuDeps): MenuItem[] => {
  const { ctx, folders, homes, isCurrent, onOpen, onStartRename, onOpenPlace } = d;
  const terminal = s.type !== "port";
  const name = s.displayName || s.name;
  const current = s.folderId || null;
  const file = (id: string | null, label: string) => { if (id !== current) void actions.moveToFolder(ctx, s, id, label); };
  const accounts = s.agent === "claude" || s.agent === "codex" ? homes[s.agent] || [] : [];
  const sep: MenuItem = { kind: "separator" };
  const items: MenuItem[] = [];
  if (!isCurrent(s)) items.push({ label: "Open full screen", onSelect: () => onOpen(s) });
  items.push({ label: "Open in new tab", onSelect: () => { window.open(linkTo(s), "_blank", "noopener"); } });
  if (onOpenPlace && terminal) {
    items.push({ label: "Show", items: [
      { label: `Views${s.views?.count ? ` (${s.views.count})` : ""}`, onSelect: () => onOpenPlace(s, "views") },
      { label: "Briefing", onSelect: () => onOpenPlace(s, "briefing") },
      { label: "Pulse", onSelect: () => onOpenPlace(s, "pulse") },
      { label: `Calendar${s.checkbacks ? ` (${s.checkbacks})` : ""}`, onSelect: () => onOpenPlace(s, "calendar") }
    ] });
  }
  items.push(sep);
  items.push({ label: "Rename", onSelect: () => onStartRename(s) });
  items.push({ label: "Move to folder", items: [
    { label: "No folder", checked: current === null, onSelect: () => file(null, "") },
    ...folders.map((f): MenuItem => ({ label: f.name, checked: current === f.id, onSelect: () => file(f.id, f.name) })),
    sep,
    { label: "New folder…", onSelect: () => { void newFolderThen(ctx, (f) => file(f.id, f.name)); } }
  ] });
  items.push({ label: "Copy", items: [
    { label: "Name", onSelect: () => copyText(ctx, "the name", name) },
    ...(s.cwd ? [{ label: "Folder path", onSelect: () => copyText(ctx, "the path", s.cwd!) }] : []),
    { label: "Link", onSelect: () => copyText(ctx, "the link", linkTo(s)) },
    ...(terminal ? [{ label: "Attach command", onSelect: () => copyText(ctx, "the command", `hop attach ${name}`) }] : [])
  ] });
  items.push(sep);
  items.push({ label: "Fork session", onSelect: () => { void actions.forkSession(ctx, s); } });
  if (terminal) {
    items.push({ label: "Continue in", items: (["claude", "codex"] as const).map((target): MenuItem => ({
      label: `${s.agent === target ? "Fresh " : ""}${target === "codex" ? "Codex" : "Claude"}…`,
      onSelect: () => { void actions.forkSession(ctx, s, target); }
    })) });
    // The desktop apps hop can hand a conversation to: Claude's and Codex's.
    if (s.agent === "claude" || s.agent === "codex") {
      const agent = s.agent;
      items.push({ label: `Hand off to ${agent === "codex" ? "Codex" : "Claude"} app…`, onSelect: () => { void actions.handOffToApp(ctx, s, agent); } });
    }
    if (s.agent === "codex") items.push({ label: "Take back from Codex app…", onSelect: () => { void actions.takeFromCodexApp(ctx, s); } });
    if (accounts.length > 1) {
      items.push({ label: `Account: ${s.agentHome?.label || "default"}`, items: accounts.map((h): MenuItem => ({
        label: describeAccount(h),
        checked: s.agentHome ? s.agentHome.dir === h.dir : h.isDefault,
        onSelect: () => { if (s.agentHome?.dir !== h.dir) void actions.switchAccount(ctx, s, h); }
      })) });
    }
    const parked = !!(s.parked || s.archived);
    items.push(sep);
    items.push({ label: s.agentPermitted ? "Disable agent access" : "Enable agent access", onSelect: () => { void actions.toggleAgentAccess(ctx, s); } });
    items.push({ label: s.createdBy === "agent" ? "Move to user sessions" : "Move to agent sessions", onSelect: () => { void actions.toggleOrigin(ctx, s); } });
    items.push({ label: parked ? "Unpark session" : "Park session", onSelect: () => { void actions.togglePark(ctx, { ...s, parked }); } });
    if (s.active) items.push({ label: "Stop & park (resumable)", onSelect: () => { void actions.stopAndPark(ctx, s); } });
  }
  items.push(sep);
  items.push({ label: "Kill session", danger: true, onSelect: () => { void actions.killSession(ctx, s); } });
  return items;
};
