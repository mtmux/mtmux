import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";
import {
  createBroker,
  type Broker,
  type Socket,
  type SocketHandle,
} from "./broker.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  createAccounts,
  openAccountsDb,
  type Accounts,
} from "./accounts/index.js";

const logger = createLogger("api:server");

const MAX_BODY_BYTES = 8 * 1024;

/**
 * Loopback and link-local peers, which on this box means nginx.
 *
 * Only a request that actually arrived from the local reverse proxy may steer
 * its own rate-limit bucket with a header; anything else is taken at face
 * value from the socket. Without that test a direct caller could pick its own
 * bucket — or someone else's — by setting `CF-Connecting-IP` itself.
 */
function fromTrustedProxy(req: http.IncomingMessage): boolean {
  const peer = req.socket.remoteAddress ?? "";
  return (
    peer === "127.0.0.1" ||
    peer === "::1" ||
    peer === "::ffff:127.0.0.1" ||
    peer.startsWith("10.") ||
    peer.startsWith("172.17.") ||
    peer.startsWith("192.168.")
  );
}

/**
 * Client address, for rate limiting only — never stored against a mailbox.
 *
 * The broker runs behind nginx, so the socket peer is always 127.0.0.1 and an
 * unaided limiter would put every user in one bucket. Two headers can say who
 * the real client is, and the order matters:
 *
 * `CF-Connecting-IP` is preferred because in front of nginx sits Cloudflare,
 * and the vhost sets `X-Forwarded-For $remote_addr` — the address of the *PoP*,
 * not the user. Bucketing on that put every visitor behind a given PoP into a
 * single 5-claims-per-minute window: a denial of service against honest users
 * and a limiter that isolated no attacker.
 *
 * `X-Forwarded-For` remains the fallback, because a self-hosted install behind
 * a plain reverse proxy has no Cloudflare header. Both are only consulted when
 * the request came from a trusted proxy.
 */
export function clientIp(req: http.IncomingMessage): string {
  if (fromTrustedProxy(req)) {
    const cf = req.headers["cf-connecting-ip"];
    const cfFirst = (Array.isArray(cf) ? cf[0] : cf)?.trim();
    if (cfFirst) return cfFirst;

    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const candidate = first?.split(",")[0]?.trim();
    if (candidate) return candidate;
  }
  return req.socket.remoteAddress || "unknown";
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
}

