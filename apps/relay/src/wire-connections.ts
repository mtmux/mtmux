import os from "node:os";
import type http from "node:http";
import type { WebSocketServer } from "ws";
import { WebSocket } from "ws";
import { createLogger } from "@repo/logger";
import { tryDeserializeClientMessage } from "@repo/protocol";
import { sendJson } from "./ws-server.js";
import { authenticateMessage, createAuthTimeout } from "./auth.js";
import {
  createConnection,
  removeConnection,
  getAllConnections,
  getConnectionCount,
  getIpCount,
  broadcastWhere,
} from "./connection-manager.js";
import { allowsSession, allowsSessionName } from "./grant.js";
import { isCloneSession, sweepOrphanClones } from "./tmux-clone.js";
import { createRateLimiter } from "./rate-limiter.js";
import { createSessionMonitor } from "./session-monitor.js";
import { routeMessage } from "./message-router.js";
import { defaultBrowsePath } from "./file-service.js";
import { config } from "./config.js";

// The `ws` liveness protocol tags each socket with an `isAlive` flag toggled by
// the pong handler; augment the type so it's available without casts.
declare module "ws" {
  interface WebSocket {
    isAlive?: boolean;
  }
}

const logger = createLogger("relay");
const SERVER_VERSION = "1.0.0";

// Global concurrent-connection cap and per-IP cap. Rejected upgrades are closed
// with 1013 ("Try Again Later"). Sized for a self-hosted single-user tool.
const MAX_CONNECTIONS = 100;
const MAX_CONNECTIONS_PER_IP = 10;

// How often the idle reaper runs; connections with no inbound traffic for
// longer than config.idleTimeoutMinutes are closed.
const IDLE_SWEEP_MS = 60_000;

/**
 * How long a closing socket has to acknowledge before it is terminated.
 *
 * Long enough for a close frame to land on a healthy connection, short enough
 * that a wedged one cannot hold Ctrl+C hostage.
 */
const CLOSE_GRACE_MS = 250;

export type WireOptions = {
  monitor?: ReturnType<typeof createSessionMonitor>;
};

/**
 * Attach all relay protocol handlers (auth, routing, monitoring) to a
 * WebSocketServer. Used by both the standalone relay (apps/relay) and
 * the embedded CLI (apps/cli) which shares one HTTP server with Next.js.
 */
