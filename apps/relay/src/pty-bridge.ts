import * as pty from "node-pty";
import { createLogger } from "@repo/logger";
import type { TerminalSize } from "@repo/protocol";
import { config } from "./config.js";

const logger = createLogger("relay:pty");

export interface PtyBridge {
  write(data: string): void;
  resize(size: TerminalSize): void;
  kill(): void;
  pause(): void;
  resume(): void;
  markDetaching(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  onReady(cb: () => void): void;
  onSpawnError(cb: (error: Error) => void): void;
  readonly pid: number;
  readonly sessionName: string;
  readonly detaching: boolean;
  readonly spawnError: Error | null;
}

export type PtyBridgeOptions = {
  /**
   * Attach with `-r`.
   *
   * On its own this is *not* a boundary — tmux still honours `detach-client`
   * and `switch-client` under `-r`, and `(`/`)` are bound to the latter by
   * default. It is only safe in combination with the locked-down grouped
   * clone from `tmux-clone.ts`, which is why nothing outside that path sets
   * it. See `createReadOnlyClone`.
   */
  readOnly?: boolean;
};

export function createPtyBridge(
  sessionName: string,
  size?: TerminalSize,
  opts: PtyBridgeOptions = {},
): PtyBridge {
  const args = [
    ...(config.tmuxSocket ? ["-S", config.tmuxSocket] : []),
    "attach-session",
    ...(opts.readOnly ? ["-r"] : []),
    "-t",
    sessionName,
  ];

  const cols = size?.cols ?? 80;
  const rows = size?.rows ?? 24;

  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(exitCode: number) => void> = [];
  const readyCallbacks: Array<() => void> = [];
  const spawnErrorCallbacks: Array<(error: Error) => void> = [];
  let readyFired = false;
  let detaching = false;
  let spawnError: Error | null = null;
  let readyTimeout: ReturnType<typeof setTimeout> | null = null;

  const fireSpawnError = (err: Error) => {
    if (spawnError) return;
    spawnError = err;
    if (readyTimeout) {
      clearTimeout(readyTimeout);
      readyTimeout = null;
    }
    for (const cb of spawnErrorCallbacks) {
      cb(err);
    }
  };

  let ptyProcess: pty.IPty | null = null;
  try {
    ptyProcess = pty.spawn("tmux", args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME ?? "/",
      env: process.env as Record<string, string>,
    });
    logger.info(
      { sessionName, pid: ptyProcess.pid, cols, rows },
      "PTY spawned",
    );
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    logger.error({ sessionName, err }, "PTY spawn failed");
    spawnError = err;
  }

  const fireReady = () => {
    if (readyFired || spawnError) return;
    readyFired = true;
    for (const cb of readyCallbacks) {
      cb();
    }
  };

  if (ptyProcess) {
    // Fire ready on first data or after 50ms timeout (whichever first)
    readyTimeout = setTimeout(fireReady, 50);

    ptyProcess.onData((data) => {
      if (!readyFired) {
        if (readyTimeout) {
          clearTimeout(readyTimeout);
          readyTimeout = null;
        }
        fireReady();
      }
      for (const cb of dataCallbacks) {
        cb(data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = null;
      }
      logger.info(
        { sessionName, exitCode, detaching, readyFired },
        "PTY exited",
      );
      // Exiting before ready (and not because we initiated detach) means the
      // tmux attach failed — the session may have vanished between exists()
      // and attach-session, or tmux refused for another reason. Surface as
      // a spawn failure rather than a phony "ready" + silent dead session.
      if (!readyFired && !detaching) {
        fireSpawnError(
          new Error(
            `tmux attach-session exited with code ${exitCode} before ready`,
          ),
        );
        return;
      }
      if (!detaching) {
        for (const cb of exitCallbacks) {
          cb(exitCode);
        }
      }
    });
  }

  return {
    write(data: string) {
      ptyProcess?.write(data);
    },
    resize(newSize: TerminalSize) {
      ptyProcess?.resize(newSize.cols, newSize.rows);
    },
    kill() {
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = null;
      }
      ptyProcess?.kill();
    },
    pause() {
      ptyProcess?.pause();
    },
    resume() {
      ptyProcess?.resume();
    },
    markDetaching() {
      detaching = true;
    },
    get detaching() {
      return detaching;
    },
    get spawnError() {
      return spawnError;
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
      } else if (!spawnError) {
        readyCallbacks.push(cb);
      }
    },
    onSpawnError(cb: (error: Error) => void) {
      if (spawnError) {
        cb(spawnError);
      } else {
        spawnErrorCallbacks.push(cb);
      }
    },
    get pid() {
      return ptyProcess?.pid ?? -1;
    },
    sessionName,
  };
}
