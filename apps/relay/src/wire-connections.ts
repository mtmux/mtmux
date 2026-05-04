import os from "node:os";
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
  broadcastToAll,
} from "./connection-manager.js";
import { createRateLimiter } from "./rate-limiter.js";
import { createSessionMonitor } from "./session-monitor.js";
import { routeMessage } from "./message-router.js";

const logger = createLogger("relay");
const SERVER_VERSION = "1.0.0";

export type WireOptions = {
  monitor?: ReturnType<typeof createSessionMonitor>;
};

/**
 * Attach all relay protocol handlers (auth, routing, monitoring) to a
 * WebSocketServer. Used by both the standalone relay (apps/relay) and
 * the embedded CLI (apps/cli) which shares one HTTP server with Next.js.
 */
export function wireConnections(wss: WebSocketServer, opts: WireOptions = {}): {
  monitor: ReturnType<typeof createSessionMonitor>;
  shutdown: () => void;
} {
  const monitor = opts.monitor ?? createSessionMonitor();

  wss.on("connection", (ws) => {
    const conn = createConnection(ws, createRateLimiter());
    let authTimer: NodeJS.Timeout | null = createAuthTimeout(() => {
      sendJson(ws, { type: "auth:failure", reason: "Authentication timeout" });
      ws.close();
    });

    ws.on("message", async (raw) => {
      const data = raw.toString();

      if (!conn.rateLimiter.check()) {
        sendJson(ws, { type: "error", code: "RATE_LIMITED", message: "Too many messages" });
        return;
      }

      const result = tryDeserializeClientMessage(data);
      if (!result.ok) {
        sendJson(ws, { type: "error", code: "INVALID_MESSAGE", message: result.error });
        return;
      }

      const msg = result.message;

      if (!conn.authenticated) {
        if (authTimer) {
          clearTimeout(authTimer);
          authTimer = null;
        }

        const authResult = authenticateMessage(msg);
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
        });

        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
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
      removeConnection(conn);
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

  return {
    monitor,
    shutdown: () => {
      monitor.stop();
      wss.close();
    },
  };
}
