import * as pty from "node-pty";
import { createLogger } from "@repo/logger";
import type { TerminalSize } from "@repo/protocol";
import { config } from "./config.js";

const logger = createLogger("relay:pty");

export interface PtyBridge {
  write(data: string): void;
  resize(size: TerminalSize): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  readonly pid: number;
  readonly sessionName: string;
}

export function createPtyBridge(
  sessionName: string,
  size?: TerminalSize,
): PtyBridge {
  const args = [...(config.tmuxSocket ? ["-S", config.tmuxSocket] : []), "attach-session", "-t", sessionName];

  const cols = size?.cols ?? 80;
  const rows = size?.rows ?? 24;

  const ptyProcess = pty.spawn("tmux", args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.env.HOME ?? "/",
    env: process.env as Record<string, string>,
  });

  logger.info({ sessionName, pid: ptyProcess.pid, cols, rows }, "PTY spawned");

  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(exitCode: number) => void> = [];

  ptyProcess.onData((data) => {
    for (const cb of dataCallbacks) {
      cb(data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    logger.info({ sessionName, exitCode }, "PTY exited");
    for (const cb of exitCallbacks) {
      cb(exitCode);
    }
  });

  return {
    write(data: string) {
      ptyProcess.write(data);
    },
    resize(newSize: TerminalSize) {
      ptyProcess.resize(newSize.cols, newSize.rows);
    },
    kill() {
      ptyProcess.kill();
    },
    onData(cb: (data: string) => void) {
      dataCallbacks.push(cb);
    },
    onExit(cb: (exitCode: number) => void) {
      exitCallbacks.push(cb);
    },
    get pid() {
      return ptyProcess.pid;
    },
    sessionName,
  };
}
