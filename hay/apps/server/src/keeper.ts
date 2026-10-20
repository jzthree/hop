// The host's side of scripts/pty-keeper.js: a client for the keeper's Unix
// socket, a terminal proxy with exactly the surface Room uses (onData,
// onExit, write, resize, kill, pid), and the adoption of terminals that are
// already running when a (re)started host connects. With the keeper in
// place, restarting the host restarts NOTHING the agents run in.
import net from "node:net";
import { execFile } from "node:child_process";
import type { IPty } from "node-pty-prebuilt-multiarch";
import { resolveSpawn, type PtyFactory, type PtyFactoryOptions } from "./pty";

type Listener<T> = (v: T) => void;
type ExitEvent = { exitCode: number; signal?: number };

export type KeeperItem = {
  id: string;
  pid: number;
  cols: number;
  rows: number;
  cwd: string;
  exited: { exitCode: number | null; signal: number | string | null } | null;
  startedAt: number;
  bytes: number;
};

export class KeeperPty {
  pid = 0;
  cols: number;
  rows: number;
  /**
   * The terminal's foreground program ("zsh", "claude", "vim"), as node-pty
   * reports it. This was the constant "keeper" — the name of the process
   * that owns the terminal, not what runs in it — so every shell card said
   * "keeper" and the daemon read every idle shell as running an app.
   * Refreshed off the request path by KeeperClient.sampleForeground().
   */
  process = "";
  private dataListeners: Listener<string>[] = [];
  private exitListeners: Listener<ExitEvent>[] = [];
  private pending: string[] = [];
  private exited: ExitEvent | null = null;

  constructor(private client: KeeperClient, readonly id: string, cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  onData(listener: Listener<string>) {
    this.dataListeners.push(listener);
    // Output that arrived before Room registered (spawn races its constructor).
    if (this.pending.length) {
      const backlog = this.pending.join("");
      this.pending = [];
      listener(backlog);
    }
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((l) => l !== listener); } };
  }
  onExit(listener: Listener<ExitEvent>) {
    this.exitListeners.push(listener);
    if (this.exited) listener(this.exited);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((l) => l !== listener); } };
  }
  write(data: string) { this.client.send({ op: "write", id: this.id, data }); }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.client.send({ op: "resize", id: this.id, cols, rows });
  }
  kill(signal?: string) { this.client.send({ op: "kill", id: this.id, signal }); }
  // node-pty surface Room never calls; present so the proxy is a drop-in.
  pause() {}
  resume() {}
  clear() {}

  /** @internal */ deliverData(data: string) {
    if (this.dataListeners.length === 0) { this.pending.push(data); return; }
    for (const l of this.dataListeners) l(data);
  }
  /** @internal */ deliverExit(e: ExitEvent) {
    if (this.exited) return;
    this.exited = e;
    for (const l of this.exitListeners) l(e);
  }
}

export class KeeperClient {
  private sock: net.Socket | null = null;
  private buf = "";
  private nextReq = 1;
  private waiters = new Map<number, (msg: any) => void>();
  private ptys = new Map<string, KeeperPty>();
  /** Adoption window: data for these ids is in the replay, not yet live. */
  private awaitingReplay = new Set<string>();
  version = 0;
  keeperPid = 0;
  socketPath = "";