export function wireConnections(
  wss: WebSocketServer,
  opts: WireOptions = {},
): {
  monitor: ReturnType<typeof createSessionMonitor>;
  shutdown: () => void;
} {
  const monitor = opts.monitor ?? createSessionMonitor();

  wss.on("connection", (ws, req?: http.IncomingMessage) => {
    // Behind a proxy on a self-host box the direct peer address is acceptable.
    const remoteAddress = req?.socket?.remoteAddress ?? "unknown";

    // Enforce global and per-IP concurrent-connection caps before doing any
    // per-connection setup. 1013 = "Try Again Later".
    if (getConnectionCount() >= MAX_CONNECTIONS) {
      logger.warn({ remoteAddress }, "Rejected connection: global cap reached");
      ws.close(1013, "Server at capacity");
      return;
    }
    if (getIpCount(remoteAddress) >= MAX_CONNECTIONS_PER_IP) {
      logger.warn({ remoteAddress }, "Rejected connection: per-IP cap reached");
      ws.close(1013, "Too many connections from your address");
      return;
    }

    const conn = createConnection(ws, createRateLimiter(), remoteAddress);

    // ws liveness protocol: mark alive on connect and on every pong.
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    let authTimer: NodeJS.Timeout | null = createAuthTimeout(() => {
      sendJson(ws, { type: "auth:failure", reason: "Authentication timeout" });
      ws.close();
    });

    ws.on("message", async (raw) => {
      const data = raw.toString();
      conn.lastActivityAt = Date.now();

      if (!conn.rateLimiter.check()) {
        sendJson(ws, {
          type: "error",
          code: "RATE_LIMITED",
          message: "Too many messages",
        });
        return;
      }

      const result = tryDeserializeClientMessage(data);
      if (!result.ok) {
        sendJson(ws, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: result.error,
        });
        return;
      }

      const msg = result.message;

      if (!conn.authenticated) {
        if (authTimer) {
          clearTimeout(authTimer);
          authTimer = null;
        }

        const authResult = authenticateMessage(msg, remoteAddress);
        if (!authResult.authenticated) {
          sendJson(ws, {
            type: "auth:failure",
            reason: authResult.reason ?? "Authentication failed",
          });
          ws.close();
          return;
        }

        conn.authenticated = true;
        // The grant is always present on a successful result; the fallback
        // exists so a future auth path that forgets to set one cannot silently
        // produce a connection with no policy attached.
        if (authResult.grant) conn.grant = authResult.grant;

        sendJson(ws, {
          type: "auth:success",
          serverVersion: SERVER_VERSION,
          // Capabilities, so the client can render a read-only banner and hide
          // a file tree that would only ever return ACCESS_DENIED. Advisory —
          // every one of these is enforced server-side regardless.
          capabilities: {
            readOnly: conn.grant.readOnly,
            files: conn.grant.files,
            scope: conn.grant.scope.kind,
          },
        });
        sendJson(ws, {
          type: "server:info",
          hostname: os.hostname(),
          platform: os.platform(),
          uptime: os.uptime(),
          // Omitted when files are off: it is the home directory path, and
          // handing it to someone who may not list a single file in it leaks
          // the account name for nothing.
          ...(conn.grant.files === "none"
            ? {}
            : { defaultPath: defaultBrowsePath() }),
        });

        // Heartbeat: standard `ws` liveness protocol. If a peer missed the
        // previous round's pong it's presumed dead and terminated (which fires
        // `close` → removeConnection → PTY/watcher/upload cleanup).
        const pingInterval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.isAlive === false) {
            ws.terminate();
            return;
          }
          ws.isAlive = false;
          ws.ping();
        }, 30_000);
        ws.on("close", () => clearInterval(pingInterval));

        return;
      }

      conn.enqueue(() => routeMessage(conn, msg));
    });

    ws.on("close", async (code, reason) => {
      logger.info(
        { connId: conn.id, code, reason: reason?.toString?.() ?? "" },
        "WS close event",
      );
      if (authTimer) clearTimeout(authTimer);
      conn.closing = true;
      await conn.drain();
      await removeConnection(conn);
    });

    ws.on("error", (err) => {
      logger.error({ err, connId: conn.id }, "WebSocket error");
    });
  });

  /**
   * Both monitor events used to bypass the connection manager entirely and
   * iterate `wss.clients`, which meant they were unreachable by any scope
   * check — two of the four broadcast leaks. Routing them through
   * `broadcastWhere` is what makes a session name visible only to connections
   * entitled to know it exists.
   */
  monitor.onSessionExit((name) => {
    if (isCloneSession(name)) return;
    broadcastWhere((conn) => {
      // The connection attached to it already learns from its own PTY exit.
      if (conn.attachedSession === name) return null;
      if (!allowsSessionName(conn.grant, name)) return null;
      return { type: "session:exited", name };
    });
  });

  monitor.onSessionCreated((session) => {
    if (isCloneSession(session.name)) return;
    broadcastWhere((conn) =>
      allowsSession(conn.grant, session)
        ? { type: "session:created", session }
        : null,
    );
  });

  monitor.start();

  // Clones are destroyed with their connection, but a crash or `kill -9`
  // skips that. Harmless individually, they accumulate across restarts.
  void sweepOrphanClones().catch(() => {
    // tmux may not be running yet. Nothing to sweep is the normal case.
  });

  // Idle reaper: close connections with no inbound traffic for longer than the
  // configured idle timeout. Uses close code 1000 so it reads as a normal close.
  const idleTimeoutMs = config.idleTimeoutMinutes * 60 * 1000;
  const idleSweep = setInterval(() => {
    if (idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const conn of getAllConnections()) {
      if (now - conn.lastActivityAt > idleTimeoutMs) {
        logger.info({ connId: conn.id }, "Closing idle connection");
        conn.ws.close(1000, "Idle timeout");
      }
    }
  }, IDLE_SWEEP_MS);

  return {
    monitor,
    /**
     * Stop serving, and actually let the process die.
     *
     * `wss.close()` alone does not do that. It stops *accepting* connections
     * and then waits for the existing ones to disconnect on their own — and a
     * connected browser has no reason to. With one tab open, `server.close()`
     * never fired its callback and Ctrl+C hung the CLI forever.
     *
     * So every socket is closed explicitly, and any that has not gone a moment
     * later is terminated. A terminal server is not a database: there is no
     * write to drain, the pty is a child process the OS reaps, and the client
     * reconnects. Waiting politely costs the user a hang and buys nothing.
     */
    shutdown: () => {
      clearInterval(idleSweep);
      monitor.stop();
      for (const conn of getAllConnections()) {
        try {
          conn.ws.close(1001, "Server shutting down");
        } catch {
          // Already gone; the terminate below is the backstop.
        }
      }
      const forced = setTimeout(() => {
        for (const conn of getAllConnections()) conn.ws.terminate();
      }, CLOSE_GRACE_MS);
      forced.unref?.();
      wss.close();
    },
  };
}
