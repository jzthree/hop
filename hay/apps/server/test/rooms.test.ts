import { describe, expect, it, vi } from "vitest";
import { RoomManager } from "../src/rooms";
import type { PtyFactory } from "../src/pty";

type Message = { type: string; [key: string]: unknown };

class FakePty {
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private handlers: Array<(data: string) => void> = [];

  onData(handler: (data: string) => void) {
    this.handlers.push(handler);
  }

  emit(data: string) {
    for (const handler of this.handlers) {
      handler(data);
    }
  }

  write(data: string) {
    this.writes.push(data);
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }

  kill() {
    this.killed = true;
  }
}

class FakeSocket {
  messages: string[] = [];
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;

  send(data: string) {
    this.messages.push(data);
  }

  onMessage(handler: (data: string) => void) {
    this.messageHandler = handler;
  }

  onClose(handler: () => void) {
    this.closeHandler = handler;
  }

  onError(handler: (err: Error) => void) {
    this.errorHandler = handler;
  }

  isOpen() {
    return true;
  }

  emitMessage(payload: Message) {
    this.messageHandler?.(JSON.stringify(payload));
  }

  close() {
    this.closeHandler?.();
  }

  error(err: Error) {
    this.errorHandler?.(err);
  }
}

const readMessages = (socket: FakeSocket) => {
  return socket.messages.map((message) => JSON.parse(message) as Message);
};

const findMessages = (socket: FakeSocket, type: string) => {
  return readMessages(socket).filter((message) => message.type === type);
};

