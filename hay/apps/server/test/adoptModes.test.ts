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

describe("terminal modes across a host restart (pty-keeper adoption)", () => {
  it("an adopted room starts in the saved modes even when the replay no longer holds them", () => {
    const manager = new RoomManager((() => new FakePty()) as unknown as PtyFactory);
    const saved = "\x1b[?1049h\x1b[?1003h\x1b[?1006h";
    const room = manager.adoptRoom("codex", { cols: 80, rows: 24 }, "/tmp", new FakePty(), "just the last screenful", saved);
    expect(room.modePrefix()).toBe(saved);
    // Without the saved modes, the same replay is a plain shell.
    const bare = manager.adoptRoom("other", { cols: 80, rows: 24 }, "/tmp", new FakePty(), "just the last screenful");
    expect(bare.modePrefix()).toBe("");
  });

  it("anything the app changed during the replay wins over the saved modes", () => {
    const manager = new RoomManager((() => new FakePty()) as unknown as PtyFactory);
    const room = manager.adoptRoom("codex", { cols: 80, rows: 24 }, "/tmp", new FakePty(), "bye\x1b[?1049l\x1b[?1003l", "\x1b[?1049h\x1b[?1003h");
    expect(room.modePrefix()).toBe("");
  });
});

describe("the screen grid of an adopted room", () => {
  it("serializes the saved modes even when its hydration tail is shorter than the replay", async () => {
    const { loadScreenGridDeps } = await import("../src/screenGrid");
    expect(await loadScreenGridDeps()).toBe(true);
    const manager = new RoomManager((() => new FakePty()) as unknown as PtyFactory);
    const big = "x".repeat(3_000_000) + "\r\nlast line";
    manager.adoptRoom("codex", { cols: 80, rows: 24 }, "/tmp", new FakePty(), big, "\x1b[?1049h\x1b[?1003h\x1b[?1006h");
    const out = await new Promise<string>((resolve) =>
      manager.serializeRoomScreen("codex", (r) => resolve(r?.data ?? ""), 0));
    expect(out).toContain("\x1b[?1049h");
  });
});
