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
