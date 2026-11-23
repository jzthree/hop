import { describe, expect, it } from "vitest";
import { accountFolder, accountLine, accountSlug, actionText, meterNote, paidLine, planName, resetsLine, sameLogins, setupProgress, signInStatus, usageHint, waitingLine, type Account, type SignInJob, type UsageMeter } from "./accounts";

const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const at = (d: number, h: number, min = 0) => new Date(2026, 10, d, h, min, 0).getTime();
const meter = (over: Partial<UsageMeter>): UsageMeter => ({ id: "week", label: "Week", window: "week", percent: 0, resetsAt: null, ...over });
const account = (over: Partial<Account>): Account => ({
  agent: "claude", dir: "/home/u/.claude", label: "default", isDefault: true, login: { loggedIn: true, email: "a@example.org" },
  plan: "max_20x", usage: null, usageAt: null, pooled: true, sessions: 0, ...over
});

describe("the Accounts page's words", () => {
  it("names a plan and an account", () => {
    expect(planName("max_20x")).toBe("Max 20x");
    expect(planName("pro")).toBe("Pro");
    expect(planName(null)).toBe("");
    expect(accountLine(account({}))).toBe("a@example.org · Max 20x");
    expect(accountLine(account({ login: { loggedIn: false, email: null } }))).toBe("Signed out");
    expect(accountLine(account({ login: null, plan: null }))).toBe("");
  });

  it("says how full a limit is and when it resets", () => {
    expect(meterNote(meter({ percent: 41.6, resetsAt: at(18, 15, 10) }), NOW)).toMatch(/^42% · resets 3:10/);
    expect(meterNote(meter({ percent: 100, resetsAt: at(20, 16) }), NOW)).toMatch(/^100% · resets \w{3} 4:00/);
    expect(meterNote(meter({ percent: 76, resetsAt: at(30, 16) }), NOW)).toMatch(/^76% · resets Nov 30$/);
    expect(meterNote(meter({ percent: 130 }), NOW)).toBe("100%");
    expect(meterNote(meter({ idle: true }), NOW)).toBe("not started");
    expect(meterNote(meter({ percent: 100, resetsAt: NOW - 1000 }), NOW)).toBe("0% · reset");
  });

  it("says what the rotation is waiting for", () => {
    expect(waitingLine([], NOW)).toBe("");
    const one = { session: "s_1", name: "angler", agent: "claude", reason: "no room", until: at(18, 15) };
    expect(waitingLine([one], NOW)).toMatch(/^angler is stopped at a limit with no account to move to — the first limit resets 3:00/);
    expect(waitingLine([one, { ...one, session: "s_2", until: null }], NOW)).toMatch(/^2 sessions are stopped/);
    expect(waitingLine([{ ...one, until: null }], NOW)).toBe("angler is stopped at a limit with no account to move to.");
  });

  it("puts a short usage reading beside an account in a menu", () => {
    const usage = { meters: [
      meter({ id: "session", label: "5-hour", percent: 0, idle: true }),
      meter({ percent: 76, resetsAt: at(22, 16) }),
      meter({ id: "week:Fable", label: "Fable week", percent: 100, resetsAt: at(22, 16), model: "Fable" }),
      meter({ id: "week:Opus", label: "Opus week", percent: 20, resetsAt: at(22, 16), model: "Opus" })
    ] };
    expect(usageHint(usage, NOW)).toBe("Week 76% · Fable week 100%");
    expect(usageHint(null, NOW)).toBe("");
    expect(usageHint({ meters: [meter({ percent: 90, resetsAt: NOW - 5 })] }, NOW)).toBe("");
  });
});