export async function handleApiRequest(
  broker: Broker,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  accounts?: Accounts,
): Promise<void> {
  // Accounts get first refusal, and answer with their own CORS headers.
  //
  // They must run before `applyCors` rather than after it: credentialed
  // cross-origin requests need `Access-Control-Allow-Credentials` and an exact
  // origin, which the broker's CORS deliberately does not send — the pairing
  // endpoints take no cookies and should not invite any.
  if (accounts && (await accounts.handleRequest(req, res))) return;

  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "api"}`);
  const ip = clientIp(req);

  const send = (result: {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }) => {
    res.writeHead(result.status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...result.headers,
    });
    res.end(JSON.stringify(result.body));
  };

  if (url.pathname === "/health" && req.method === "GET") {
    send(broker.health());
    return;
  }

  if (url.pathname === "/v1/discover" && req.method === "GET") {
    send(broker.discover(ip));
    return;
  }

  if (url.pathname === "/v1/pair/new" && req.method === "POST") {
    send(broker.pairNew(ip));
    return;
  }

  if (url.pathname === "/v1/pair/claim" && req.method === "POST") {
    send(broker.pairClaim(ip, await readJsonBody(req)));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

/** Adapt a `ws` socket to the broker's minimal Socket shape. */
function toSocket(ws: WebSocket): Socket {
  return {
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: (code, reason) => ws.close(code, reason),
  };
}

type Route =
  | { kind: "pair"; id: string }
  | { kind: "claim"; id: string }
  | { kind: "agent" }
  | { kind: "tunnel"; id: string };

/** Map a websocket path to a broker route, or null if it is not one of ours. */
export function routeSocketPath(pathname: string): Route | null {
  if (pathname === "/v1/agent") return { kind: "agent" };
  const pair = /^\/v1\/pair\/([\w-]{8,64})$/.exec(pathname);
  if (pair?.[1]) return { kind: "pair", id: pair[1] };
  const claim = /^\/v1\/claim\/([\w-]{8,64})$/.exec(pathname);
  if (claim?.[1]) return { kind: "claim", id: claim[1] };
  const tunnel = /^\/v1\/tunnel\/([\w-]{8,64})$/.exec(pathname);
  if (tunnel?.[1]) return { kind: "tunnel", id: tunnel[1] };
  return null;
}

function attach(
  broker: Broker,
  route: Route,
  socket: Socket,
): SocketHandle | null {
  switch (route.kind) {
    case "pair":
      return broker.attachMailboxSocket(route.id, socket);
    case "claim":
      return broker.attachClaimSocket(route.id, socket);
    case "agent":
      return broker.attachAgentSocket(socket);
    case "tunnel":
      return broker.attachTunnelSocket(route.id, socket);
  }
}

export type ApiServer = {
  server: http.Server;
  broker: Broker;
  accounts: Accounts;
  close: () => Promise<void>;
};

export async function startApiServer(
  port = config.port,
  host = config.host,
): Promise<ApiServer> {
  // Null when DATABASE_URL is unset or the file will not open, in which case
  // `createAccounts` hands back a stub and the broker keeps brokering. An
  // accounts failure must never be a pairing failure.
  const accounts = createAccounts({ db: openAccountsDb() });

  const broker = createBroker({
    // These were configurable in name only: without them `createBroker` fell
    // back to its 5/10 defaults, so API_CLAIMS_PER_MINUTE and
    // API_MAILBOXES_PER_MINUTE were parsed, validated, and then ignored.
    claimLimiter: createRateLimiter(config.claimsPerMinute),
    mailboxLimiter: createRateLimiter(config.mailboxesPerMinute),
    slotClaimLimiter: createRateLimiter(config.slotClaimsPerMinute),
    globalClaimLimiter: createRateLimiter(config.globalClaimsPerMinute),
    discoverLimiter: createRateLimiter(config.discoversPerMinute),
    upgradeLimiter: createRateLimiter(config.upgradesPerMinute),
    quotas: {
      maxBytes: config.tunnelMaxBytes,
      maxMinutes: config.tunnelMaxMinutes,
      maxStreams: config.tunnelMaxStreams,
    },
    // Ties tunnels to accounts so plan limits and usage are real. With no
    // database every method here is inert, and tunnels stay unmetered.
    metering: {
      ownerOfDevice: (publicKey) => accounts.ownerOfDevice(publicKey),
      checkTunnel: (userId) => accounts.checkTunnel(userId),
      recordUsage: (userId, bytes, seconds) =>
        accounts.recordUsage(userId, bytes, seconds),
    },
  });

  const server = http.createServer((req, res) => {
    void handleApiRequest(broker, req, res, accounts).catch((err: unknown) => {
      logger.error({ err }, "Unhandled request error");
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "api"}`);
    const route = routeSocketPath(url.pathname);
    if (!route) {
      socket.destroy();
      return;
    }
    // Every HTTP entry point is budgeted; without this the same routes were
    // reachable over WS as fast as sockets could be opened.
    if (!broker.allowUpgrade(clientIp(req))) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Attached first, and before the `handle` check: a rejected route is
      // closed by `attach`, and an 'error' on that closing socket with no
      // listener would be an unhandled event that takes the broker down.
      ws.on("error", (err) => logger.warn({ err }, "Socket error"));
      const handle = attach(broker, route, toSocket(ws));
      if (!handle) return;
      ws.on("message", (raw) => handle.message(raw.toString()));
      ws.on("close", () => handle.close());
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  logger.info(`Pairing broker listening on ${host}:${port}`);

  return {
    server,
    broker,
    accounts,
    close: async () => {
      await new Promise<void>((resolve) => {
        broker.shutdown();
        wss.close();
        server.close(() => resolve());
      });
      // Last, so an in-flight request still has its database when it lands.
      await accounts.close();
    },
  };
}