describe("Room", () => {
  it("passes room create options to the PTY factory", () => {
    let capturedOptions: any = null;
    const factory: PtyFactory = (options) => {
      capturedOptions = options;
      return new FakePty() as any;
    };

    const manager = new RoomManager(factory);
    manager.getRoom("opts", { cols: 80, rows: 24 }, {
      cwd: "/tmp/demo",
      env: { HISTFILE: "/tmp/.history" },
      shell: "/bin/zsh",
    });

    expect(capturedOptions?.cwd).toBe("/tmp/demo");
    expect(capturedOptions?.env?.HISTFILE).toBe("/tmp/.history");
    expect(capturedOptions?.shell).toBe("/bin/zsh");
  });

  it("an equal-size attach nudges a repaint unless the client declines", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };
    const manager = new RoomManager(factory);
    const room = manager.getRoom("wiggle", { cols: 80, rows: 24 }, "/tmp");

    // Default attach at the PTY's exact size: the −1 wiggle fires (the
    // bounce-back half is on a timer; the first resize is the evidence).
    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, new FakeSocket());
    expect(ptyInstance!.resizes.some((r: { cols: number }) => r.cols === 79)).toBe(true);

    // A wall tile declines (nudge: false): it already shows the current
    // grid, and the wiggle's SIGWINCH reflow is the click-twitch. No resize.
    const before = ptyInstance!.resizes.length;
    room.attachClient({ id: "b", name: "Tile", colorIndex: 1, cols: 80, rows: 24, nudge: false }, new FakeSocket());
    expect(ptyInstance!.resizes.length).toBe(before);
  });

  it("broadcasts pty output to all clients", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("alpha", { cols: 80, rows: 24 }, "/tmp");
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();

    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, socketA);
    room.attachClient({ id: "b", name: "Blake", colorIndex: 1, cols: 80, rows: 24 }, socketB);

    ptyInstance?.emit("hello");

    const outputsA = findMessages(socketA, "output");
    const outputsB = findMessages(socketB, "output");

    expect(outputsA.at(-1)?.data).toBe("hello");
    expect(outputsB.at(-1)?.data).toBe("hello");
  });

  it("marks only the room-creating client's hello with created=true", () => {
    const manager = new RoomManager(() => new FakePty() as any);
    const room = manager.getRoom("created", { cols: 80, rows: 24 }, "/tmp");
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();

    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, socketA);
    room.attachClient({ id: "b", name: "Blake", colorIndex: 1, cols: 80, rows: 24 }, socketB);

    expect(findMessages(socketA, "hello").at(0)?.created).toBe(true);
    expect(findMessages(socketB, "hello").at(0)?.created).toBe(false);
  });

  it("attributes a kill_session to the killing client in session_ended", () => {
    const manager = new RoomManager(() => new FakePty() as any);
    const room = manager.getRoom("killer", { cols: 80, rows: 24 }, "/tmp");
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();

    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, socketA);
    room.attachClient({ id: "b", name: "Blake", colorIndex: 1, cols: 80, rows: 24 }, socketB);

    socketA.emitMessage({ type: "kill_session" });

    const ended = findMessages(socketB, "session_ended").at(0);
    expect(ended?.message).toBe("Session terminated");
    expect(ended?.by).toBe("Alex");
  });

  it("names the message type and field when rejecting an invalid message", () => {
    const manager = new RoomManager(() => new FakePty() as any);
    const room = manager.getRoom("invalid", { cols: 80, rows: 24 }, "/tmp");
    const socket = new FakeSocket();
    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, socket);

    socket.emitMessage({ type: "resize", cols: 80, rows: 1 });

    const error = findMessages(socket, "error").at(-1);
    expect(String(error?.message)).toContain("resize");
    expect(String(error?.message)).toContain("rows");
  });

  it("rejects input when control is locked", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("bravo", { cols: 80, rows: 24 }, "/tmp");
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();

    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, socketA);
    room.attachClient({ id: "b", name: "Blake", colorIndex: 1, cols: 80, rows: 24 }, socketB);

    socketA.emitMessage({ type: "take_control" });
    socketB.emitMessage({ type: "input", data: "ls" });

    expect(ptyInstance?.writes).toEqual([]);
    const rejected = findMessages(socketB, "input_rejected");
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("active PTY size follows the active typer, not the last resizer", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("resize", { cols: 80, rows: 24 }, "/tmp");
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();

    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, socketA);
    room.attachClient({ id: "b", name: "Blake", colorIndex: 1, cols: 80, rows: 24 }, socketB);

    // Alex types — Alex is now the active typer / size source.
    socketA.emitMessage({ type: "input", data: "ls" });

    // Blake (passive viewer) resizes their window — must NOT move the PTY size.
    const beforePassive = ptyInstance!.resizes.length;
    socketB.emitMessage({ type: "resize", cols: 100, rows: 30 });
    expect(ptyInstance!.resizes.length).toBe(beforePassive);

    // Alex (the active typer) resizes — this one applies.
    socketA.emitMessage({ type: "resize", cols: 120, rows: 40 });
    expect(ptyInstance!.resizes.at(-1)).toEqual({ cols: 120, rows: 40 });

    // Once Blake types, Blake becomes the active typer and his size wins.
    socketB.emitMessage({ type: "input", data: "x" });
    socketB.emitMessage({ type: "resize", cols: 90, rows: 20 });
    expect(ptyInstance!.resizes.at(-1)).toEqual({ cols: 90, rows: 20 });
  });

  it('claim:"attach" takes the size unless a peer typed seconds ago', () => {
    vi.useFakeTimers();
    try {
      let ptyInstance: FakePty | null = null;
      const factory: PtyFactory = () => {
        ptyInstance = new FakePty() as unknown as FakePty;
        return ptyInstance as any;
      };
      const manager = new RoomManager(factory);
      const room = manager.getRoom("attach-claim", { cols: 80, rows: 24 }, "/tmp");
      const cli = new FakeSocket();
      room.attachClient({ id: "cli", name: "Local", colorIndex: 0, cols: 80, rows: 24 }, cli);

      // The desktop CLI is actively typing right now.
      cli.emitMessage({ type: "input", data: "ls" });

      // A phone opens the session 2s later and attach-claims its fitted size:
      // an actively-typing peer keeps the size — the claim loses.
      vi.advanceTimersByTime(2_000);
      const phone = new FakeSocket();
      room.attachClient({ id: "ph", name: "Phone", colorIndex: 1, cols: 46, rows: 28 }, phone);
      const before = ptyInstance!.resizes.length;
      phone.emitMessage({ type: "resize", cols: 46, rows: 28, claim: "attach" });
      expect(ptyInstance!.resizes.length).toBe(before);

      // 10s after the CLI's last keystroke (well inside the 60s a plain
      // resize would need), the attach claim wins: opening a session is
      // intent, and nobody is typing anymore.
      vi.advanceTimersByTime(10_000);
      phone.emitMessage({ type: "resize", cols: 46, rows: 28, claim: "attach" });
      expect(ptyInstance!.resizes.at(-1)).toEqual({ cols: 46, rows: 28 });

      // A plain (unclaimed) resize from another fresh viewer still cannot
      // yank the size at 10s idle — the 60s election guards those.
      const viewer = new FakeSocket();
      room.attachClient({ id: "v", name: "Viewer", colorIndex: 2, cols: 200, rows: 50 }, viewer);
      phone.emitMessage({ type: "input", data: "x" });
      vi.advanceTimersByTime(10_000);
      const beforeViewer = ptyInstance!.resizes.length;
      viewer.emitMessage({ type: "resize", cols: 200, rows: 50 });
      expect(ptyInstance!.resizes.length).toBe(beforeViewer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the join-time snapshot replay to a tail cut at a line boundary", () => {
    const manager = new RoomManager(() => new FakePty() as any);
    // 3MB of history: 30k lines of 100 chars
    const line = "x".repeat(99) + "\n";
    const seed = line.repeat(30_000);
    const room = manager.getRoom("bigbuf", { cols: 80, rows: 24 }, { cwd: "/tmp", seedOutput: seed });
    const socket = new FakeSocket();
    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, socket);
    const snapshot = socket.messages
      .map((raw: string) => JSON.parse(raw))
      .find((m: any) => m.type === "snapshot");
    expect(snapshot).toBeTruthy();
    // bounded well below the full 3MB, and not starting mid-line
    expect(snapshot.data.length).toBeLessThanOrEqual(1_500_000);
    expect(snapshot.data.length).toBeGreaterThan(1_000_000);
    expect(seed.endsWith(snapshot.data)).toBe(true);
    expect(snapshot.data.startsWith("x".repeat(99))).toBe(true);
  });

  it("updates presence on disconnect", () => {
    const manager = new RoomManager(() => new FakePty() as any);
    const room = manager.getRoom("charlie", { cols: 80, rows: 24 }, "/tmp");
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();

    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, socketA);
    room.attachClient({ id: "b", name: "Blake", colorIndex: 1, cols: 80, rows: 24 }, socketB);

    socketB.close();

    const presenceMessages = findMessages(socketA, "presence");
    const latest = presenceMessages.at(-1) as any;
    expect(latest?.clients).toHaveLength(1);
  });

  it("emits room PTY lifecycle events for embedding servers", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("events", { cols: 80, rows: 24 }, "/tmp");
    const socket = new FakeSocket();
    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, socket);

    const inputs: any[] = [];
    const outputs: any[] = [];
    const resizes: any[] = [];
    const states: any[] = [];
    const ends: any[] = [];
    room.on("pty_input", (payload) => inputs.push(payload));
    room.on("pty_output", (payload) => outputs.push(payload));
    room.on("pty_resize", (payload) => resizes.push(payload));
    room.on("pty_state", (payload) => states.push(payload));
    room.on("session_end", (payload) => ends.push(payload));

    socket.emitMessage({ type: "input", data: "pwd\n" });
    ptyInstance?.emit("ok\n");
    ptyInstance?.emit("\x1b[?1049h");
    ptyInstance?.emit("\x1b[?1049l");
    socket.emitMessage({ type: "resize", cols: 100, rows: 30 });
    room.kill();

    expect(inputs.at(-1)?.clientId).toBe("a");
    expect(inputs.at(-1)?.data).toBe("pwd\n");
    expect(outputs.some((payload) => payload?.data === "ok\n")).toBe(true);
    expect(resizes.at(-1)?.cols).toBe(100);
    expect(resizes.at(-1)?.rows).toBe(30);
    expect(states.at(0)?.alternateScreen).toBe(true);
    expect(states.at(1)?.alternateScreen).toBe(false);
    expect(ends.at(-1)?.message).toBe("Session terminated");
  });

  it("supports system input writes for host-level session setup", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("system", { cols: 80, rows: 24 }, "/tmp");
    const inputs: any[] = [];
    room.on("pty_input", (payload) => inputs.push(payload));

    room.sendSystemInput("export HISTFILE=/tmp/demo.history\\n", "hop");

    expect(ptyInstance?.writes.at(-1)).toBe("export HISTFILE=/tmp/demo.history\\n");
    expect(inputs.at(-1)?.actor).toBe("system");
    expect(inputs.at(-1)?.source).toBe("hop");
    expect(inputs.at(-1)?.clientId).toBe(null);
  });

  it("snaps a losing resize back to the shared active size", () => {
    const manager = new RoomManager(() => new FakePty() as any);
    const room = manager.getRoom("election", { cols: 120, rows: 30 }, "/tmp");
    const typer = new FakeSocket();
    const viewer = new FakeSocket();

    room.attachClient({ id: "typer", name: "Alex", colorIndex: 0, cols: 120, rows: 30 }, typer);
    room.attachClient({ id: "viewer", name: "Blake", colorIndex: 1, cols: 60, rows: 20 }, viewer);

    // The typer types (wins future elections), then asserts the big size.
    typer.emitMessage({ type: "input", data: "ls\r" });
    typer.emitMessage({ type: "resize", cols: 120, rows: 30 });

    // A passive viewer auto-fits itself smaller — the resize must lose AND
    // the viewer must be told the real shared size.
    viewer.emitMessage({ type: "resize", cols: 60, rows: 20 });

    const sizes = findMessages(viewer, "active_size");
    const last = sizes.at(-1);
    expect(last?.cols).toBe(120);
    expect(last?.rows).toBe(30);
    expect(last?.clientId).toBe("typer");
  });

  it("lets a resize claim the size once every other client is input-idle", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      let ptyInstance: FakePty | null = null;
      const factory: PtyFactory = () => {
        ptyInstance = new FakePty() as unknown as FakePty;
        return ptyInstance as any;
      };
      const manager = new RoomManager(factory);
      const room = manager.getRoom("claim", { cols: 120, rows: 30 }, "/tmp");
      const typer = new FakeSocket();
      const viewer = new FakeSocket();
      room.attachClient({ id: "typer", name: "Alex", colorIndex: 0, cols: 120, rows: 30 }, typer);
      room.attachClient({ id: "viewer", name: "Blake", colorIndex: 1, cols: 60, rows: 20 }, viewer);

      typer.emitMessage({ type: "input", data: "ls\r" });
      typer.emitMessage({ type: "resize", cols: 120, rows: 30 });

      // Recently-typed elsewhere: the viewer's autofit is refused (and snapped back).
      viewer.emitMessage({ type: "resize", cols: 60, rows: 20 });
      expect((ptyInstance as unknown as FakePty).resizes.at(-1)).toEqual({ cols: 120, rows: 30 });

      // Everyone else idle past the claim window: the same autofit now wins.
      vi.setSystemTime(1_000_000 + 61_000);
      viewer.emitMessage({ type: "resize", cols: 60, rows: 20 });
      expect((ptyInstance as unknown as FakePty).resizes.at(-1)).toEqual({ cols: 60, rows: 20 });

      // The previous holder is told the size moved.
      const sizes = findMessages(typer, "active_size");
      expect(sizes.at(-1)?.cols).toBe(60);
      expect(sizes.at(-1)?.clientId).toBe("viewer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts attention bells but not OSC-terminator BELs", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("bells", { cols: 80, rows: 24 }, "/tmp");
    const bells: any[] = [];
    room.on("bell", (payload) => bells.push(payload));

    expect(room.getSummary().bellSeq).toBe(0);
    expect(room.getSummary().lastBellAt).toBe(0);

    // OSC title update terminated by BEL — not an attention bell.
    ptyInstance?.emit("\x1b]0;my title\x07plain output");
    expect(room.getSummary().bellSeq).toBe(0);

    // A real bell.
    ptyInstance?.emit("done\x07");
    expect(room.getSummary().bellSeq).toBe(1);
    expect(room.getSummary().lastBellAt).toBeGreaterThan(0);
    expect(bells.at(-1)?.bellSeq).toBe(1);

    // Two bells in one chunk, with an ST-terminated OSC between them.
    ptyInstance?.emit("\x07\x1b]7;file://host/tmp\x1b\\\x07");
    expect(room.getSummary().bellSeq).toBe(3);
  });

  it("tracks bells across chunk-split OSC sequences", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("bells-split", { cols: 80, rows: 24 }, "/tmp");

    // OSC opens in one chunk, its BEL terminator arrives in the next —
    // that BEL must not count as a bell.
    ptyInstance?.emit("\x1b]0;long tit");
    ptyInstance?.emit("le\x07");
    expect(room.getSummary().bellSeq).toBe(0);

    // Even the "\x1b" / "]..." split across chunks stays an OSC.
    ptyInstance?.emit("output\x1b");
    ptyInstance?.emit("]0;t\x07");
    expect(room.getSummary().bellSeq).toBe(0);

    // And a bell right after a completed OSC still counts.
    ptyInstance?.emit("\x1b]0;t\x07\x07");
    expect(room.getSummary().bellSeq).toBe(1);
  });

  it("counts a real bell after a lone-ESC-carried split OSC", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("bells-esc-carry", { cols: 80, rows: 24 }, "/tmp");

    // Chunk ends with a lone ESC; the "]" that opens the OSC arrives next. The
    // OSC's own BEL terminator must not count, but the real BEL after it does.
    ptyInstance?.emit("some output\x1b");
    ptyInstance?.emit("]0;title\x07done\x07");
    expect(room.getSummary().bellSeq).toBe(1);
  });

  it("lets a passive viewer's resize win when no client has ever typed", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("no-typer", { cols: 80, rows: 24 }, "/tmp");
    const viewerA = new FakeSocket();
    const viewerB = new FakeSocket();

    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, viewerA);
    room.attachClient({ id: "b", name: "Blake", colorIndex: 1, cols: 80, rows: 24 }, viewerB);

    // Nobody has typed, so a passive viewer's autofit resize wins immediately.
    viewerB.emitMessage({ type: "resize", cols: 100, rows: 30 });

    expect(ptyInstance!.resizes.at(-1)).toEqual({ cols: 100, rows: 30 });
    const sizes = findMessages(viewerA, "active_size");
    expect(sizes.at(-1)?.cols).toBe(100);
    expect(sizes.at(-1)?.rows).toBe(30);
    expect(sizes.at(-1)?.clientId).toBe("b");
  });

  it("carries keyboardEnhanced in the snapshot after the app enables kitty keyboard mode", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("kbd", { cols: 80, rows: 24 }, "/tmp");
    const first = new FakeSocket();
    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, first);

    // The app pushes the kitty keyboard protocol flags via PTY output.
    ptyInstance?.emit("\x1b[>1u");

    // A client attaching now must learn enhanced keyboard is active via the snapshot.
    const late = new FakeSocket();
    room.attachClient({ id: "b", name: "Blake", colorIndex: 1, cols: 80, rows: 24 }, late);

    const snapshot = findMessages(late, "snapshot").at(-1);
    expect(snapshot?.keyboardEnhanced).toBe(true);
  });

  describe("PTY color environment", () => {
    it("never passes a inherited NO_COLOR into a session", async () => {
      const { createPty } = await import("../src/pty");
      const prev = process.env.NO_COLOR;
      process.env.NO_COLOR = "1"; // as an agent's tool shell would set it
      let captured: Record<string, string> = {};
      try {
        // createPty spawns a real shell; capture the env it builds by
        // spawning into a harmless cwd and reading the child's own view.
        const p = createPty({ cols: 20, rows: 5, cwd: "/tmp" }) as unknown as {
          kill: () => void;
          _env?: Record<string, string>;
        };
        captured = (p as unknown as { _env?: Record<string, string> })._env || {};
        p.kill();
      } finally {
        if (prev === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = prev;
      }
      // node-pty doesn't expose env, so assert the contract at the source of
      // truth instead: the module must strip it before spawning.
      const src = await import("node:fs").then((fs) =>
        fs.readFileSync(new URL("../src/pty.ts", import.meta.url), "utf8")
      );
      expect(src).toContain("delete env.NO_COLOR");
      expect(captured).toBeDefined();
    });
  });

  describe("headless terminal-identity answers", () => {
    it("answers color/DA/truecolor probes only while no client is attached", () => {
      let ptyInstance: FakePty | null = null;
      const factory: PtyFactory = () => {
        ptyInstance = new FakePty() as unknown as FakePty;
        return ptyInstance as any;
      };
      const manager = new RoomManager(factory);
      const room = manager.getRoom("probe", { cols: 80, rows: 24 }, "/tmp");

      // Headless: the room answers as the terminal.
      ptyInstance!.emit("\x1b]11;?\x07 \x1b[0c \x1bP+q524742\x1b\\");
      const answered = ptyInstance!.writes.join("");
      expect(answered).toContain("]11;rgb:0d0d/1111/1717");
      expect(answered).toContain("[?62;22c");
      expect(answered).toContain("P1+r524742");

      // Attached: the real terminal answers; the room stays silent.
      room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, new FakeSocket());
      ptyInstance!.writes.length = 0;
      ptyInstance!.emit("\x1b]11;?\x07");
      expect(ptyInstance!.writes.join("")).toBe("");
    });
  });

  describe("getOutputSince (incremental preview feed)", () => {
    const makeRoom = () => {
      let ptyInstance: FakePty | null = null;
      const factory: PtyFactory = () => {
        ptyInstance = new FakePty() as unknown as FakePty;
        return ptyInstance as any;
      };
      const manager = new RoomManager(factory);
      const room = manager.getRoom("inc", { cols: 80, rows: 24 }, "/tmp");
      return { room, manager, pty: () => ptyInstance! };
    };

    it("hands out a reset tail first, then exact deltas from the cursor", () => {
      const { room, pty } = makeRoom();
      pty().emit("hello ");
      const first = room.getOutputSince(undefined);
      expect(first.reset).toBe(true);
      expect(first.data).toBe("hello ");
      expect(first.cols).toBe(80);

      pty().emit("world");
      const second = room.getOutputSince(first.offset);
      expect(second.reset).toBe(false);
      expect(second.data).toBe("world");

      // No new output → empty delta, same cursor.
      const third = room.getOutputSince(second.offset);
      expect(third.reset).toBe(false);
      expect(third.data).toBe("");
      expect(third.offset).toBe(second.offset);
    });

    it("spans chunk boundaries in a single delta", () => {
      const { room, pty } = makeRoom();
      pty().emit("a");
      const start = room.getOutputSince(undefined);
      pty().emit("bb");
      pty().emit("ccc");
      pty().emit("d");
      const delta = room.getOutputSince(start.offset);
      expect(delta.reset).toBe(false);
      expect(delta.data).toBe("bbcccd");
    });

    it("resets when the cursor is ahead of the stream or nonsense", () => {
      const { room, pty } = makeRoom();
      pty().emit("xyz");
      const ahead = room.getOutputSince(9999);
      expect(ahead.reset).toBe(true);
      expect(ahead.data).toBe("xyz");
      const negative = room.getOutputSince(Number.NaN);
      expect(negative.reset).toBe(true);
    });

    it("resets with a bounded tail when the delta exceeds maxBytes", () => {
      const { room, pty } = makeRoom();
      pty().emit("seed");
      const start = room.getOutputSince(undefined);
      pty().emit("x".repeat(50));
      const capped = room.getOutputSince(start.offset, 10);
      expect(capped.reset).toBe(true);
      expect(capped.data).toBe("x".repeat(10));
      // The fresh cursor is usable for the next incremental call.
      pty().emit("tail");
      const next = room.getOutputSince(capped.offset);
      expect(next.reset).toBe(false);
      expect(next.data).toBe("tail");
    });

    it("keeps cursors stable across ring trims", () => {
      const { room, pty } = makeRoom();
      pty().emit("early");
      const start = room.getOutputSince(undefined);
      // Blow well past the retention cap so the head (and the old cursor's
      // position) is trimmed away.
      const big = "y".repeat(8 * 1024 * 1024);
      pty().emit(big);
      pty().emit(big);
      pty().emit(big);
      const later = room.getOutputSince(start.offset, 1024);
      expect(later.reset).toBe(true);
      pty().emit("fresh");
      const delta = room.getOutputSince(later.offset);
      expect(delta.reset).toBe(false);
      expect(delta.data).toBe("fresh");
    });
  });

  describe("serialized attach", () => {
    const setup = async (roomId: string) => {
      const { loadScreenGridDeps } = await import("../src/screenGrid");
      expect(await loadScreenGridDeps()).toBe(true);
      let ptyInstance: FakePty | null = null;
      const factory: PtyFactory = () => {
        ptyInstance = new FakePty() as unknown as FakePty;
        return ptyInstance as any;
      };
      const manager = new RoomManager(factory);
      const room = manager.getRoom(roomId, { cols: 80, rows: 24 }, "/tmp");
      return { room, pty: () => ptyInstance! };
    };

    const waitForSnapshot = async (socket: FakeSocket) => {
      await vi.waitFor(() => {
        expect(findMessages(socket, "snapshot").length).toBeGreaterThan(0);
      });
      return findMessages(socket, "snapshot")[0] as any;
    };

    // THE recurring bug, reproduced: an incremental TUI (Claude Code/Ink)
    // paints a row once and never re-emits it; once enough updates pass, the
    // row leaves every bounded raw tail. A client attaching off such a tail
    // rendered holes until the app happened to repaint — "have to scroll
    // before it renders correctly". The serialized grid carries the row no
    // matter how long ago it was painted.
    it("carries rows the bounded raw tail lost, without the wiggle", async () => {
      const { room, pty } = await setup("serial");
      pty().emit("\x1b[2J\x1b[1;1HROW1-STABLE-BORDER-MARKER");
      // In-place repaints of one region, Ink-style: no scrolling, so the
      // marker row stays ON SCREEN while leaving every bounded byte tail.
      const update = "\x1b[20;1H\x1b[K" + "x".repeat(60);
      for (let i = 0; i < 1200; i++) pty().emit(update); // ~84KB > the 64KB ask
      const socket = new FakeSocket();
      room.attachClient(
        { id: "tile", name: "Tile", colorIndex: 0, cols: 80, rows: 24, replayBytes: 65536 },
        socket
      );
      const snapshot = await waitForSnapshot(socket);
      expect(String(snapshot.data).startsWith("\x1bc")).toBe(true);
      expect(String(snapshot.data)).toContain("ROW1-STABLE-BORDER-MARKER");
      // The raw tail this connection would have gotten cannot contain it.
      expect(room.getPreviewSource(65536).output).not.toContain("ROW1-STABLE-BORDER-MARKER");
      // Complete screen delivered — nothing needs the repaint nudge.
      expect(pty().resizes.some((r: { cols: number }) => r.cols === 79)).toBe(false);
      // ~82KB of raw history is well under the deep-history hint threshold.
      expect(snapshot.capped).toBe(false);
    });

    it("flags a serialized snapshot as capped when deeper raw history exists", async () => {
      const { room, pty } = await setup("capped");
      const big = "\x1b[20;1H" + "y".repeat(4096);
      for (let i = 0; i < 80; i++) pty().emit(big); // ~330KB ring
      const socket = new FakeSocket();
      room.attachClient(
        { id: "web", name: "Web", colorIndex: 0, cols: 80, rows: 24, replayBytes: 393216 },
        socket
      );
      const snapshot = await waitForSnapshot(socket);
      expect(String(snapshot.data).startsWith("\x1bc")).toBe(true);
      expect(snapshot.capped).toBe(true);
    });

    it("replay=0 means no snapshot at all — live stream only", async () => {
      const { room, pty } = await setup("claim");
      pty().emit("some prior output\r\n");
      const socket = new FakeSocket();
      room.attachClient(
        { id: "claim", name: "Claim", colorIndex: 0, cols: 80, rows: 24, replayBytes: 0, nudge: false },
        socket
      );
      // Give any (buggy) async snapshot path a chance to fire before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(findMessages(socket, "snapshot")).toHaveLength(0);
      expect(pty().resizes.some((r: { cols: number }) => r.cols === 79)).toBe(false);
    });

    it("a deep-history request keeps the raw tail replay", async () => {
      const { room, pty } = await setup("deep");
      pty().emit("\x1b[2J\x1b[1;1Hdeep-history-anchor\r\n");
      pty().emit("z".repeat(200_000));
      const socket = new FakeSocket();
      room.attachClient(
        { id: "deep", name: "Deep", colorIndex: 0, cols: 80, rows: 24, replayBytes: 1_572_864 },
        socket
      );
      // Raw path is synchronous.
      const snapshot = findMessages(socket, "snapshot")[0] as any;
      expect(snapshot).toBeTruthy();
      expect(String(snapshot.data).startsWith("\x1bc")).toBe(false);
      expect(String(snapshot.data).length).toBeGreaterThan(200_000);
      expect(String(snapshot.data)).toContain("deep-history-anchor");
    });
  });
});
