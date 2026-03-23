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
  closing: boolean;
  enqueue: (fn: () => Promise<void>) => void;
  drain: () => Promise<void>;
}

const connections = new Map<string, ConnectionState>();

let nextId = 1;

export function createConnection(
  ws: WebSocket,
  rateLimiter: RateLimiter,
): ConnectionState {
  const id = `conn-${nextId++}`;

  // Sequential message queue — prevents concurrent handler races
  const queue: (() => Promise<void>)[] = [];
  let draining = false;
  let closing = false;
  let drainResolvers: (() => void)[] = [];

  const enqueue = (fn: () => Promise<void>) => {
    if (closing) return;
    queue.push(fn);
    if (draining) return;
    draining = true;
    const processQueue = async () => {
      while (queue.length > 0) {
        const next = queue.shift()!;
        try {
          await next();
        } catch (e) {
          logger.error({ err: e, connId: id }, "Queued message handler error");
        }
      }
      draining = false;
      // Resolve any pending drain waiters
      for (const resolve of drainResolvers) resolve();
      drainResolvers = [];
    };
    void processQueue();
  };

  const drain = (): Promise<void> => {
    if (!draining && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      drainResolvers.push(resolve);
    });
  };

  const conn: ConnectionState = {
    id,
    ws,
    authenticated: false,
    pty: null,
    watchers: new Map(),
    rateLimiter,
    attachedSession: null,
    activeWindowId: null,
    closing: false,
    enqueue,
    drain,
  };

  // Proxy the closing flag
  Object.defineProperty(conn, "closing", {
    get: () => closing,
    set: (v: boolean) => { closing = v; },
  });
  connections.set(id, conn);
  logger.info({ connId: id }, "Connection created");
  return conn;
}

export function removeConnection(conn: ConnectionState): void {
  // Clean up PTY (keep tmux session alive)
  if (conn.pty) {
    conn.pty.markDetaching();
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
