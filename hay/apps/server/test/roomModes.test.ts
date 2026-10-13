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

describe("terminal modes a room remembers", () => {
  it("a room reports the DEC modes its app set, alternate screen first", () => {
    const pty = new FakePty();
    const manager = new RoomManager((() => pty) as unknown as PtyFactory);
    const room = manager.getRoom("codex", { cols: 80, rows: 24 }, "/tmp");
    const seen: string[] = [];
    room.on("modes", (p: string) => seen.push(p));
    pty.emit("\x1b[?2004h\x1b[?1004h\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?25l hello");
    expect(room.modePrefix()).toBe("\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?1003h\x1b[?1006h\x1b[?25l");
    expect(seen.at(-1)).toBe(room.modePrefix());
    pty.emit("\x1b[?1003l\x1b[?1049l");
    expect(room.modePrefix()).toBe("\x1b[?2004h\x1b[?1004h\x1b[?1006h\x1b[?25l");
    pty.emit("\x1bc");
    expect(room.modePrefix()).toBe("");
  });
});
