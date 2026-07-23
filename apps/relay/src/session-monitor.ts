import type { SessionInfo } from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { listSessions } from "./tmux-manager.js";

const logger = createLogger("relay:monitor");

export interface SessionMonitor {
  start(): void;
  stop(): void;
  onSessionExit(cb: (name: string) => void): void;
  onSessionCreated(cb: (session: SessionInfo) => void): void;
  onSessionActivity(cb: (name: string, activity: string) => void): void;
}

export function createSessionMonitor(): SessionMonitor {
  let interval: NodeJS.Timeout | null = null;
  const knownSessions = new Set<string>();
  const exitCallbacks: Array<(name: string) => void> = [];
  const createdCallbacks: Array<(session: SessionInfo) => void> = [];
  const activityCallbacks: Array<(name: string, activity: string) => void> = [];

  async function poll() {
    try {
      const sessions = await listSessions();
      const currentNames = new Set(sessions.map((s) => s.name));

      // Detect exited sessions
      for (const name of knownSessions) {
        if (!currentNames.has(name)) {
          logger.info({ name }, "Session exited");
          for (const cb of exitCallbacks) cb(name);
          knownSessions.delete(name);
        }
      }

      // Track new and updated sessions
      for (const session of sessions) {
        if (!knownSessions.has(session.name)) {
          knownSessions.add(session.name);
          for (const cb of createdCallbacks) cb(session);
        }
        for (const cb of activityCallbacks) {
          cb(session.name, session.activity);
        }
      }
    } catch (e) {
      logger.error({ err: e }, "Session monitor poll failed");
    }
  }

  return {
    start() {
      poll();
      interval = setInterval(poll, 5000);
      logger.info("Session monitor started");
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      logger.info("Session monitor stopped");
    },
    onSessionExit(cb) {
      exitCallbacks.push(cb);
    },
    onSessionCreated(cb) {
      createdCallbacks.push(cb);
    },
    onSessionActivity(cb) {
      activityCallbacks.push(cb);
    },
  };
}
