import { describe, expect, it } from "vitest";
import {
  buildSwitcherModel,
  filterSessionsByOrigin,
  projectKey,
  relativeTime,
  type SwitcherSession
} from "../src/utils/switcherModel";

const mk = (over: Partial<SwitcherSession> & { name: string }): SwitcherSession => ({
  displayName: over.name,
  active: true,
  starting: false,
  internalName: over.name,
  lastActivityAt: 0,
  bellSeq: 0,
  ...over
});

describe("buildSwitcherModel", () => {
  it("puts current first, then bells, then unread, then recent fill", () => {
    const sessions = [
      mk({ name: "cold", lastActivityAt: 10 }),
      mk({ name: "recent", lastActivityAt: 900 }),
      mk({ name: "ringing", lastActivityAt: 500, bellUnseen: true }),
      mk({ name: "chatty", lastActivityAt: 700, unread: true }),
      mk({ name: "me", lastActivityAt: 1000 })
    ];
    const model = buildSwitcherModel(sessions, "me", "");
    if (model.mode !== "tiers") throw new Error("expected tiers");
    expect(model.hero.map((s) => s.name)).toEqual(["me", "ringing", "chatty", "recent"]);
    expect(model.currentInHero).toBe(true);
    expect(model.groups.flatMap((g) => g.rows.map((s) => s.name))).toEqual(["cold"]);
  });

  it("keeps the current session in hero exactly once even when it has a bell", () => {
    const sessions = [
      mk({ name: "me", lastActivityAt: 1000, bellUnseen: true }),
      mk({ name: "other", lastActivityAt: 500, unread: true })
    ];
    const model = buildSwitcherModel(sessions, "me", "");
    if (model.mode !== "tiers") throw new Error("expected tiers");
    expect(model.hero.filter((s) => s.name === "me")).toHaveLength(1);
    expect(model.hero[0].name).toBe("me");
  });

  it("never buries attention sessions even past the hero minimum", () => {
    const sessions = [
      mk({ name: "me", lastActivityAt: 100 }),
      ...Array.from({ length: 6 }, (_, i) => mk({ name: `bell${i}`, lastActivityAt: 50 + i, bellUnseen: true }))
    ];
    const model = buildSwitcherModel(sessions, "me", "");
    if (model.mode !== "tiers") throw new Error("expected tiers");
    expect(model.hero).toHaveLength(7); // current + all six bells
  });

  it("groups the tail by project and sinks Ports to the bottom", () => {
    const sessions = [
      mk({ name: "me", lastActivityAt: 1000 }),
      mk({ name: "a1", lastActivityAt: 990 }),
      mk({ name: "a2", lastActivityAt: 980 }),
      mk({ name: "a3", lastActivityAt: 970 }),
      mk({ name: "hop-old", lastActivityAt: 300, cwd: "/Users/x/Code/hop2/hay" }),
      mk({ name: "hop-older", lastActivityAt: 200, cwd: "/Users/x/Code/hop2" }),
      mk({ name: "misc", lastActivityAt: 400, cwd: "/Users/x/Notes" }),
      mk({ name: "web", lastActivityAt: 999, type: "port", port: 3000, active: false })
    ];
    const model = buildSwitcherModel(sessions, "me", "");
    if (model.mode !== "tiers") throw new Error("expected tiers");
    expect(model.hero.map((s) => s.name)).toEqual(["me", "a1", "a2", "a3"]);
    expect(model.groups.map((g) => g.label)).toEqual(["~/Notes", "~/Code/hop2", "Ports"]);
    expect(model.groups[1].rows.map((s) => s.name)).toEqual(["hop-old", "hop-older"]);
  });

  it("filter mode flattens and ranks attention first", () => {
    const sessions = [
      mk({ name: "hop-a", lastActivityAt: 900, cwd: "/Users/x/Code/hop2" }),
      mk({ name: "hop-b", lastActivityAt: 100, cwd: "/Users/x/Code/hop2", bellUnseen: true }),
      mk({ name: "other", lastActivityAt: 950, cwd: "/Users/x/Notes" })
    ];
    const model = buildSwitcherModel(sessions, null, "hop");
    if (model.mode !== "filter") throw new Error("expected filter");
    expect(model.rows.map((s) => s.name)).toEqual(["hop-b", "hop-a"]);
  });

  it("filter ranking is deterministic: bell beats unread beats plain recency", () => {
    const sessions = [
      mk({ name: "hop-plain", lastActivityAt: 1000, cwd: "/Users/x/Code/hop2" }),
      mk({ name: "hop-unread", lastActivityAt: 500, cwd: "/Users/x/Code/hop2", unread: true }),
      mk({ name: "hop-bell", lastActivityAt: 100, cwd: "/Users/x/Code/hop2", bellUnseen: true })
    ];
    const model = buildSwitcherModel(sessions, null, "hop");
    if (model.mode !== "filter") throw new Error("expected filter");
    expect(model.rows.map((s) => s.name)).toEqual(["hop-bell", "hop-unread", "hop-plain"]);
  });

  it("filter matches cwd and foreground process too", () => {
    const sessions = [
      mk({ name: "s1", cwd: "/Users/x/Code/hop2" }),
      mk({ name: "s2", foregroundProcess: "claude" }),
      mk({ name: "s3" })
    ];
    const byCwd = buildSwitcherModel(sessions, null, "code/hop");
    const byProc = buildSwitcherModel(sessions, null, "claude");
    if (byCwd.mode !== "filter" || byProc.mode !== "filter") throw new Error("expected filter");
    expect(byCwd.rows.map((s) => s.name)).toEqual(["s1"]);
    expect(byProc.rows.map((s) => s.name)).toEqual(["s2"]);
  });

  it("filter matches the home-shortened cwd the UI displays (~/...)", () => {
    const sessions = [
      mk({ name: "home", cwd: "/Users/x/Code/hop2" }),
      mk({ name: "root", cwd: "/root/ops" }),
      mk({ name: "sys", cwd: "/etc" })
    ];
    const byTilde = buildSwitcherModel(sessions, null, "~");
    const byTildePath = buildSwitcherModel(sessions, null, "~/code");
    if (byTilde.mode !== "filter" || byTildePath.mode !== "filter") throw new Error("expected filter");
    expect(byTilde.rows.map((s) => s.name).sort()).toEqual(["home", "root"]);
    expect(byTildePath.rows.map((s) => s.name)).toEqual(["home"]);
  });

  it("exact workdir match outranks everything merely under it", () => {
    const sessions = [
      mk({ name: "deep", cwd: "/Users/x/Code/hop2", lastActivityAt: 900, bellUnseen: true }),
      mk({ name: "athome", cwd: "/Users/x", lastActivityAt: 10 }),
      mk({ name: "deeper", cwd: "/Users/x/tmp", lastActivityAt: 500 })
    ];
    const model = buildSwitcherModel(sessions, null, "~");
    if (model.mode !== "filter") throw new Error("expected filter");
    // cwd === "~" wins despite lower activity and no attention.
    expect(model.rows[0].name).toBe("athome");
  });

  it("name matches outrank cwd substring matches", () => {
    const sessions = [
      mk({ name: "hopper", cwd: "/Users/x/other" }),
      mk({ name: "misc", cwd: "/Users/x/Code/hop2" })
    ];
    const model = buildSwitcherModel(sessions, null, "hop");
    if (model.mode !== "filter") throw new Error("expected filter");
    expect(model.rows.map((s) => s.name)).toEqual(["hopper", "misc"]);
  });

  it("project mode groups every session by workdir, ports last", () => {
    const sessions = [
      mk({ name: "a", cwd: "/Users/x/Code/hop2", lastActivityAt: 900 }),
      mk({ name: "b", cwd: "/Users/x/Code/other", lastActivityAt: 800 }),
      mk({ name: "c", cwd: "/Users/x/Code/hop2/sub", lastActivityAt: 500 }),
      mk({ name: "p", type: "port", port: 3000 })
    ];
    const model = buildSwitcherModel(sessions, null, "", "project");
    if (model.mode !== "project") throw new Error("expected project");
    const labels = model.groups.map((g) => g.label);
    expect(labels).toContain("~/Code/hop2");
    expect(labels[labels.length - 1]).toBe("Ports");
    const hop2 = model.groups.find((g) => g.label === "~/Code/hop2");
    expect(hop2?.rows.map((s) => s.name).sort()).toEqual(["a", "c"]);
  });

  it("manual mode honors the saved order and appends new sessions", () => {
    const sessions = [
      mk({ name: "first", lastActivityAt: 10 }),
      mk({ name: "second", lastActivityAt: 900 }),
      mk({ name: "brandnew", lastActivityAt: 500 })
    ];
    // Saved order lists second then first; brandnew isn't saved yet.
    const model = buildSwitcherModel(sessions, null, "", "manual", ["second", "first"]);
    if (model.mode !== "manual") throw new Error("expected manual");
    expect(model.rows.map((s) => s.name)).toEqual(["second", "first", "brandnew"]);
  });

  it("a filter query overrides PROJECT grouping, but manual keeps the user's order", () => {
    const sessions = [mk({ name: "alpha" }), mk({ name: "beta" })];
    // Project mode: a query flattens the groups into a ranked list.
    expect(buildSwitcherModel(sessions, null, "alph", "project").mode).toBe("filter");
    // Manual mode: filtering narrows the wall but must NOT re-rank it, or
    // the arrangement shifts under the user exactly when they are dragging.
    const manual = buildSwitcherModel(sessions, null, "alph", "manual", ["beta", "alpha"]);
    expect(manual.mode).toBe("manual");
  });
});

