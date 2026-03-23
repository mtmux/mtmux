import * as pty from "node-pty";
import { createLogger } from "@repo/logger";
import type { TerminalSize } from "@repo/protocol";
import { config } from "./config.js";

const logger = createLogger("relay:pty");

export interface PtyBridge {
  write(data: string): void;
  resize(size: TerminalSize): void;
  kill(): void;
  markDetaching(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  onReady(cb: () => void): void;
  readonly pid: number;
  readonly sessionName: string;
  readonly detaching: boolean;
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
  const readyCallbacks: Array<() => void> = [];
  let readyFired = false;
  let detaching = false;

  const fireReady = () => {
    if (readyFired) return;
    readyFired = true;
    for (const cb of readyCallbacks) {
      cb();
    }
  };

  // Fire ready on first data or after 50ms timeout (whichever first)
  const readyTimeout = setTimeout(fireReady, 50);

  ptyProcess.onData((data) => {
    if (!readyFired) {
      clearTimeout(readyTimeout);
      fireReady();
    }
    for (const cb of dataCallbacks) {
      cb(data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    clearTimeout(readyTimeout);
    logger.info({ sessionName, exitCode, detaching }, "PTY exited");
    if (!detaching) {
      for (const cb of exitCallbacks) {
        cb(exitCode);
      }
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
      clearTimeout(readyTimeout);
      ptyProcess.kill();
    },
    markDetaching() {
      detaching = true;
    },
    get detaching() {
      return detaching;
    },
    onData(cb: (data: string) => void) {
      dataCallbacks.push(cb);
    },
    onExit(cb: (exitCode: number) => void) {
      exitCallbacks.push(cb);
    },
    onReady(cb: () => void) {
      if (readyFired) {
        cb();
      } else {
        readyCallbacks.push(cb);
      }
    },
    get pid() {
      return ptyProcess.pid;
    },
    sessionName,
  };
}
