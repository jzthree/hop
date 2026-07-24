import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { readlink } from "node:fs";
import type { IPty } from "node-pty-prebuilt-multiarch";
import { clientMessageSchema, pickPresenceColor, safeParseClientMessage } from "hay-shared";
import type { ClientMessage, PresenceClient, ServerMessage } from "hay-shared";
import type { PtyFactory } from "./pty";

export type SocketAdapter = {
  send: (data: string) => void;
  onMessage: (handler: (data: string) => void) => void;
  onClose: (handler: () => void) => void;
  onError: (handler: (err: Error) => void) => void;
  close: () => void;
  isOpen: () => boolean;
};

export type ClientInfo = {
  id: string;
  name: string;
  // "local-cli" = hop CLI attach; "monitor" = read-only live tile (session
  // switcher wall): excluded from presence and client counts, and given a
  // small snapshot so a wall of tiles doesn't pull megabytes per open.
  source?: string;
  colorIndex: number;
  cols: number;
  rows: number;
  // Optional per-connection cap for the join snapshot (clamped to the
  // room-level bound). Monitors request ~64KB.
  replayBytes?: number;
};

export type RoomCreateOptions = {
  cwd: string;
  env?: Record<string, string>;
  shell?: string;
  // Raw terminal output to pre-load into the room's buffer before the PTY
  // starts producing data. Used by `hop restore` to replay a plain-shell
  // session's last screen (so reopening it picks up where it left off) ahead of
  // the fresh shell's first prompt. Clamped to the buffer cap like live output.
  seedOutput?: string;
};

export type RoomSummary = {
  id: string;
  cwd: string;
  liveCwd: string;
  foregroundProcess: string;
  lastActivityAt: number;
  bellSeq: number;
  lastBellAt: number;
  clientCount: number;
  localCliCount: number;
};

// Raw output retained for reattach snapshots. ~20MB of raw stream reconstructs
// roughly a full client scrollback (tens of thousands of lines) of plain
// output; TUI streams are escape-dense and reconstruct less. This is the whole
// buffer replayed (and parsed by the client) on reattach, so very large values
// trade memory + reattach-parse time for deeper restored history. Override with
// HAY_SNAPSHOT_BUFFER_BYTES (bytes of raw stream kept per room).
const MAX_BUFFER_SIZE = (() => {
  const env = Number(process.env.HAY_SNAPSHOT_BUFFER_BYTES);
  return Number.isFinite(env) && env > 0 ? env : 20_000_000;
})();
// Keep rooms alive indefinitely; only explicit kill/remove should end a session.
const CLEANUP_DELAY_MS = 0;
// Join-time replay bound: the room keeps up to MAX_BUFFER_SIZE of history,
// but replaying tens of MB through the client's parser on every open/switch
// is what made sessions feel slow to load (a phone on a tunnel downloads and
// parses all of it before first paint). Send a bounded tail instead; the cut
// avoids starting mid-line so a partial escape sequence can't corrupt the
// replay. Alt-screen apps redraw fully, and mode flags (alternateScreen,
// cursorHidden, keyboardEnhanced) travel separately, so a tail is safe.
const SNAPSHOT_REPLAY_BYTES = (() => {
  const env = Number(process.env.HAY_SNAPSHOT_REPLAY_BYTES);
  return Number.isFinite(env) && env > 0 ? env : 1_500_000;
})();

const boundSnapshotReplay = (buffer: string): string => {
  if (buffer.length <= SNAPSHOT_REPLAY_BYTES) return buffer;
  let tail = buffer.slice(buffer.length - SNAPSHOT_REPLAY_BYTES);
  const nl = tail.indexOf("\n");
  if (nl !== -1 && nl < 8192) {
    tail = tail.slice(nl + 1);
  }
  return tail;
};

// Autofit-on-attach: a resize may claim the shared size when every OTHER
// client has been input-idle at least this long. Someone actively typing keeps
// the size they set; a viewer opening the session after everyone went idle
// takes it over immediately instead of waiting to type first.
const RESIZE_CLAIM_IDLE_MS = (() => {
  const env = Number(process.env.HAY_RESIZE_CLAIM_IDLE_MS);
  return Number.isFinite(env) && env >= 0 ? env : 60_000;
})();
// A claim:"attach" resize (a fresh client's first autofit) is deliberate:
// someone just opened the session there. It takes the shared size unless a
// peer typed within this window — only an actively-typing peer holds it.
const ATTACH_CLAIM_IDLE_MS = (() => {
  const env = Number(process.env.HAY_ATTACH_CLAIM_IDLE_MS);
  return Number.isFinite(env) && env >= 0 ? env : 5_000;
})();
const CONTROL_SEQUENCE_TAIL = 32;
const DEBUG_STATE = process.env.HAY_DEBUG === "1";

