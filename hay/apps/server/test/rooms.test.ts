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
  it("broadcasts pty output to all clients", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("alpha", { cols: 80, rows: 24 });
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

  it("rejects input when control is locked", () => {
    let ptyInstance: FakePty | null = null;
    const factory: PtyFactory = () => {
      ptyInstance = new FakePty() as unknown as FakePty;
      return ptyInstance as any;
    };

    const manager = new RoomManager(factory);
    const room = manager.getRoom("bravo", { cols: 80, rows: 24 });
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

  it("updates presence on disconnect", () => {
    const manager = new RoomManager(() => new FakePty() as any);
    const room = manager.getRoom("charlie", { cols: 80, rows: 24 });
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();

    room.attachClient({ id: "a", name: "Alex", colorIndex: 0, cols: 80, rows: 24 }, socketA);
    room.attachClient({ id: "b", name: "Blake", colorIndex: 1, cols: 80, rows: 24 }, socketB);

    socketB.close();

    const presenceMessages = findMessages(socketA, "presence");
    const latest = presenceMessages.at(-1) as any;
    expect(latest?.clients).toHaveLength(1);
  });
});
