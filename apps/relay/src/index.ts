import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createLogger } from "@repo/logger";
import { tryDeserializeClientMessage, serialize } from "@repo/protocol";
import { config } from "./config.js";
import { createHttpServer, startHttpServer } from "./server.js";
import { createWsServer, sendJson } from "./ws-server.js";
import { authenticateMessage, createAuthTimeout } from "./auth.js";
import { createConnection, removeConnection, getAllConnections, broadcastToAll } from "./connection-manager.js";
import { createRateLimiter } from "./rate-limiter.js";
import { createSessionMonitor } from "./session-monitor.js";
import { routeMessage } from "./message-router.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("relay");

const SERVER_VERSION = "1.0.0";

async function main() {
  // Check that tmux is installed
  try {
    await execFileAsync("tmux", ["-V"]);
  } catch {
    logger.error("tmux is not installed or not found in PATH. Please install tmux 3.0+ to use ccremote.");
    process.exit(1);
  }

  const httpServer = createHttpServer();
  const wss = createWsServer(httpServer);
  const monitor = createSessionMonitor();

  wss.on("connection", (ws) => {
    const conn = createConnection(ws, createRateLimiter());
    let authTimer: NodeJS.Timeout | null = createAuthTimeout(() => {
      sendJson(ws, { type: "auth:failure", reason: "Authentication timeout" });
      ws.close();
    });

    ws.on("message", async (raw) => {
      const data = raw.toString();

      // Rate limit check
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

      // Handle auth
      if (!conn.authenticated) {
        if (authTimer) {
          clearTimeout(authTimer);
          authTimer = null;
        }

        const authResult = authenticateMessage(msg);
        if (!authResult.authenticated) {
          sendJson(ws, { type: "auth:failure", reason: authResult.reason ?? "Authentication failed" });
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

        // Server-side ping for zombie detection (30s interval)
        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        }, 30_000);
        ws.on("close", () => clearInterval(pingInterval));

        return;
      }

      // Route authenticated messages sequentially to prevent race conditions
      conn.enqueue(() => routeMessage(conn, msg));
    });

    ws.on("close", async () => {
      if (authTimer) clearTimeout(authTimer);
      conn.closing = true;
      await conn.drain();
      removeConnection(conn);
    });

    ws.on("error", (err) => {
      logger.error({ err, connId: conn.id }, "WebSocket error");
    });
  });

  // Monitor session exits and broadcast to connected clients
  // #1: Skip connections where PTY bridge already notified the attached client
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
  await startHttpServer(httpServer);

  logger.info(`ccremote relay v${SERVER_VERSION} ready on ${config.host}:${config.port}`);

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    monitor.stop();
    wss.close();
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Failed to start relay server");
  process.exit(1);
});