const now = () => Date.now();

// Build a useful error for a payload that failed schema validation: name the
// message type and the offending field instead of a bare "Invalid message".
const describeInvalidMessage = (payload: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return "Invalid message: not valid JSON";
  }
  const type = typeof (parsed as { type?: unknown })?.type === "string" ? (parsed as { type: string }).type : null;
  if (!type) {
    return "Invalid message: missing type";
  }
  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path?.filter((part) => typeof part === "string").join(".");
    if (field) {
      return `Invalid ${type} message: ${field} ${issue.message.toLowerCase()}`;
    }
    return `Invalid ${type} message`;
  }
  return "Invalid message";
};

const toPresence = (client: ClientState): PresenceClient => ({
  id: client.id,
  name: client.name,
  color: client.color,
  typing: client.typing,
  lastActive: client.lastActive
});

class ClientState {
  id: string;
  name: string;
  color: string;
  typing = false;
  lastActive = now();
  // Timestamp of this client's last real keystroke input (not resize, not the
  // typing indicator, not connect). 0 = has never typed. Drives the active PTY
  // size election so size follows the active typer, not whoever last resized.
  lastInputAt = 0;
  socket: SocketAdapter;
  source: string;
  cols: number;
  rows: number;

  constructor(info: ClientInfo, socket: SocketAdapter) {
    this.id = info.id;
    this.name = info.name;
    this.source = info.source || "";
    this.color = pickPresenceColor(info.colorIndex);
    this.socket = socket;
    this.cols = info.cols;
    this.rows = info.rows;
  }
}

export class Room extends EventEmitter {
  id: string;
  private pty: IPty;
  private readonly initialCwd: string;
  private liveCwd: string;
  private foregroundProcess = "";
  private lastActivityAt = now(); // ms of the most recent PTY output
  // Terminal bells (BEL outside escape sequences) rung by the app — agents and
  // long jobs ring one to ask for attention. Monotonic counter + timestamp so
  // clients can diff against a last-seen value; never reset for a room's life.
  private bellSeq = 0;
  private lastBellAt = 0;
  // Whether the previous output chunk ended inside an unterminated OSC (whose
  // BEL terminator must not count as a bell) — see trackBells.
  private inOscForBells = false;
  private bellEscCarry = false;
  private clients = new Map<string, ClientState>();
  private collabMode = true;
  private controllerId: string | null = null;
  private activeClientId: string | null = null;
  private activeCols: number;
  private activeRows: number;
  // Retained raw output as a chunk ring: append is O(1) and trimming drops
  // whole chunks from the head. NEVER joined in full on the hot path — a flat
  // string here meant every chunk past the 20MB cap re-copied the entire
  // buffer (≈3ms of blocked event loop per 2KB chunk, measured), which froze
  // the host for minutes under a busy fleet and got it killed as unresponsive.
  private outputChunks: string[] = [];
  private outputBytes = 0;
  private alternateScreen = false;
  // Enhanced keyboard reporting requested by the remote app (kitty keyboard protocol
  // or xterm modifyOtherKeys). Tracked like alternateScreen so a reattaching client
  // can restore it on its real terminal (see snapshot below).
  private keyboardEnhanced = false;
  // Mouse tracking requested by the remote app (any of ?1000/1002/1003) and
  // whether it asked for SGR encoding (?1006). Snapshotted so a reattaching
  // client can scroll the app with wheel events instead of Page keys.
  private mouseReporting = false;
  private mouseSgr = false;
  private cursorHidden = false;
  private controlSequenceTail = "";
  private oscBuffer = "";
  private cleanupTimer: NodeJS.Timeout | null = null;
  private ended = false;
  private cwdPollTimer: NodeJS.Timeout | null = null;
  // False until the first client attaches: that client is the one whose
  // connect created the room, so its hello carries created=true.
  private hasHadClient = false;

