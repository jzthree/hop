import os from "node:os";
import { EventEmitter } from "node:events";
import pty, { IPty } from "node-pty-prebuilt-multiarch";

export type PtyFactory = (options: {
  cols: number;
  rows: number;
  cwd?: string;
}) => IPty;

const resolveShell = () => {
  if (process.env.SHELL) {
    return process.env.SHELL;
  }
  if (os.platform() === "win32") {
    return process.env.COMSPEC ?? "cmd.exe";
  }
  return "/bin/bash";
};

export const createPty: PtyFactory = ({ cols, rows, cwd }) => {
  const mode = process.env.PTY_MODE ?? "native";
  if (mode === "mock") {
    return createMockPty();
  }
  try {
    return pty.spawn(resolveShell(), [], {
      cols,
      rows,
      cwd: cwd ?? process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
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
