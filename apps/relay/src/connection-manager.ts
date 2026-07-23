import type { WebSocket } from "ws";
import type { ServerMessage } from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { sendJson } from "./ws-server.js";
import type { PtyBridge } from "./pty-bridge.js";
import type { DirectoryWatcher, UploadState } from "./file-service.js";
import { cleanupUploads } from "./file-service.js";
import type { RateLimiter } from "./rate-limiter.js";

const logger = createLogger("relay:connections");

export interface ConnectionState {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  pty: PtyBridge | null;
  watchers: Map<string, DirectoryWatcher>;
  uploads: UploadState;
  rateLimiter: RateLimiter;
  attachedSession: string | null;
  activeWindowId: string | null;
  remoteAddress: string | null;
  lastActivityAt: number;
  closing: boolean;
  enqueue: (fn: () => Promise<void>) => void;
  drain: () => Promise<void>;
}

const connections = new Map<string, ConnectionState>();
// Per-IP concurrent connection counts, for per-address rate limiting.
const ipCounts = new Map<string, number>();

let nextId = 1;

export function getIpCount(ip: string): number {
  return ipCounts.get(ip) ?? 0;
}

export function createConnection(
  ws: WebSocket,
  rateLimiter: RateLimiter,
  remoteAddress: string | null = null,
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
    uploads: new Map(),
    rateLimiter,
    attachedSession: null,
    activeWindowId: null,
    remoteAddress,
    lastActivityAt: Date.now(),
    closing: false,
    enqueue,
    drain,
  };

  // Proxy the closing flag
  Object.defineProperty(conn, "closing", {
    get: () => closing,
    set: (v: boolean) => {
      closing = v;
    },
  });
  connections.set(id, conn);
  if (remoteAddress) {
    ipCounts.set(remoteAddress, (ipCounts.get(remoteAddress) ?? 0) + 1);
  }
  logger.info({ connId: id }, "Connection created");
  return conn;
}

export async function removeConnection(conn: ConnectionState): Promise<void> {
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

  // Clean up file watchers — await close() so chokidar releases fs handles
  // before we consider the connection fully torn down.
  try {
    await Promise.allSettled(
      Array.from(conn.watchers.values(), (watcher) => watcher.close()),
    );
  } catch {
    // Best-effort — never let watcher teardown block connection removal.
  }
  conn.watchers.clear();

  // Abort in-progress uploads and remove their partial files.
  await cleanupUploads(conn.uploads);

  // Decrement the per-IP connection count.
  if (conn.remoteAddress) {
    const next = (ipCounts.get(conn.remoteAddress) ?? 1) - 1;
    if (next <= 0) ipCounts.delete(conn.remoteAddress);
    else ipCounts.set(conn.remoteAddress, next);
  }

  connections.delete(conn.id);
  logger.info({ connId: conn.id }, "Connection removed");
}

export function getConnectionCount(): number {
  return connections.size;
}

export function getAllConnections(): ConnectionState[] {
  return Array.from(connections.values());
}

export function broadcastToAll(
  msg: ServerMessage,
  excludeWs?: WebSocket,
): void {
  for (const conn of connections.values()) {
    if (!conn.authenticated) continue;
    if (excludeWs && conn.ws === excludeWs) continue;
    sendJson(conn.ws, msg);
  }
}
