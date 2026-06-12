import { describe, expect, it } from "vitest";
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
});