describe("filterSessionsByOrigin", () => {
  const sessions = [
    mk({ name: "legacy-user" }),
    mk({ name: "explicit-user", createdBy: "user" }),
    mk({ name: "worker", createdBy: "agent" })
  ];

  it("defaults legacy sessions to the user side", () => {
    expect(filterSessionsByOrigin(sessions, "user").map((s) => s.name)).toEqual([
      "legacy-user",
      "explicit-user"
    ]);
  });

  it("can isolate agent sessions or show all sessions", () => {
    expect(filterSessionsByOrigin(sessions, "agent").map((s) => s.name)).toEqual(["worker"]);
    expect(filterSessionsByOrigin(sessions, "all").map((s) => s.name)).toEqual([
      "legacy-user",
      "explicit-user",
      "worker"
    ]);
  });
});

describe("projectKey", () => {
  it("keeps two segments under home, three at root", () => {
    expect(projectKey("/Users/x/Code/hop2/hay/apps")).toBe("~/Code/hop2");
    expect(projectKey("/Users/x")).toBe("~");
    expect(projectKey("/opt/data/things/deep")).toBe("/opt/data/things");
    expect(projectKey(undefined)).toBe("Other");
  });
});

describe("relativeTime", () => {
  it("formats compact ranges", () => {
    const now = 1_000_000_000;
    expect(relativeTime(0, now)).toBe("");
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 30_000, now)).toBe("30s ago");
    expect(relativeTime(now - 120_000, now)).toBe("2m ago");
    expect(relativeTime(now - 7_200_000, now)).toBe("2h ago");
    expect(relativeTime(now - 172_800_000, now)).toBe("2d ago");
  });

  it("rolls unit boundaries up: 60s is minutes, 24h is days", () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 60_000, now)).toBe("1m ago");
    expect(relativeTime(now - 86_400_000, now)).toBe("1d ago");
  });
});

describe("manual mode + filter", () => {
  const sessions = [
    mk({ name: "alpha" }),
    mk({ name: "beta" }),
    mk({ name: "gamma" }),
    mk({ name: "alpine" })
  ];
  // The user's arrangement, deliberately NOT alphabetical or by score.
  const order = ["gamma", "alpine", "beta", "alpha"];

  it("filters without re-ranking, so the wall stays in the user's order", () => {
    const model = buildSwitcherModel(sessions, null, "alp", "manual", order);
    if (model.mode !== "manual") throw new Error("expected manual mode under filter");
    // Both "alp" matches, in MANUAL order (alpine before alpha) — a score
    // ranking would put the exact-prefix match first and shuffle the wall.
    expect(model.rows.map((s) => s.name)).toEqual(["alpine", "alpha"]);
  });

  it("still score-ranks when the user has not chosen manual order", () => {
    const model = buildSwitcherModel(sessions, null, "alp", "recent");
    if (model.mode !== "filter") throw new Error("expected filter mode");
    expect(model.rows.map((s) => s.name)).toContain("alpha");
  });
});