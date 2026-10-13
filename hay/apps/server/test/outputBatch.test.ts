import { describe, expect, it } from "vitest";
import { RoomManager } from "../src/rooms";
import type { PtyFactory } from "../src/pty";

class FakePty {
  private handlers: Array<(data: string) => void> = [];
  onData(handler: (data: string) => void) { this.handlers.push(handler); }
  onExit() {}
  emit(data: string) { for (const h of this.handlers) h(data); }
  write() {}
  resize() {}
  kill() {}
}
class FakeSocket {
  messages: Array<{ type: string; [k: string]: unknown }> = [];
  send(data: string) { this.messages.push(JSON.parse(data)); }
  onMessage() {}
  onClose() {}
  onError() {}
  isOpen() { return true; }
  close() {}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("live output batching", () => {
  it("pieces of one redraw go out as one message, in order", async () => {
    const pty = new FakePty();
    const room = new RoomManager((() => pty) as unknown as PtyFactory).getRoom("b", { cols: 80, rows: 24 }, "/tmp");
    const sock = new FakeSocket();
    room.attachClient({ id: "a", name: "A", colorIndex: 0, cols: 80, rows: 24, nudge: false }, sock as never);
    await sleep(50);
    sock.messages = [];
    for (const piece of ["\x1b[H", "row one\r\n", "row two\r\n", "\x1b[?25h"]) pty.emit(piece);
    await sleep(30);
    const out = sock.messages.filter((m) => m.type === "output");
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe("\x1b[Hrow one\r\nrow two\r\n\x1b[?25h");
  });

  it("a steady stream still flows (capped wait)", async () => {
    const pty = new FakePty();
    const room = new RoomManager((() => pty) as unknown as PtyFactory).getRoom("s", { cols: 80, rows: 24 }, "/tmp");
    const sock = new FakeSocket();
    room.attachClient({ id: "a", name: "A", colorIndex: 0, cols: 80, rows: 24, nudge: false }, sock as never);
    await sleep(50);
    sock.messages = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 60) { pty.emit("x"); await sleep(1); }
    // Without the cap, pieces 1 ms apart would be held until the stream stopped.
    expect(sock.messages.filter((m) => m.type === "output").length).toBeGreaterThan(1);
  });

  it("output pending when a second viewer attaches reaches the first, and isn't repeated to the second", async () => {
    const pty = new FakePty();
    const room = new RoomManager((() => pty) as unknown as PtyFactory).getRoom("j", { cols: 80, rows: 24 }, "/tmp");
    const first = new FakeSocket();
    room.attachClient({ id: "a", name: "A", colorIndex: 0, cols: 80, rows: 24, nudge: false }, first as never);
    await sleep(50);
    first.messages = [];
    pty.emit("PENDING-BEFORE-JOIN");
    const second = new FakeSocket();
    room.attachClient({ id: "b", name: "B", colorIndex: 1, cols: 80, rows: 24, nudge: false }, second as never);
    expect(first.messages.some((m) => m.type === "output" && String(m.data).includes("PENDING-BEFORE-JOIN"))).toBe(true);
    await sleep(50);
    expect(second.messages.some((m) => m.type === "output" && String(m.data).includes("PENDING-BEFORE-JOIN"))).toBe(false);
  });
});
