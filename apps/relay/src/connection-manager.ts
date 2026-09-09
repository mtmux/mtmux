import type { WebSocket } from "ws";
import type { GrantRecord, ServerMessage, TerminalSize } from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { FULL_GRANT } from "./grant.js";
import { destroyClone } from "./tmux-clone.js";
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
  /**
   * What this connection's credential may do.
   *
   * Defaults to `FULL_GRANT` so that a connection which has not authenticated
   * yet is never *narrower* than the code that reads it expects — every read
   * of this is gated behind `authenticated` anyway, and a null here would only
   * add optional-chaining to the paths that must not be wrong.
   */
  grant: GrantRecord;
  pty: PtyBridge | null;
  watchers: Map<string, DirectoryWatcher>;
  uploads: UploadState;
  rateLimiter: RateLimiter;
  attachedSession: string | null;
  /**
   * Last size actually applied to the PTY. Clients emit a burst of fits while
   * layout settles; forwarding every identical size to `pty.resize()` makes tmux
   * redraw globally for every attached client (SIGWINCH), which reads as
   * flicker. Compare against this before resizing.
   */
  lastSize: TerminalSize | null;
  /**
   * The grouped clone this connection is attached *through*, if any.
   *
   * `attachedSession` stays the name of the real session the grant names — it
   * is what every scope and broadcast check compares against — while this is
   * the throwaway tmux session the PTY is actually talking to. Tracked so
   * teardown can destroy it; a clone outliving its connection is a leak.
   */
  cloneSession: string | null;
  activeWindowId: string | null;
  remoteAddress: string | null;
  /** Display name from the pairing record, once authenticated. */
  label: string | null;
  /**
   * `sessionTokenId()` of the credential this socket authenticated with.
   *
   * Null for the machine's own `AUTH_TOKEN`, which is not revocable — it is
   * the thing revocation is performed *with*. Recorded so a revocation can
   * close exactly this socket and no other; matching on `grant.id` would
   * close every connection sharing `FULL_GRANT`.
   */
  tokenId: string | null;
  /** When the socket was accepted, for "connected 4m ago". */
  connectedAt: number;
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
    grant: FULL_GRANT,
    pty: null,
    watchers: new Map(),
    uploads: new Map(),
    rateLimiter,
    attachedSession: null,
    lastSize: null,
    cloneSession: null,
    activeWindowId: null,
    remoteAddress,
    label: null,
    tokenId: null,
    connectedAt: Date.now(),
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

  // Destroy the viewing clone, if this connection had one. Must happen after
  // the PTY is dead, or tmux would simply reattach the dying client.
  if (conn.cloneSession) {
    await destroyClone(conn.cloneSession);
    conn.cloneSession = null;
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

/**
 * Close every live socket whose credential was just revoked.
 *
 * 1008 (policy violation) rather than 1000, so the client does not read it as
 * an ordinary close and reconnect. Matched on `tokenId` and never on
 * `grant.id`: `FULL_GRANT` is a single shared record, so a grant-id sweep
 * would disconnect every device on the machine.
 *
 * Returns how many were closed, which is what makes it testable.
 */
export function closeRevokedConnections(tokenIds: Iterable<string>): number {
  const revoked = new Set(tokenIds);
  if (revoked.size === 0) return 0;
  let closed = 0;
  for (const conn of connections.values()) {
    if (conn.tokenId && revoked.has(conn.tokenId)) {
      logger.info({ connId: conn.id }, "Closing revoked connection");
      conn.ws.close(1008, "Access revoked");
      closed++;
    }
  }
  return closed;
}

/** One connected device, as `mtmux start` and `mtmux status` display it. */
export type ConnectedDevice = {
  label: string;
  connectedAt: number;
  readOnly: boolean;
};

/**
 * Who is connected right now.
 *
 * Authenticated connections only. A socket that has opened but not yet proved
 * anything is not a device the user has admitted, and counting it would make
 * the number jump every time a port scanner touched the relay.
 *
 * Deliberately carries no address, no session name and no grant scope: this
 * crosses a loopback HTTP boundary to `mtmux status`, and a device list is not
 * a reason to start handing out the shape of the machine.
 */
export function connectionSummary(): {
  count: number;
  devices: ConnectedDevice[];
} {
  const devices = getAllConnections()
    .filter((conn) => conn.authenticated)
    .map((conn) => ({
      label: conn.label ?? "A device",
      connectedAt: conn.connectedAt,
      readOnly: conn.grant.readOnly,
    }))
    .sort((a, b) => a.connectedAt - b.connectedAt);
  return { count: devices.length, devices };
}

/**
 * Notified when the set of connected devices changes.
 *
 * Fires on authentication and on close rather than on every socket event —
 * those are the two moments the answer to "who is connected" actually changes.
 */
const connectionListeners = new Set<() => void>();

export function onConnectionsChanged(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

export function notifyConnectionsChanged(): void {
  for (const listener of connectionListeners) {
    try {
      listener();
    } catch {
      // A misbehaving display must never take down a connection.
    }
  }
}

/**
 * Send each connection its *own* view of an event, or nothing.
 *
 * This replaces a blanket `broadcastToAll`, which fanned session names to
 * every authenticated connection regardless of scope. That is the single most
 * likely thing in this change to be got wrong, because it is invisible until
 * two browsers with different scopes are connected at the same moment — the
 * ordinary single-user case never shows it.
 *
 * The builder returns null to skip a connection entirely, which is what makes
 * "A's session was killed" reach A and be indistinguishable from silence for
 * B. Returning a *different* message per connection is what makes a filtered
 * `session:list` broadcast possible at all.
 */
export function broadcastWhere(
  build: (conn: ConnectionState) => ServerMessage | null,
  excludeWs?: WebSocket,
): void {
  for (const conn of connections.values()) {
    if (!conn.authenticated) continue;
    if (excludeWs && conn.ws === excludeWs) continue;
    let msg: ServerMessage | null;
    try {
      msg = build(conn);
    } catch (err) {
      // One connection's builder throwing must not silence the others.
      logger.error({ err, connId: conn.id }, "Broadcast builder failed");
      continue;
    }
    if (msg) sendJson(conn.ws, msg);
  }
}

/**
 * Send the same message to everyone.
 *
 * Kept for the handful of events that carry no session-identifying payload.
 * Anything naming a session must go through `broadcastWhere` instead.
 */
export function broadcastToAll(
  msg: ServerMessage,
  excludeWs?: WebSocket,
): void {
  broadcastWhere(() => msg, excludeWs);
}