describe("signing accounts in", () => {
  const job = (over: Partial<SignInJob>): SignInJob => ({
    id: "j", agent: "codex", dir: "/home/u/.codex_work", label: "work", startedAt: NOW, state: "running",
    url: null, wantsCode: false, lines: [], email: null, duplicateOf: null, message: null, endedAt: null, ...over
  });
  it("says where a sign-in stands", () => {
    expect(signInStatus(job({}))).toBe("Starting the sign-in…");
    expect(signInStatus(job({ url: "https://auth.openai.com/oauth/authorize?x" }))).toBe("Waiting for you to finish in the browser");
    expect(signInStatus(job({ url: "https://x", wantsCode: true }))).toBe("Paste the code the sign-in page shows below");
    expect(signInStatus(job({ agent: "antigravity", url: "https://x", wantsCode: true }))).toBe("Waiting for the code Google shows: paste it below");
    expect(signInStatus(job({ agent: "claude", url: "https://x", wantsCode: true }))).toBe("Finish in the browser, or paste the code the page shows below");
    expect(signInStatus(job({ state: "done", email: "b@example.org" }))).toBe("Signed in as b@example.org");
    expect(signInStatus(job({ state: "done", email: "a@example.org", duplicateOf: "default" }))).toBe("Signed in as a@example.org — the same login as default");
    expect(signInStatus(job({ state: "failed", message: "codex login stopped (exit 1)" }))).toBe("codex login stopped (exit 1)");
    expect(signInStatus(job({ state: "cancelled" }))).toBe("Cancelled");
  });
  it("counts what is signed in, and spots one login in two folders", () => {
    const a = account({});
    const b = account({ dir: "/home/u/.claude_work", label: "work", isDefault: false, login: { loggedIn: true, email: "A@example.org" } });
    const c = account({ dir: "/home/u/.claude_x", label: "x", isDefault: false, login: { loggedIn: false, email: null } });
    const d = account({ dir: "/home/u/.claude_y", label: "y", isDefault: false, login: null });
    expect(setupProgress({ claude: [a, b, c, d], codex: [] })).toEqual({ signedIn: 2, total: 4 });
    expect(Array.from(sameLogins([a, b, c, d]).entries())).toEqual([["/home/u/.claude_work", "default"]]);
  });
  it("names a new account's folder as the host will", () => {
    expect(accountSlug("  Work 2 ")).toBe("work-2");
    expect(accountSlug("default")).toBe("");
    expect(accountSlug("!!!")).toBe("");
    expect(accountFolder("antigravity", "work")).toBe("~/.gemini_work");
    expect(accountFolder("codex", "lab")).toBe("~/.codex_lab");
  });
});

describe("banked resets, paid credits and the rotation's log", () => {
  const now = Date.parse("2026-11-22T18:00:00");
  const day = 86400_000;
  const week = (percent: number) => ({ id: "codex:10080", label: "Week", window: "week", percent, resetsAt: now + 2 * day });
  it("says how many resets are banked and when the first expires", () => {
    expect(resetsLine({ meters: [], resets: 3, resetsExpire: [now + 8 * day, now + 9 * day] }, now)).toMatch(/^3 banked resets · the first expires /);
    expect(resetsLine({ meters: [], resets: 1, resetsExpire: null }, now)).toBe("1 banked reset");
    expect(resetsLine({ meters: [], resets: 0 }, now)).toBe("");
    expect(resetsLine(null, now)).toBe("");
  });
  it("warns when an account past its limit is running its sessions on paid credits", () => {
    expect(paidLine({ meters: [week(100)], credits: { has: true, unlimited: false, balance: 500.4 } }, now)).toBe("Past its limit: its sessions run on paid credits (500 left).");
    expect(paidLine({ meters: [week(40)], credits: { has: true, unlimited: false, balance: 5 } }, now)).toBe("");
    expect(paidLine({ meters: [week(100)], credits: null }, now)).toBe("");
    expect(paidLine({ meters: [week(10)], ordinaryAllowed: false, credits: { has: true, unlimited: false, balance: null } }, now)).toBe("Past its limit: its sessions run on paid credits.");
  });
  it("tells a reset, a move off paid credits and a continue apart", () => {
    const base = { at: now, name: "my-session", agent: "codex", from: "default", to: "spare1", why: null };
    const line = (x: Parameters<typeof actionText>[0]) => { const t = actionText(x); return `${t.lead} ${t.name}${t.rest}`; };
    expect(line({ ...base, kind: "reset" })).toBe("Spent a banked reset on spare1 for my-session");
    expect(line({ ...base, kind: "move", paid: true })).toBe("Moved my-session from default to spare1 — default was spending paid credits");
    expect(line({ ...base, kind: "move" })).toBe("Moved my-session from default to spare1");
    expect(line({ ...base, kind: "resume", from: "spare1" })).toBe("Told my-session to continue on spare1");
  });
});
