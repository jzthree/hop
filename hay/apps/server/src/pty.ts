import os from "node:os";
import { EventEmitter } from "node:events";
import pty, { IPty } from "node-pty-prebuilt-multiarch";
import { applyShellIntegration } from "./shellIntegration";

export type PtyFactoryOptions = {
  cols: number;
  rows: number;
  cwd: string;
  env?: Record<string, string>;
  shell?: string;
  // Launch the session ON this command instead of typing it into a shell
  // afterwards. Restore used to attach, wait a fixed delay, and type the
  // relaunch — which silently lost the keystrokes whenever the shell wasn't
  // at its prompt yet. Passing the command as argv removes the whole class:
  // there is no prompt to race, nothing to half-type, and no command echo in
  // the scrollback. The shell is re-exec'd afterwards so the session behaves
  // exactly as before once the command exits.
  command?: string;
  /** The room this terminal belongs to — the keeper's key for it. */
  id?: string;
};

export type PtyFactory = (options: PtyFactoryOptions) => IPty;

const resolveShell = (shellOverride?: string) => {
  if (shellOverride) {
    return shellOverride;
  }
  if (process.env.SHELL) {
    return process.env.SHELL;
  }
  if (os.platform() === "win32") {
    return process.env.COMSPEC ?? "cmd.exe";
  }
  return "/bin/bash";
};

/**
 * Everything a terminal spawn needs, fully resolved on THIS side (env
 * scrubbing, shell choice, the `-lc command; exec shell` wrapper) so a
 * process that merely owns terminals (scripts/pty-keeper.js) can spawn it
 * verbatim and never needs to change when this policy does.
 */
export type ResolvedSpawn = { file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number };

export const resolveSpawn = ({ cols, rows, cwd, env: envOverrides, shell, command }: PtyFactoryOptions): ResolvedSpawn => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.PROMPT_EOL_MARK = "";
  if (envOverrides && typeof envOverrides === "object") {
    for (const [key, value] of Object.entries(envOverrides)) {
      if (!key || typeof value !== "string") continue;
      env[key] = value;
    }
  }
  env.TERM = "xterm-256color";
  if (!env.COLORTERM) {
    env.COLORTERM = "truecolor";
  }
  if (!envOverrides || !("NO_COLOR" in envOverrides)) delete env.NO_COLOR;
  if (env.FORCE_COLOR === "0" && (!envOverrides || !("FORCE_COLOR" in envOverrides))) {
    delete env.FORCE_COLOR;
  }
  const shellPath = resolveShell(shell);
  // A `codex` typed at a hop prompt runs standalone (shellIntegration.ts).
  applyShellIntegration(shellPath, env);
  const args = command
    ? ["-lc", `${command}; exec ${shellPath} -l`]
    : [];
  return { file: shellPath, args, cwd, env, cols, rows };
};

export const createPty: PtyFactory = (options) => {
  const mode = process.env.PTY_MODE ?? "native";
  if (mode === "mock") {
    return createMockPty();
  }
  try {
    const r = resolveSpawn(options);
    return pty.spawn(r.file, r.args, { cols: r.cols, rows: r.rows, cwd: r.cwd, env: r.env });
  } catch (error) {
    if (mode === "auto") {
      return createMockPty();
    }
    throw error;
  }
};

const createMockPty = (): IPty => {
  const emitter = new EventEmitter();
  return {
    onData: (handler: (data: string) => void) => {
      emitter.on("data", handler);
      return {
        dispose: () => emitter.off("data", handler)
      };
    },
    write: (data: string) => {
      const echo = data.replace(/\r/g, "\r\n");
      setTimeout(() => emitter.emit("data", echo), 10);
    },
    resize: () => {},
    kill: () => {},
    onExit: () => ({ dispose: () => {} })
  } as unknown as IPty;
};
