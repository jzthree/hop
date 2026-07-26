import os from "node:os";
import { EventEmitter } from "node:events";
import pty, { IPty } from "node-pty-prebuilt-multiarch";

export type PtyFactoryOptions = {
  cols: number;
  rows: number;
  cwd: string;
  env?: Record<string, string>;
  shell?: string;
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

export const createPty: PtyFactory = ({ cols, rows, cwd, env: envOverrides, shell }) => {
  const mode = process.env.PTY_MODE ?? "native";
  if (mode === "mock") {
    return createMockPty();
  }
  try {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
    // Shared PTYs get resized whenever a differently-sized device attaches
    // (autofit claims), and every resize makes zsh re-emit its end-of-line
    // mark ("%" + a line of spaces + CR) into history at the OLD width —
    // rendering as stray reverse-video % at line ends for every later viewer.
    // Suppress the mark for hop-spawned shells; user env overrides still win.
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
    // A hop session is an INTERACTIVE terminal, so it must never inherit a
    // "this output isn't for a human" color suppressor from whatever
    // launched the daemon. Claude Code sets NO_COLOR=1 for the shells it
    // runs commands in — so a daemon (re)started from inside an agent
    // session propagated NO_COLOR into every PTY it spawned afterwards, and
    // every app in every session silently went monochrome: measured, claude
    // emits ZERO colored SGR with NO_COLOR=1 and full 24-bit truecolor
    // without it. That is the whole "claude has no color in hop but does in
    // iTerm" report. Explicit per-session env overrides above still win.
    if (!envOverrides || !("NO_COLOR" in envOverrides)) delete env.NO_COLOR;
    if (env.FORCE_COLOR === "0" && (!envOverrides || !("FORCE_COLOR" in envOverrides))) {
      delete env.FORCE_COLOR;
    }
    return pty.spawn(resolveShell(shell), [], {
      cols,
      rows,
      cwd,
      env
    });
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