  static connect(socketPath: string, timeoutMs = 1500): Promise<KeeperClient> {
    return new Promise((resolve, reject) => {
      const client = new KeeperClient();
      client.socketPath = socketPath;
      const sock = net.connect(socketPath);
      const timer = setTimeout(() => { sock.destroy(); reject(new Error("keeper connect timeout")); }, timeoutMs);
      sock.once("connect", async () => {
        clearTimeout(timer);
        client.attach(sock);
        try {
          const hello = await client.request({ op: "hello", role: "host" }, 2000);
          client.version = Number(hello.version) || 0;
          client.keeperPid = Number(hello.pid) || 0;
          resolve(client);
        } catch (e) { sock.destroy(); reject(e); }
      });
      sock.once("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }

  private attach(sock: net.Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    // Lines can be megabytes (replays): scan only the bytes that just
    // arrived for the newline, never the whole buffer again — re-scanning
    // made a fleet's re-adoption quadratic (the first live restart crawled).
    let pending: string[] = [];
    sock.on("data", (chunk: string) => {
      let start = 0, nl: number;
      while ((nl = chunk.indexOf("\n", start)) >= 0) {
        pending.push(chunk.slice(start, nl));
        const line = pending.join("");
        pending = [];
        start = nl + 1;
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        this.dispatch(msg);
      }
      if (start < chunk.length) pending.push(chunk.slice(start));
    });
    sock.on("close", () => {
      if (this.sock !== sock) return;
      this.sock = null;
      void this.reconnect();
    });
    sock.on("error", () => { /* close follows */ });
  }

  private dispatch(msg: any) {
    if (msg.req !== undefined && this.waiters.has(msg.req)) {
      const w = this.waiters.get(msg.req)!;
      this.waiters.delete(msg.req);
      w(msg);
    }
    switch (msg.op) {
      case "data": {
        if (this.awaitingReplay.has(msg.id)) return;   // already inside the replay
        this.ptys.get(msg.id)?.deliverData(String(msg.data ?? ""));
        return;
      }
      case "exit": {
        const p = this.ptys.get(msg.id);
        if (p) {
          p.deliverExit({ exitCode: Number.isFinite(msg.exitCode) ? msg.exitCode : 0, signal: msg.signal ?? undefined });
          this.send({ op: "forget", id: msg.id });
          this.ptys.delete(msg.id);
        }
        return;
      }
      case "spawned": {
        const p = this.ptys.get(msg.id);
        if (p) p.pid = Number(msg.pid) || 0;
        return;
      }
      case "error": {
        console.error(`[hay] pty-keeper error${msg.id ? ` (${msg.id})` : ""}: ${msg.error}`);
        if (msg.id && msg.req === undefined) return;
        const p = msg.id ? this.ptys.get(msg.id) : undefined;
        if (p && !p.pid) { p.deliverExit({ exitCode: 1 }); this.ptys.delete(msg.id); }
        return;
      }
      default:
        return;
    }
  }

  /**
   * The connection dropped. If the KEEPER is still alive its terminals are
   * too — reconnect and carry on (output during the gap is lost from the live
   * stream, still in the keeper's ring). Only when it cannot be reached do
   * the rooms end: then the terminals really died with it.
   */
  private async reconnect() {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const fresh = await KeeperClient.connect(this.socketPath, 1000);
        const sock = fresh.sock!;
        fresh.sock = null;
        sock.removeAllListeners("data");
        sock.removeAllListeners("close");
        this.buf = "";
        this.attach(sock);
        console.error("[hay] pty-keeper connection restored");
        // Terminals that exited while we were away.
        const live = new Set((await this.list()).filter((x) => !x.exited).map((x) => x.id));
        for (const [id, p] of this.ptys) {
          if (!live.has(id)) { p.deliverExit({ exitCode: -1 }); this.ptys.delete(id); this.forget(id); }
        }
        return;
      } catch { /* keep trying */ }
    }
    console.error("[hay] pty-keeper unreachable — ending its terminals");
    for (const p of this.ptys.values()) p.deliverExit({ exitCode: -1 });
    this.ptys.clear();
  }

  get connected() { return !!this.sock && !this.sock.destroyed; }

  private fgTimer: NodeJS.Timeout | null = null;
  private fgRunning = false;
  /**
   * One `ps` for every terminal, every few seconds: a terminal's foreground
   * program is the process leading its foreground group (the tty's tpgid).
   * Asynchronous and batched — never a per-room syscall on the request path
   * (see Room.getSummary on what that cost).
   */
  private ensureForegroundSampler() {
    if (this.fgTimer) return;
    this.fgTimer = setInterval(() => this.sampleForeground(), 3000);
    this.fgTimer.unref?.();
    this.sampleForeground();
  }
  sampleForeground() {
    if (this.fgRunning || this.ptys.size === 0) return;
    this.fgRunning = true;
    execFile("ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,comm="], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 }, (err, out) => {
      this.fgRunning = false;
      if (err || !out) return;
      const rows: ProcRow[] = [];
      for (const line of out.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/.exec(line);
        if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], tpgid: +m[4], comm: m[5].trim() });
      }
      const byPid = new Map(rows.map((r) => [r.pid, r]));
      const byGroup = new Map<number, ProcRow[]>();
      for (const r of rows) {
        const g = byGroup.get(r.pgid);
        if (g) g.push(r); else byGroup.set(r.pgid, [r]);
      }
      for (const p of this.ptys.values()) {
        const shell = p.pid ? byPid.get(p.pid) : undefined;
        if (!shell) continue;
        const name = foregroundProgram(shell, byGroup.get(shell.tpgid) || []);
        if (name) p.process = name;
      }
    });
  }

  send(msg: Record<string, unknown>) {
    if (!this.sock || this.sock.destroyed) return;
    this.sock.write(JSON.stringify(msg) + "\n");
  }

  request(msg: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(req); reject(new Error(`keeper ${String(msg.op)} timeout`)); }, timeoutMs);
      this.waiters.set(req, (m) => { clearTimeout(timer); resolve(m); });
      this.send({ ...msg, req });
    });
  }

  list(): Promise<KeeperItem[]> {
    return this.request({ op: "list" }).then((m) => (Array.isArray(m.items) ? m.items : []));
  }

  /** Spawn through the keeper; returns the proxy synchronously (Room needs it now). */
  spawn(id: string, options: PtyFactoryOptions): KeeperPty {
    const r = resolveSpawn(options);
    const p = new KeeperPty(this, id, r.cols, r.rows);
    this.ptys.set(id, p);
    this.ensureForegroundSampler();
    this.send({ op: "spawn", id, file: r.file, args: r.args, cwd: r.cwd, env: r.env, cols: r.cols, rows: r.rows, req: this.nextReq++ });
    return p;
  }

  /**
   * Re-adopt a terminal the keeper is already running: the proxy plus the
   * output it produced so far (the ring), with no byte delivered twice —
   * live data for this id is held off until the replay frame, which the
   * keeper writes after everything the ring already contains.
   */
  async adopt(item: KeeperItem): Promise<{ pty: KeeperPty; replay: string }> {
    const p = new KeeperPty(this, item.id, item.cols, item.rows);
    p.pid = item.pid;
    this.awaitingReplay.add(item.id);
    this.ptys.set(item.id, p);
    this.ensureForegroundSampler();
    try {
      const m = await this.request({ op: "replay", id: item.id, maxBytes: 2_000_000 }, 20_000);
      return { pty: p, replay: String(m.data ?? "") };
    } finally {
      this.awaitingReplay.delete(item.id);
    }
  }

  forget(id: string) { this.send({ op: "forget", id }); }

  /** `hop stop --all`: end every terminal and the keeper itself. */
  shutdown() { this.send({ op: "shutdown" }); }

  factory(): PtyFactory {
    return (options: PtyFactoryOptions) => {
      const id = options.id || `anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return this.spawn(id, options) as unknown as IPty;
    };
  }
}

/**
 * node-pty's style of name: the program's basename, login-shell dash kept off
 * (Room strips it anyway). `ps` gives a path for some processes
 * ("/opt/homebrew/bin/node") and the bare name for others.
 */
export function foregroundName(comm: string): string {
  const base = comm.trim().split("/").pop() || comm.trim();
  return base.replace(/^-/, "");
}

type ProcRow = { pid: number; ppid: number; pgid: number; tpgid: number; comm: string };
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "login"]);

/**
 * What a person would say runs in the terminal: the SHALLOWEST non-shell
 * process of the tty's foreground group — the program the shell started.
 * node-pty names the group LEADER, and a session launched as `zsh -c claude`
 * keeps claude in zsh's group, so the leader read "zsh" while claude ran.
 * Not the deepest: claude starts helpers in its own group (MCP servers as
 * "node", "caffeinate"), and those read as the session's program.
 */
export function foregroundProgram(shell: ProcRow, group: ProcRow[]): string {
  if (group.length === 0) return foregroundName(shell.comm);
  const byPid = new Map(group.map((r) => [r.pid, r]));
  const depth = (r: ProcRow) => {
    let d = 0;
    for (let cur = r; byPid.has(cur.ppid) && d < 64; cur = byPid.get(cur.ppid)!) d++;
    return d;
  };
  const programs = group
    .filter((r) => !SHELLS.has(foregroundName(r.comm)))
    .sort((a, b) => depth(a) - depth(b) || a.pid - b.pid);
  let pick = programs[0] || group.find((r) => r.pid === r.pgid) || group[0];
  // A launcher script (`node …/codex.js` starting the codex binary) is the
  // wrapper, not the program: step down while the pick is an interpreter
  // with a non-interpreter child. A plain `node server.js` stays "node".
  for (let hops = 0; hops < 4 && INTERPRETERS.has(foregroundName(pick.comm)); hops++) {
    const child = group.find((r) => r.ppid === pick.pid && !SHELLS.has(foregroundName(r.comm))
      && !INTERPRETERS.has(foregroundName(r.comm)) && !HELPERS.has(foregroundName(r.comm)));
    if (!child) break;
    pick = child;
  }
  return foregroundName(pick.comm);
}
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby", "perl"]);
const HELPERS = new Set(["caffeinate"]);
