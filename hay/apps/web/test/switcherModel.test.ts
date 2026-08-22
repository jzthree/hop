import { describe, expect, it } from "vitest";
import {
  buildSwitcherModel,
  filterScore,
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

  it("holds the tail in a STABLE order — recency lives in the hero, not the tail", () => {
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
    // The hero is the recency-and-attention zone: current + the most recent.
    expect(model.hero.map((s) => s.name)).toEqual(["me", "a1", "a2", "a3"]);
    // One unlabeled continuation, not per-directory sections (grouping by
    // workdir is Project mode's job).
    expect(model.groups.map((g) => g.label)).toEqual([""]);
    // The tail no longer reshuffles by recency — it sorts by name (ports
    // last) so a session stays where the eye last found it across reopens.
    // `web` has the HIGHEST activity of the tail but is a port, so it sinks;
    // the rest are alphabetical regardless of how recently they ran.
    expect(model.groups[0].rows.map((s) => s.name)).toEqual(["hop-old", "hop-older", "misc", "web"]);
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

describe("project mode stability", () => {
  it("orders groups and rows alphabetically, immune to recency and attention", () => {
    const sessions = [
      mk({ name: "zeta", cwd: "/Users/x/Code/bbb", lastActivityAt: 9000, bellUnseen: true }),
      mk({ name: "alpha", cwd: "/Users/x/Code/bbb", lastActivityAt: 10 }),
      mk({ name: "mid", cwd: "/Users/x/Code/aaa", lastActivityAt: 5000 })
    ];
    const model = buildSwitcherModel(sessions, null, "", "project");
    if (model.mode !== "project") throw new Error("expected project");
    // Groups alphabetical — NOT by which project was touched last.
    expect(model.groups.map((g) => g.label)).toEqual(["~/Code/aaa", "~/Code/bbb"]);
    // Rows alphabetical — a ringing bell shows as a dot, not as a jump to the top.
    expect(model.groups[1].rows.map((x) => x.name)).toEqual(["alpha", "zeta"]);
  });

  it("keeps the Recent mode's tail recency-driven (movement is the signal there)", () => {
    const sessions = [
      mk({ name: "me", lastActivityAt: 99999 }),
      mk({ name: "a1", lastActivityAt: 9000 }), mk({ name: "a2", lastActivityAt: 8000 }), mk({ name: "a3", lastActivityAt: 7000 }),
      mk({ name: "old-slow", cwd: "/Users/x/Code/p", lastActivityAt: 100 }),
      mk({ name: "old-fast", cwd: "/Users/x/Code/p", lastActivityAt: 200 })
    ];
    const model = buildSwitcherModel(sessions, "me", "");
    if (model.mode !== "tiers") throw new Error("expected tiers");
    expect(model.groups[0].rows.map((x) => x.name)).toEqual(["old-fast", "old-slow"]); // recency, not alphabet
  });
});
describe("manual mode stability", () => {
  it("unplaced sessions sit at the tail in a stable order, not by recency", () => {
    const sessions = [
      mk({ name: "placed", lastActivityAt: 1 }),
      mk({ name: "zeta", lastActivityAt: 9000, bellUnseen: true }),
      mk({ name: "alpha", lastActivityAt: 10 })
    ];
    const model = buildSwitcherModel(sessions, null, "", "manual", ["placed"]);
    if (model.mode !== "manual") throw new Error("expected manual");
    expect(model.rows.map((r) => r.name)).toEqual(["placed", "alpha", "zeta"]);
  });

  it("a session going loud never moves in manual order", () => {
    const quiet = [mk({ name: "a" }), mk({ name: "b" }), mk({ name: "c" })];
    const order = ["c", "a", "b"];
    const before = buildSwitcherModel(quiet, null, "", "manual", order);
    const loud = [mk({ name: "a" }), mk({ name: "b", lastActivityAt: 99999, bellUnseen: true }), mk({ name: "c" })];
    const after = buildSwitcherModel(loud, null, "", "manual", order);
    if (before.mode !== "manual" || after.mode !== "manual") throw new Error("expected manual");
    expect(after.rows.map((r) => r.name)).toEqual(before.rows.map((r) => r.name));
    expect(after.rows.map((r) => r.name)).toEqual(["c", "a", "b"]);
  });
});

describe("manual mode folders", () => {
  const folders = [{ id: "f1", name: "Experiments" }, { id: "f2", name: "Infra" }];

  it("files sessions into their folders and leaves the rest loose", () => {
    const sessions = [
      mk({ name: "alpha", folderId: "f1" }),
      mk({ name: "beta" }),
      mk({ name: "gamma", folderId: "f2" })
    ];
    const model = buildSwitcherModel(sessions, null, "", "manual", [], folders);
    if (model.mode !== "manual") throw new Error("expected manual");
    expect(model.folders.map((f) => f.folder.name)).toEqual(["Experiments", "Infra"]);
    expect(model.folders[0].rows.map((r) => r.name)).toEqual(["alpha"]);
    expect(model.rows.map((r) => r.name)).toEqual(["beta"]);
  });

  it("keeps an empty folder visible — a folder is a place you intend to fill", () => {
    const model = buildSwitcherModel([mk({ name: "solo" })], null, "", "manual", [], folders);
    if (model.mode !== "manual") throw new Error("expected manual");
    expect(model.folders.map((f) => f.rows.length)).toEqual([0, 0]);
    expect(model.rows.map((r) => r.name)).toEqual(["solo"]);
  });

  it("a session in a deleted folder falls back to loose rather than vanishing", () => {
    const sessions = [mk({ name: "orphan", folderId: "f_gone" })];
    const model = buildSwitcherModel(sessions, null, "", "manual", [], folders);
    if (model.mode !== "manual") throw new Error("expected manual");
    expect(model.rows.map((r) => r.name)).toEqual(["orphan"]);
  });

  it("filtering narrows inside folders instead of pulling sessions out of them", () => {
    const sessions = [
      mk({ name: "alpha", folderId: "f1" }),
      mk({ name: "alpine", folderId: "f1" }),
      mk({ name: "beta" })
    ];
    const model = buildSwitcherModel(sessions, null, "alp", "manual", [], folders);
    if (model.mode !== "manual") throw new Error("expected manual");
    expect(model.folders[0].rows.map((r) => r.name)).toEqual(["alpha", "alpine"]);
    expect(model.rows).toEqual([]);
  });

  it("folders do not leak into Recent or Project", () => {
    const sessions = [mk({ name: "alpha", folderId: "f1" }), mk({ name: "beta" })];
    const recent = buildSwitcherModel(sessions, null, "", "recent", [], folders);
    const project = buildSwitcherModel(sessions, null, "", "project", [], folders);
    expect(recent.mode).toBe("tiers");
    expect(project.mode).toBe("project");
    if (project.mode !== "project") throw new Error("expected project");
    expect(project.groups.some((g) => g.label === "Experiments")).toBe(false);
  });
});

describe("manual mode folders under filter", () => {
  const folders = [{ id: "f1", name: "Experiments" }];

  it("matches inside folders are found and stay filed", () => {
    const sessions = [mk({ name: "alpha", folderId: "f1" }), mk({ name: "beta" })];
    const model = buildSwitcherModel(sessions, null, "alph", "manual", [], folders);
    if (model.mode !== "manual") throw new Error("expected manual");
    expect(model.folders[0].rows.map((r) => r.name)).toEqual(["alpha"]);
    expect(model.rows).toEqual([]); // loose list empty ≠ no results
  });
});

describe("filterScore tiers", () => {
  it("searches taglines — the user's own words for a session", () => {
    const s = mk({ name: "exp42", tagline: "protein folding sweep" });
    expect(filterScore(s, "folding")).toBe(50);
    expect(filterScore(mk({ name: "exp43" }), "folding")).toBe(0);
  });

  it("ranks a name substring above a tagline hit", () => {
    const byName = mk({ name: "folding-ui" });
    const byTagline = mk({ name: "exp42", tagline: "protein folding sweep" });
    expect(filterScore(byName, "folding")).toBeGreaterThan(filterScore(byTagline, "folding"));
  });

  it("multi-word terms AND across different fields", () => {
    const s = mk({ name: "web", cwd: "/Users/x/Code/hop2" });
    expect(filterScore(s, "hop2 web")).toBeGreaterThan(0);
    expect(filterScore(s, "hop2 nothere")).toBe(0);
  });

  it("multi-word score is the weakest term's — every word must earn the rank", () => {
    const s = mk({ name: "web", cwd: "/Users/x/Code/hop2" });
    // "web" hits the name exactly (100); "hop2" only the cwd (≤70).
    expect(filterScore(s, "web hop2")).toBeLessThan(filterScore(s, "web"));
  });

  it("single-term ranking is unchanged: exact > prefix > substring", () => {
    expect(filterScore(mk({ name: "hub" }), "hub")).toBe(100);
    expect(filterScore(mk({ name: "hubble" }), "hub")).toBe(80);
    expect(filterScore(mk({ name: "the-hub-x" }), "hub")).toBe(60);
  });

  it("tolerates typos via subsequence, ranked below everything else", () => {
    const s = mk({ name: "hubble" });
    expect(filterScore(s, "hbl")).toBe(20);
    expect(filterScore(s, "hlb")).toBe(0); // order matters
    expect(filterScore(mk({ name: "ab" }), "ab")).toBe(100);
  });

  it("subsequence needs 3+ chars so short queries stay literal", () => {
    expect(filterScore(mk({ name: "hubble" }), "he")).toBe(0);
  });

  it("matches the folder a session is filed in, passed by the model", () => {
    const folders = [{ id: "f1", name: "Experiments" }];
    const sessions = [mk({ name: "alpha", folderId: "f1" }), mk({ name: "beta" })];
    const model = buildSwitcherModel(sessions, null, "experi", "recent", [], folders);
    if (model.mode !== "filter") throw new Error("expected filter");
    expect(model.rows.map((r) => r.name)).toEqual(["alpha"]);
  });

  it("folder-name queries narrow manual mode to that folder's sessions", () => {
    const folders = [{ id: "f1", name: "Experiments" }];
    const sessions = [mk({ name: "alpha", folderId: "f1" }), mk({ name: "beta" })];
    const model = buildSwitcherModel(sessions, null, "experiments", "manual", [], folders);
    if (model.mode !== "manual") throw new Error("expected manual");
    expect(model.folders[0].rows.map((r) => r.name)).toEqual(["alpha"]);
    expect(model.rows).toEqual([]);
  });
});

describe("manual order never moves on its own", () => {
  const s = (name: string, extra: Partial<SwitcherSession> = {}): SwitcherSession => ({
    name, displayName: name, internalName: name, active: true, starting: false,
    createdBy: "user", ...extra
  });

  it("activity cannot reorder placed sessions", () => {
    const order = ["c", "a", "b"];
    const quiet = [s("a", { lastActivityAt: 1 }), s("b", { lastActivityAt: 2 }), s("c", { lastActivityAt: 3 })];
    const noisy = [s("a", { lastActivityAt: 9999 }), s("b", { lastActivityAt: 2 }), s("c", { lastActivityAt: 3 })];

    const rowsOf = (list: SwitcherSession[]) => {
      const m = buildSwitcherModel(list, null, "", "manual", order, []);
      return m.mode === "manual" ? m.rows.map((r) => r.name) : [];
    };
    // A session printing output, ringing a bell, or going idle changes nothing.
    expect(rowsOf(quiet)).toEqual(["c", "a", "b"]);
    expect(rowsOf(noisy)).toEqual(["c", "a", "b"]);
  });

  it("a rename cannot move a placed session", () => {
    // The saved order is keyed on internalName, so the label may change
    // freely — an agent renaming a session must not rearrange the wall.
    const order = ["c", "a", "b"];
    const renamed = [s("a", { displayName: "zzz" }), s("b"), s("c")];
    const m = buildSwitcherModel(renamed, null, "", "manual", order, []);
    expect(m.mode === "manual" && m.rows.map((r) => r.internalName)).toEqual(["c", "a", "b"]);
  });

  it("an unplaced session lands at the tail, never between placed ones", () => {
    const order = ["c", "a"];
    const list = [s("a"), s("c"), s("b")];   // "b" was never dragged
    const m = buildSwitcherModel(list, null, "", "manual", order, []);
    expect(m.mode === "manual" && m.rows.map((r) => r.name)).toEqual(["c", "a", "b"]);
  });
});

describe("origin scope vs foldered sessions", () => {
  const mk = (name: string, extra: Partial<SwitcherSession> = {}): SwitcherSession => ({
    name, displayName: name, internalName: name, active: true, starting: false,
    createdBy: "user", ...extra
  });

  it("a session an agent filed into the user's folder shows on the user wall", () => {
    // The mybot incident: "create mybot under Softwares", relayed through an
    // agent, landed createdBy=agent — created, filed, and invisible on the
    // default tab. Placement in the user's own structure outranks provenance.
    const sessions = [
      mk("mine"),
      mk("mybot", { createdBy: "agent", folderId: "f_soft" }),
      mk("worker", { createdBy: "agent" })
    ];
    const user = filterSessionsByOrigin(sessions, "user").map((s) => s.name);
    expect(user).toContain("mybot");
    expect(user).toContain("mine");
    expect(user).not.toContain("worker"); // loose agent workers stay on their tab

    // The agent tab still lists it — it IS agent-created; no tab lies.
    expect(filterSessionsByOrigin(sessions, "agent").map((s) => s.name)).toContain("mybot");
  });
});