  constructor(id: string, ptyFactory: PtyFactory, initialSize: { cols: number; rows: number }, options: RoomCreateOptions) {
    super();
    this.id = id;
    this.initialCwd = options.cwd;
    this.liveCwd = options.cwd;
    this.pty = ptyFactory({
      cols: initialSize.cols,
      rows: initialSize.rows,
      cwd: options.cwd,
      // Tag every session's environment with its room id so a Claude SessionStart
      // hook can map a running claude conversation back to this hop session (used
      // by `hop restore` to resume the exact conversation per session).
      env: { ...(options.env || {}), HOP_SESSION: id },
      shell: options.shell
    });
    this.activeCols = initialSize.cols;
    this.activeRows = initialSize.rows;

    // Restore replay: pre-load the previous session's tail output so the first
    // client to attach sees the restored screen (via the snapshot) before the
    // fresh shell repaints. This is raw bytes that already happened, so we only
    // stage it into the buffer — we don't re-broadcast or re-parse it.
    if (options.seedOutput) {
      this.appendOutput(options.seedOutput);
    }

    this.pty.onData((data: string) => {
      this.lastActivityAt = now();
      this.appendOutput(data);
      this.updateTerminalState(data);
      this.broadcast({ type: "output", data });
      this.emit("pty_output", { roomId: this.id, data, timestamp: now() });
    });

    const handleExit = (exitCode?: number | null, signal?: number | string) => {
      const normalizedExit = Number.isFinite(exitCode) ? Number(exitCode) : null;
      const normalizedSignal = signal !== undefined && signal !== null ? String(signal) : null;
      console.log(
        `[hay] PTY exit room=${this.id} code=${normalizedExit ?? "null"} signal=${normalizedSignal ?? "null"}`
      );
      // Spurious-exit guard: an exit event with the shell still alive must not
      // end the session — a wrongly `ended` room keeps serving output but its
      // cwd poll and cleanup are permanently dead (observed live: a restored
      // session whose cwd froze for hours while the shell ran fine). If the
      // pid still exists shortly after the event, ignore it.
      const pid = (this.pty as unknown as { pid?: number }).pid;
      const finish = () => this.endSession({
        exitCode: normalizedExit,
        signal: normalizedSignal,
        message: "Session ended"
      });
      if (!pid) {
        finish();
        return;
      }
      setTimeout(() => {
        try {
          process.kill(pid, 0); // throws when the process is gone
          console.log(`[hay] room=${this.id} ignoring spurious exit event (pid ${pid} still alive)`);
        } catch {
          finish();
        }
      }, 150);
    };

    if (typeof this.pty.onExit === "function") {
      this.pty.onExit((event) => {
        handleExit(event.exitCode, event.signal);
      });
    } else {
      // Legacy fallback ONLY when onExit is unavailable — registering both
      // fired every real exit twice.
      const legacyOn = (this.pty as unknown as { on?: (event: string, handler: (...args: any[]) => void) => void }).on;
      if (typeof legacyOn === "function") {
        legacyOn.call(this.pty, "exit", (exitCode: number, signal?: number) => {
          handleExit(exitCode, signal);
        });
      }
    }

    // Start PID-based cwd polling as fallback for shells without OSC 7
    this.startCwdPolling();
  }

