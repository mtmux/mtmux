import type { WebSocket } from "ws";
import type { ServerMessage } from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { sendJson } from "./ws-server.js";
import type { PtyBridge } from "./pty-bridge.js";
import type { DirectoryWatcher } from "./file-service.js";
import type { RateLimiter } from "./rate-limiter.js";

const logger = createLogger("relay:connections");

export interface ConnectionState {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  pty: PtyBridge | null;
  watchers: Map<string, DirectoryWatcher>;
  rateLimiter: RateLimiter;
  attachedSession: string | null;
  activeWindowId: string | null;
}

const connections = new Map<string, ConnectionState>();

let nextId = 1;

export function createConnection(
  ws: WebSocket,
  rateLimiter: RateLimiter,
): ConnectionState {
  const id = `conn-${nextId++}`;
  const conn: ConnectionState = {
    id,
    ws,
    authenticated: false,
    pty: null,
    watchers: new Map(),
    rateLimiter,
    attachedSession: null,
    activeWindowId: null,
  };
  connections.set(id, conn);
  logger.info({ connId: id }, "Connection created");
  return conn;
}

export function removeConnection(conn: ConnectionState): void {
  // Clean up PTY (keep tmux session alive)
  if (conn.pty) {
    try {
      conn.pty.kill();
    } catch {
      // PTY may already be dead
    }
    conn.pty = null;
  }

  // Clean up file watchers
  for (const [path, watcher] of conn.watchers) {
    watcher.close();
  }
  conn.watchers.clear();

  connections.delete(conn.id);
  logger.info({ connId: conn.id }, "Connection removed");
}

export function getConnectionCount(): number {
  return connections.size;
}

export function getAllConnections(): ConnectionState[] {
  return Array.from(connections.values());
}

export function broadcastToAll(msg: ServerMessage, excludeWs?: WebSocket): void {
  for (const conn of connections.values()) {
    if (!conn.authenticated) continue;
    if (excludeWs && conn.ws === excludeWs) continue;
    sendJson(conn.ws, msg);
  }
}
