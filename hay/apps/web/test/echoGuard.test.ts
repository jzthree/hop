import { describe, expect, it } from "vitest";
import { remoteAppOwnsScreen, SYNC_OUTPUT_FRESH_MS } from "../src/utils/echoGuard";

const shell = { altScreen: false, mouseReporting: false, scrollRegion: false, syncOutputSeenAt: 0 };

describe("optimistic echo guard", () => {
  it("a plain shell gets local echo", () => {
    expect(remoteAppOwnsScreen(shell, 1_000_000)).toBe(false);
  });
  it("the alternate screen (Claude Code, vim) suppresses it", () => {
    expect(remoteAppOwnsScreen({ ...shell, altScreen: true }, 1_000_000)).toBe(true);
  });
  it("Codex's normal-screen TUI suppresses it too: scroll region, sync frames, or mouse reporting", () => {
    expect(remoteAppOwnsScreen({ ...shell, scrollRegion: true }, 1_000_000)).toBe(true);
    expect(remoteAppOwnsScreen({ ...shell, mouseReporting: true }, 1_000_000)).toBe(true);
    expect(remoteAppOwnsScreen({ ...shell, syncOutputSeenAt: 999_000 }, 1_000_000)).toBe(true);
  });
  it("a synchronized-output frame ages out once the app is gone", () => {
    expect(remoteAppOwnsScreen({ ...shell, syncOutputSeenAt: 1_000_000 }, 1_000_000 + SYNC_OUTPUT_FRESH_MS + 1)).toBe(false);
  });
});
