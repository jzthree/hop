import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hop-si-"));
process.env.HOP_HOME_DIR = home;
const { applyShellIntegration } = await import("../src/shellIntegration");

describe("shell integration", () => {
  const fake = path.join(home, "fakebin");
  let shim = "";
  beforeAll(() => {
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, "codex"), '#!/bin/sh\necho "$*"\n', { mode: 0o755 });
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    applyShellIntegration("/bin/zsh", env);
    shim = env.HOP_SHIM_DIR;
  });

  const run = (args: string[], extra: Record<string, string> = { HOP_SESSION: "s_test" }) =>
    execFileSync(path.join(shim, "codex"), args, {
      env: { PATH: `${shim}:${fake}:/usr/bin:/bin`, ...extra },
      encoding: "utf8"
    }).trim();

  it("puts the shim first and points zsh at the wrappers", () => {
    const env: Record<string, string> = { PATH: `/opt/homebrew/bin:/usr/bin`, ZDOTDIR: "/custom" };
    applyShellIntegration("/bin/zsh", env);
    expect(env.PATH.split(":")[0]).toBe(env.HOP_SHIM_DIR);
    expect(env.ZDOTDIR).toBe(path.join(home, "shell-integration", "zsh"));
    expect(env.HOP_USER_ZDOTDIR).toBe("/custom");
    expect(fs.existsSync(path.join(env.ZDOTDIR, ".zshrc"))).toBe(true);
  });

  it("runs the interactive app standalone in a hop terminal", () => {
    expect(run([])).toBe("--no-daemon");
    expect(run(["fix the bug"])).toBe("--no-daemon fix the bug");
    expect(run(["-m", "gpt", "resume", "abc"])).toBe("--no-daemon -m gpt resume abc");
    expect(run(["fork", "abc"])).toBe("--no-daemon fork abc");
  });

  it("leaves other subcommands, explicit choices and non-hop shells alone", () => {
    expect(run(["login"])).toBe("login");
    expect(run(["-C", "/tmp", "exec", "hi"])).toBe("-C /tmp exec hi");
    expect(run(["agents"])).toBe("agents");
    expect(run(["--no-daemon", "resume"])).toBe("--no-daemon resume");
    expect(run(["--remote", "ws://x"])).toBe("--remote ws://x");
    expect(run(["resume"], {})).toBe("resume");
    expect(run(["resume"], { HOP_SESSION: "s_test", HOP_CODEX_DAEMON: "1" })).toBe("resume");
  });

  it("honours the opt-out", () => {
    const env: Record<string, string> = { PATH: "/usr/bin", HOP_SHELL_INTEGRATION: "0" };
    applyShellIntegration("/bin/zsh", env);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ZDOTDIR).toBeUndefined();
  });
});
