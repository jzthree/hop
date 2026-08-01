import { describe, expect, it } from "vitest";
import { isClaudeSurface } from "../src/utils/voiceHold";

// A fake xterm buffer showing the given visible rows.
const term = (rows: string[]) => ({
  rows: rows.length,
  buffer: {
    active: {
      baseY: 0,
      getLine: (row: number) =>
        rows[row] === undefined ? undefined : { translateToString: () => rows[row] }
    }
  }
});

const CLAUDE_SCREEN = [
  "> summarize this file",
  "",
  "⏵⏵ bypass permissions on (shift+tab to cycle)"
];
const SHELL_SCREEN = ["jianzhou@MED-GEN-ML-15 hop2 % ls", "hop  hay  scripts", "jianzhou@MED-GEN-ML-15 hop2 %"];

describe("isClaudeSurface", () => {
  it("trusts the foreground process when it names Claude", () => {
    expect(isClaudeSurface(true, null)).toBe(true);
    expect(isClaudeSurface(true, term(SHELL_SCREEN) as never)).toBe(true);
  });

  // THE regression: `hop restore` launches Claude as the room's argv
  // (`shell -lc "claude …; exec shell -l"`), so the room reports the WRAPPER
  // SHELL as its foreground process for the rest of the session's life. A
  // process-only check therefore reads false on every restored session —
  // which silently disabled Shift+Enter (CSI 13;2u) in wall tiles, turning
  // every newline attempt into a submit.
  it("still recognizes Claude when the process check is blind (restored session)", () => {
    expect(isClaudeSurface(false, term(CLAUDE_SCREEN) as never)).toBe(true);
  });

  it("stays false for a plain shell, where raw CSI-u would render as junk", () => {
    expect(isClaudeSurface(false, term(SHELL_SCREEN) as never)).toBe(false);
    expect(isClaudeSurface(false, null)).toBe(false);
    expect(isClaudeSurface(false, undefined)).toBe(false);
  });
});