  attachClient(info: ClientInfo, socket: SocketAdapter) {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const client = new ClientState(info, socket);
    this.clients.set(client.id, client);
    const created = !this.hasHadClient;
    this.hasHadClient = true;

    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: client.id,
        roomId: this.id,
        color: client.color,
        collabMode: this.collabMode,
        controllerId: this.controllerId,
        created
      } satisfies ServerMessage)
    );

    socket.send(
      JSON.stringify({
        type: "active_size",
        clientId: this.activeClientId ?? client.id,
        cols: this.activeCols,
        rows: this.activeRows
      } satisfies ServerMessage)
    );

    if (this.outputBytes > 0) {
      socket.send(JSON.stringify({
        type: "snapshot",
        data: boundSnapshotReplay(this.tailOutput(
          Number.isFinite(info.replayBytes) && (info.replayBytes as number) > 0
            ? Math.min(SNAPSHOT_REPLAY_BYTES, Math.floor(info.replayBytes as number))
            : SNAPSHOT_REPLAY_BYTES
        )),
        alternateScreen: this.alternateScreen,
        cursorHidden: this.cursorHidden,
        keyboardEnhanced: this.keyboardEnhanced,
        mouseReporting: this.mouseReporting,
        mouseSgr: this.mouseSgr
      } satisfies ServerMessage));
    }

    // The snapshot is a raw byte TAIL, and incremental TUIs (Claude Code/Ink)
    // never re-emit rows that don't change — e.g. the input box's horizontal
    // border lines — so the replay can be missing them. When this client's
    // size differs from the PTY's, the attach resize triggers a full repaint
    // anyway; when sizes are EQUAL nothing would repaint, so nudge: a one-
    // column wiggle (tmux's redraw trick) makes full-screen apps repaint.
    if (
      client.cols === this.activeCols &&
      client.rows === this.activeRows &&
      this.activeCols > 4 &&
      !this.ended
    ) {
      const cols = this.activeCols;
      const rows = this.activeRows;
      try { this.pty.resize(cols - 1, rows); } catch { /* pty may be gone */ }
      setTimeout(() => {
        if (this.ended) return;
        // Only bounce back if nobody claimed a different size meanwhile.
        if (this.activeCols === cols && this.activeRows === rows) {
          try { this.pty.resize(cols, rows); } catch { /* pty may be gone */ }
        }
      }, 60);
    }

    // Send current cwd to the new client
    socket.send(JSON.stringify({
      type: "cwd_changed",
      cwd: this.liveCwd
    } satisfies ServerMessage));

    this.broadcastPresence();

    socket.onMessage((payload) => {
      const message = safeParseClientMessage(payload);
      if (!message) {
        socket.send(JSON.stringify({ type: "error", message: describeInvalidMessage(payload) } satisfies ServerMessage));
        return;
      }
      this.handleMessage(client.id, message);
    });

    socket.onClose(() => {
      this.removeClient(client.id);
    });

    socket.onError(() => {
      this.removeClient(client.id);
    });
  }

  private handleMessage(clientId: string, message: ClientMessage) {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    switch (message.type) {
      case "input":
        this.handleInput(client, message.data);
        break;
      case "resize":
        this.handleResize(client, message.cols, message.rows, message.claim);
        break;
      case "typing":
        client.typing = message.active;
        client.lastActive = now();
        this.broadcastPresence();
        break;
      case "toggle_collab":
        this.collabMode = message.enabled;
        this.controllerId = message.enabled ? null : clientId;
        this.broadcastCollab();
        break;
      case "take_control":
        this.collabMode = false;
        this.controllerId = clientId;
        this.broadcastCollab();
        break;
      case "release_control":
        if (this.controllerId === clientId) {
          this.collabMode = true;
          this.controllerId = null;
          this.broadcastCollab();
        }
        break;
      case "ping":
        client.socket.send(JSON.stringify({ type: "pong", t: message.t } satisfies ServerMessage));
        break;
      case "kill_session":
        this.kill(client.name);
        break;
      default:
        break;
    }
  }

  private updateTerminalState(data: string) {
    const combined = this.controlSequenceTail + data;

    // Parse CSI mode sequences (cursor visibility, alternate screen)
    const regex = /\x1b\[\?([0-9;]*)([hl])/g;
    let match: RegExpExecArray | null;
    let nextAlternate = this.alternateScreen;
    let nextCursorHidden = this.cursorHidden;

    let nextMouseReporting = this.mouseReporting;
    let nextMouseSgr = this.mouseSgr;
    while ((match = regex.exec(combined)) !== null) {
      const params = match[1].split(";").filter(Boolean);
      const mode = match[2];
      for (const param of params) {
        if (param === "25") {
          nextCursorHidden = mode === "l";
        } else if (param === "47" || param === "1047" || param === "1049") {
          nextAlternate = mode === "h";
        } else if (param === "1000" || param === "1002" || param === "1003") {
          // Mouse tracking (any flavor) — lets a reattaching client know it can
          // scroll the app with wheel events instead of coarse Page keys.
          nextMouseReporting = mode === "h";
        } else if (param === "1006") {
          nextMouseSgr = mode === "h";
        }
      }
    }

    // Enhanced keyboard reporting: kitty keyboard protocol (CSI >flags u push /
    // CSI <n u pop / CSI =flags u set) and xterm modifyOtherKeys (CSI >4;n m).
    let nextKeyboardEnhanced = this.keyboardEnhanced;
    const kbdRegex = /\x1b\[([<>=])[0-9;:]*u|\x1b\[>([0-9;]*)m/g;
    let kbdMatch: RegExpExecArray | null;
    while ((kbdMatch = kbdRegex.exec(combined)) !== null) {
      if (kbdMatch[1] !== undefined) {
        nextKeyboardEnhanced = kbdMatch[1] !== "<"; // push/set = on, pop = off
      } else {
        const parts = (kbdMatch[2] ?? "").split(";");
        if (parts[0] === "4") nextKeyboardEnhanced = (parts[1] ?? "0") !== "0";
      }
    }

    let stateChanged = false;
    if (nextMouseReporting !== this.mouseReporting || nextMouseSgr !== this.mouseSgr) {
      this.mouseReporting = nextMouseReporting;
      this.mouseSgr = nextMouseSgr;
      stateChanged = true;
    }
    if (nextAlternate !== this.alternateScreen) {
      if (DEBUG_STATE) {
        console.log(`[hay] room=${this.id} alternateScreen=${nextAlternate}`);
      }
      this.alternateScreen = nextAlternate;
      stateChanged = true;
    }
    if (nextKeyboardEnhanced !== this.keyboardEnhanced) {
      if (DEBUG_STATE) {
        console.log(`[hay] room=${this.id} keyboardEnhanced=${nextKeyboardEnhanced}`);
      }
      this.keyboardEnhanced = nextKeyboardEnhanced;
      stateChanged = true;
    }
    if (nextCursorHidden !== this.cursorHidden) {
      if (DEBUG_STATE) {
        console.log(`[hay] room=${this.id} cursorHidden=${nextCursorHidden}`);
      }
      this.cursorHidden = nextCursorHidden;
      stateChanged = true;
    }

    if (stateChanged) {
      this.emit("pty_state", {
        roomId: this.id,
        alternateScreen: this.alternateScreen,
        cursorHidden: this.cursorHidden,
        timestamp: now()
      });
    }

    // Parse OSC 7 — only scan when ESC is present (fast path: skip most data chunks)
    if (data.includes("\x1b]7;") || this.oscBuffer) {
      this.parseOsc7(data);
    }

    this.trackBells(data);

    this.controlSequenceTail = combined.slice(-CONTROL_SEQUENCE_TAIL);
  }

  // Count attention bells: BEL bytes that are NOT the terminator of an OSC
  // sequence (title updates, OSC 7 cwd reports, clipboard writes all end in
  // BEL and must not register). Tracks OSC state across chunk boundaries; a
  // trailing lone ESC is carried so a split "\x1b]" still opens an OSC.
  private trackBells(data: string) {
    let chunk = data;
    if (this.bellEscCarry) {
      chunk = "\x1b" + chunk;
      this.bellEscCarry = false;
    }
    if (!this.inOscForBells && chunk.indexOf("\x07") === -1) {
      // Fast path: no bell to classify; just keep the cross-chunk OSC state.
      const lastOsc = chunk.lastIndexOf("\x1b]");
      if (lastOsc !== -1) {
        const tail = chunk.slice(lastOsc);
        this.inOscForBells = tail.indexOf("\x07") === -1 && tail.indexOf("\x1b\\") === -1;
      }
      if (chunk.endsWith("\x1b")) this.bellEscCarry = true;
      return;
    }
    let bells = 0;
    let i = 0;
    const len = chunk.length;
    while (i < len) {
      if (this.inOscForBells) {
        const bel = chunk.indexOf("\x07", i);
        const st = chunk.indexOf("\x1b\\", i);
        if (bel === -1 && st === -1) {
          i = len;
          break;
        }
        if (bel !== -1 && (st === -1 || bel < st)) {
          this.inOscForBells = false;
          i = bel + 1;
        } else {
          this.inOscForBells = false;
          i = st + 2;
        }
      } else {
        const bel = chunk.indexOf("\x07", i);
        const osc = chunk.indexOf("\x1b]", i);
        if (bel === -1 && osc === -1) break;
        if (bel !== -1 && (osc === -1 || bel < osc)) {
          bells += 1;
          i = bel + 1;
        } else {
          this.inOscForBells = true;
          i = osc + 2;
        }
      }
    }
    if (!this.inOscForBells && chunk.endsWith("\x1b")) this.bellEscCarry = true;
    if (bells > 0) {
      this.bellSeq += bells;
      this.lastBellAt = now();
      this.emit("bell", { roomId: this.id, bellSeq: this.bellSeq, timestamp: this.lastBellAt });
    }
  }

  // Regex: matches OSC 7 with BEL (\x07) or ST (\x1b\\) terminator
  private static readonly OSC7_RE = /\x1b\]7;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

  private parseOsc7(data: string) {
    const chunk = this.oscBuffer + data;
    this.oscBuffer = "";

    // Fast regex scan — no allocations when there's no match
    Room.OSC7_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = Room.OSC7_RE.exec(chunk)) !== null) {
      this.handleOsc7Uri(match[1]);
    }

    // Check for a partial OSC 7 at the end of the chunk (split across packets)
    const tailIdx = chunk.lastIndexOf("\x1b]7;");
    if (tailIdx !== -1) {
      const tail = chunk.slice(tailIdx);
      // If the regex didn't consume this position, it's incomplete
      if (tail.indexOf("\x07") === -1 && tail.indexOf("\x1b\\") === -1 && tail.length < 512) {
        this.oscBuffer = tail;
      }
    }
  }

  private handleOsc7Uri(uri: string) {
    // Parse file://hostname/path URI
    try {
      let cwdPath: string;
      if (uri.startsWith("file://")) {
        // Extract path portion, skipping hostname
        const withoutScheme = uri.slice(7);
        const slashIdx = withoutScheme.indexOf("/");
        if (slashIdx === -1) return;
        cwdPath = decodeURIComponent(withoutScheme.slice(slashIdx));
      } else if (uri.startsWith("/")) {
        cwdPath = decodeURIComponent(uri);
      } else {
        return;
      }

      if (cwdPath && cwdPath !== this.liveCwd) {
        if (DEBUG_STATE) {
          console.log(`[hay] room=${this.id} cwd=${cwdPath}`);
        }
        this.liveCwd = cwdPath;
        this.broadcast({ type: "cwd_changed", cwd: cwdPath });
        this.emit("cwd_changed", { roomId: this.id, cwd: cwdPath, timestamp: now() });
      }
    } catch {
      // Malformed URI — ignore
    }
  }

  /**
   * Start polling PID-based cwd as fallback for shells that don't emit OSC 7.
   * Uses a long interval to avoid system overhead (lsof is expensive on macOS).
   * OSC 7 parsing is the primary mechanism; this is a best-effort fallback.
   */
  startCwdPolling(intervalMs = 15000) {
    this.stopCwdPolling();
    const pid = (this.pty as unknown as { pid?: number }).pid;
    if (!pid) return;

    const updateCwd = (cwdPath: string) => {
      if (cwdPath && cwdPath !== this.liveCwd) {
        if (DEBUG_STATE) {
          console.log(`[hay] room=${this.id} cwd(poll)=${cwdPath}`);
        }
        this.liveCwd = cwdPath;
        this.broadcast({ type: "cwd_changed", cwd: cwdPath });
        this.emit("cwd_changed", { roomId: this.id, cwd: cwdPath, timestamp: now() });
      }
    };

    const poll = () => {
      if (this.ended) return;
      // node-pty exposes the foreground process name (already short, e.g. "vim",
      // "node", "claude"); cheap getter, sampled on the same cadence as cwd.
      const fg = (this.pty as unknown as { process?: string }).process;
      if (typeof fg === "string" && fg) {
        this.foregroundProcess = fg.replace(/^-/, ""); // strip login-shell "-zsh" dash
      }
      if (process.platform === "darwin") {
        execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 5000 }, (err, stdout) => {
          if (err || !stdout) return;
          for (const line of stdout.split("\n")) {
            if (line.startsWith("n/")) {
              updateCwd(line.slice(1));
              break;
            }
          }
        });
      } else if (process.platform === "linux") {
        readlink(`/proc/${pid}/cwd`, (err, target) => {
          if (err || !target) return;
          updateCwd(target);
        });
      }
    };

    this.cwdPollTimer = setInterval(poll, intervalMs);
    // Initial poll with a generous delay to not interfere with startup
    setTimeout(poll, 3000);
  }

  stopCwdPolling() {
    if (this.cwdPollTimer) {
      clearInterval(this.cwdPollTimer);
      this.cwdPollTimer = null;
    }
  }

  kill(by?: string) {
    this.stopCwdPolling();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    try {
      this.pty.kill();
    } catch (e) {
      /* swallow – PTY may already be dead */
    }
    this.endSession({ exitCode: null, signal: null, message: "Session terminated", by });
  }

  notifySessionRenamed(displayName: string) {
    this.broadcast({ type: "session_renamed", displayName });
  }

  sendSystemInput(data: string, source = "system") {
    if (!data) return;
    this.pty.write(data);
    this.emit("pty_input", {
      roomId: this.id,
      clientId: null,
      actor: "system",
      source,
      data,
      timestamp: now()
    });
  }

  private handleInput(client: ClientState, data: string) {
    if (!this.collabMode && this.controllerId !== client.id) {
      client.socket.send(
        JSON.stringify({ type: "input_rejected", reason: "Control is locked" } satisfies ServerMessage)
      );
      return;
    }
    client.lastActive = now();
    client.lastInputAt = now();
    this.pty.write(data);
    this.emit("pty_input", { roomId: this.id, clientId: client.id, data, timestamp: now() });
  }

  private handleResize(client: ClientState, cols: number, rows: number, claim?: "attach") {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols < 1 || cols > 500 || rows < 1 || rows > 200) return;

    client.cols = cols;
    client.rows = rows;
    // The active PTY size follows whoever is actively typing — not whoever last
    // resized. Previously a resize bumped lastActive and then checked "am I the
    // most active?", which was trivially true for the resizer, so every resize
    // won: a passive viewer resizing their window yanked the size from the
    // active typer, and two differently-sized clients flapped. Elect on typing
    // recency (lastInputAt) instead. A client that has never typed (lastInputAt
    // 0) only wins when no one else has typed either — so the first/sole client
    // can still size the PTY before typing.
    const maxInputAt = Math.max(...[...this.clients.values()].map((c) => c.lastInputAt));
    const othersMaxInputAt = Math.max(
      0,
      ...[...this.clients.values()].filter((c) => c.id !== client.id).map((c) => c.lastInputAt)
    );
    const claimIdleMs = claim === "attach" ? ATTACH_CLAIM_IDLE_MS : RESIZE_CLAIM_IDLE_MS;
    const isActive =
      client.lastInputAt >= maxInputAt || now() - othersMaxInputAt > claimIdleMs;
    if (isActive) {
      this.pty.resize(cols, rows);
      this.activeCols = cols;
      this.activeRows = rows;
      this.activeClientId = client.id;
      // Broadcast the new active size to other clients so they can adjust —
      // and CONFIRM to the winner: a claimant otherwise learns nothing on
      // success and can only distinguish accept from reject by timeout.
      this.broadcastActiveSize(client);
      client.socket.send(
        JSON.stringify({
          type: "active_size",
          clientId: client.id,
          cols,
          rows
        } satisfies ServerMessage)
      );
      this.emit("pty_resize", { roomId: this.id, clientId: client.id, cols, rows, timestamp: now() });
    } else if (cols !== this.activeCols || rows !== this.activeRows) {
      // The resize lost the election (a passive viewer auto-fitted itself).
      // Snap that client back to the shared size — otherwise its local
      // terminal re-wraps the buffer at a size the PTY isn't, and it has no
      // way to learn the real size until the next winning resize.
      client.socket.send(
        JSON.stringify({
          type: "active_size",
          clientId: this.activeClientId ?? client.id,
          cols: this.activeCols,
          rows: this.activeRows
        } satisfies ServerMessage)
      );
    }
  }

  private broadcastActiveSize(client: ClientState) {
    // Broadcast to OTHER clients (not the one typing)
    const payload = JSON.stringify({
      type: "active_size",
      clientId: client.id,
      cols: client.cols,
      rows: client.rows
    } satisfies ServerMessage);
    for (const c of this.clients.values()) {
      if (c.id !== client.id && c.socket.isOpen()) {
        c.socket.send(payload);
      }
    }
  }

  private broadcast(message: ServerMessage) {
    const payload = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.socket.isOpen()) {
        client.socket.send(payload);
      }
    }
  }

  private broadcastPresence() {
    // Monitor tiles are spectators of the UI, not participants — eight live
    // tiles must not read as eight viewers in every session.
    const clients = [...this.clients.values()].filter((c) => c.source !== "monitor").map(toPresence);
    this.broadcast({ type: "presence", clients });
  }

  private broadcastCollab() {
    this.broadcast({ type: "collab", enabled: this.collabMode, controllerId: this.controllerId });
  }

  private removeClient(clientId: string) {
    const wasController = this.controllerId === clientId;
    this.clients.delete(clientId);
    if (wasController && !this.collabMode) {
      this.collabMode = true;
      this.controllerId = null;
      this.broadcastCollab();
    }
    this.broadcastPresence();
    this.scheduleCleanup();
  }

  private scheduleCleanup() {
    if (CLEANUP_DELAY_MS <= 0) {
      return;
    }
    if (this.clients.size > 0 || this.cleanupTimer) {
      return;
    }
    this.cleanupTimer = setTimeout(() => {
      if (this.clients.size === 0) {
        this.pty.kill();
        this.emit("empty");
      }
    }, CLEANUP_DELAY_MS);
  }

  /** O(1) append; trims whole chunks from the head past MAX_BUFFER_SIZE. */
  private appendOutput(data: string) {
    if (!data) return;
    this.outputChunks.push(data);
    this.outputBytes += data.length;
    while (this.outputChunks.length > 1 && this.outputBytes - this.outputChunks[0].length >= MAX_BUFFER_SIZE) {
      this.outputBytes -= this.outputChunks[0].length;
      this.outputChunks.shift();
    }
    // A single chunk larger than the whole cap (giant seed/paste): slice once.
    if (this.outputChunks.length === 1 && this.outputBytes > MAX_BUFFER_SIZE) {
      const only = this.outputChunks[0].slice(this.outputChunks[0].length - MAX_BUFFER_SIZE);
      this.outputChunks[0] = only;
      this.outputBytes = only.length;
    }
  }

  /**
   * Join at most the last maxBytes of retained output. Every consumer
   * (snapshot replay, preview, persistence) needs only a bounded tail, so the
   * full ring is never flattened.
   */
  private tailOutput(maxBytes: number): string {
    if (this.outputBytes === 0 || maxBytes <= 0) return "";
    const cap = Math.min(maxBytes, this.outputBytes);
    const parts: string[] = [];
    let collected = 0;
    for (let i = this.outputChunks.length - 1; i >= 0 && collected < cap; i--) {
      parts.push(this.outputChunks[i]);
      collected += this.outputChunks[i].length;
    }
    parts.reverse();
    const joined = parts.join("");
    return joined.length > cap ? joined.slice(joined.length - cap) : joined;
  }

  private endSession(payload: { exitCode: number | null; signal: string | null; message: string; by?: string }) {
    if (this.ended) return;
    this.ended = true;
    this.stopCwdPolling();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const message = JSON.stringify({ type: "session_ended", ...payload } satisfies ServerMessage);
    for (const client of this.clients.values()) {
      try {
        if (client.socket.isOpen()) {
          client.socket.send(message);
        }
        client.socket.close();
      } catch (e) {
        /* swallow – don't let one bad socket kill the loop */
      }
    }
    this.clients.clear();
    this.emit("session_end", { roomId: this.id, ...payload, timestamp: now() });
    this.emit("empty");
  }

  /**
   * Bounded source for an on-demand screen preview: the terminal's size plus a
   * tail of the raw output (enough to reconstruct the visible screen for the
   * common case of full-repaint TUIs). The actual rendering happens in the
   * daemon, on demand, only when someone is looking — so idle rooms cost nothing.
   */
  getPreviewSource(maxBytes = 65536): { cols: number; rows: number; output: string } {
    return { cols: this.activeCols, rows: this.activeRows, output: this.tailOutput(maxBytes) };
  }

  /**
   * A bounded tail of the raw output, for persisting across a host restart so
   * `hop restore` can replay the last screen of a plain-shell session. Returns
   * an empty string for an empty buffer so callers can skip writing a file.
   */
  getPersistableBuffer(maxBytes = 65536): string {
    return this.tailOutput(maxBytes);
  }

  hasEnded() {
    return this.ended;
  }

  getSummary(): RoomSummary {
    const localCliCount = [...this.clients.values()].filter((client) => client.source === "local-cli").length;
    // Read the foreground process name fresh (cheap getter) so the session
    // manager reflects what's running now; fall back to the last polled sample.
    let foregroundProcess = this.foregroundProcess;
    try {
      const live = (this.pty as unknown as { process?: string }).process;
      if (typeof live === "string" && live) {
        foregroundProcess = live.replace(/^-/, "");
      }
    } catch {
      /* keep the polled fallback */
    }
    return {
      id: this.id,
      cwd: this.initialCwd,
      liveCwd: this.liveCwd,
      foregroundProcess,
      lastActivityAt: this.lastActivityAt,
      bellSeq: this.bellSeq,
      lastBellAt: this.lastBellAt,
      clientCount: [...this.clients.values()].filter((c) => c.source !== "monitor").length,
      localCliCount
    };
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private ptyFactory: PtyFactory;

  constructor(ptyFactory: PtyFactory) {
    this.ptyFactory = ptyFactory;
  }

  getRoom(roomId: string, initialSize: { cols: number; rows: number }, cwdOrOptions: string | RoomCreateOptions) {
    const existing = this.rooms.get(roomId);
    // Never hand out a room that already ended — its poll/cleanup are dead and
    // its pty is (supposed to be) gone. Replace it with a fresh generation.
    if (existing && !existing.hasEnded()) {
      return existing;
    }
    const options = typeof cwdOrOptions === "string"
      ? { cwd: cwdOrOptions }
      : cwdOrOptions;
    if (!options.cwd) {
      throw new Error(`[RoomManager] cwd is required when creating room "${roomId}"`);
    }
    const room = new Room(roomId, this.ptyFactory, initialSize, options);
    room.on("empty", () => {
      // Generation-safe delete: only remove the mapping if it still points at
      // THIS room. A late 'empty' from a dead generation must not evict a
      // freshly created successor under the same id.
      if (this.rooms.get(roomId) === room) {
        this.rooms.delete(roomId);
      }
    });
    this.rooms.set(roomId, room);
    return room;
  }

  hasRoom(roomId: string) {
    return this.rooms.has(roomId);
  }

  closeRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    try {
      room.kill();
    } catch (e) {
      /* swallow – ensure we still remove the room from the map */
    }
    this.rooms.delete(roomId);
  }

  closeAll() {
    for (const roomId of this.rooms.keys()) {
      this.closeRoom(roomId);
    }
  }

  getRoomPreviewSource(id: string, maxBytes?: number) {
    const room = this.rooms.get(id);
    return room ? room.getPreviewSource(maxBytes) : null;
  }

  /**
   * Snapshot every live room's tail buffer for persistence across a host
   * restart. Rooms with no output are omitted. The host script writes these to
   * disk on shutdown; `hop restore` replays them as `seedOutput`.
   */
  getPersistableBuffers(maxBytes?: number): Array<{ id: string; output: string }> {
    const out: Array<{ id: string; output: string }> = [];
    for (const room of this.rooms.values()) {
      const output = room.getPersistableBuffer(maxBytes);
      if (output) out.push({ id: room.id, output });
    }
    return out;
  }

  listRooms(): RoomSummary[] {
    return Array.from(this.rooms.values()).map((room) => room.getSummary());
  }
}
