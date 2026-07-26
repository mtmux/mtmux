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
  broadcastToAll,
} from "./connection-manager.js";
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
        sendJson(ws, { type: "auth:success", serverVersion: SERVER_VERSION });
        sendJson(ws, {
          type: "server:info",
          hostname: os.hostname(),
          platform: os.platform(),
          uptime: os.uptime(),
          defaultPath: defaultBrowsePath(),
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

  monitor.onSessionExit((name) => {
    const allConns = getAllConnections();
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        const conn = allConns.find((c) => c.ws === client);
        if (conn && conn.attachedSession === name) continue;
        sendJson(client, { type: "session:exited", name });
      }
    }
  });

  monitor.onSessionCreated((session) => {
    broadcastToAll({ type: "session:created", session });
  });

  monitor.start();

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
    shutdown: () => {
      clearInterval(idleSweep);
      monitor.stop();
      wss.close();
    },
  };
}
