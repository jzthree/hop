import { describe, expect, it } from "vitest";
import { foregroundName, foregroundProgram } from "../src/keeper";

const row = (pid: number, ppid: number, pgid: number, tpgid: number, comm: string) => ({ pid, ppid, pgid, tpgid, comm });

describe("keeper foreground program", () => {
  it("an idle shell is the shell", () => {
    const sh = row(10, 1, 10, 10, "/bin/zsh");
    expect(foregroundProgram(sh, [sh])).toBe("zsh");
  });
  it("claude launched in the shell's own group is claude, not zsh", () => {
    const sh = row(10, 1, 10, 10, "/bin/zsh");
    expect(foregroundProgram(sh, [sh, row(11, 10, 10, 10, "claude")])).toBe("claude");
  });
  it("a job-controlled program in its own group is that program", () => {
    const sh = row(10, 1, 10, 20, "-zsh");
    const vim = row(20, 10, 20, 20, "/opt/homebrew/bin/nvim");
    expect(foregroundProgram(sh, [vim])).toBe("nvim");
  });
  it("names keep spaces and lose the path and login dash", () => {
    expect(foregroundName("/Applications/X.app/Contents/MacOS/Codex (Service)")).toBe("Codex (Service)");
    expect(foregroundName("-zsh")).toBe("zsh");
  });
});

describe("keeper foreground program — helpers", () => {
  it("claude's own helpers (MCP node, caffeinate) don't replace claude", () => {
    const sh = row(10, 1, 10, 10, "/bin/zsh");
    const group = [sh, row(11, 10, 10, 10, "claude"), row(12, 11, 10, 10, "node"), row(13, 11, 10, 10, "caffeinate")];
    expect(foregroundProgram(sh, group)).toBe("claude");
  });
});

describe("keeper foreground program — launchers", () => {
  it("codex's node launcher reads as codex", () => {
    const sh = row(10, 1, 10, 10, "/bin/zsh");
    expect(foregroundProgram(sh, [sh, row(11, 10, 10, 10, "node"), row(12, 11, 10, 10, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex")])).toBe("codex");
  });
  it("a plain node program stays node", () => {
    const sh = row(10, 1, 10, 10, "/bin/zsh");
    expect(foregroundProgram(sh, [sh, row(11, 10, 10, 10, "node")])).toBe("node");
  });
});
