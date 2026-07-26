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

const logger = createLogger("api:server");

const MAX_BODY_BYTES = 8 * 1024;

/**
 * Client address, preferring the proxy's X-Forwarded-For.
 *
 * The broker runs behind nginx on this box, so the socket peer is always
 * 127.0.0.1 and every rate limit would share one bucket. Only the left-most
 * entry is used, and only the address — never stored against a mailbox.
 */
export function clientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = first?.split(",")[0]?.trim();
  return candidate || req.socket.remoteAddress || "unknown";
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
): Promise<void> {
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
  close: () => Promise<void>;
};

export async function startApiServer(
  port = config.port,
  host = config.host,
): Promise<ApiServer> {
  const broker = createBroker({
    quotas: {
      maxBytes: config.tunnelMaxBytes,
      maxMinutes: config.tunnelMaxMinutes,
    },
  });

  const server = http.createServer((req, res) => {
    void handleApiRequest(broker, req, res).catch((err: unknown) => {
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
    wss.handleUpgrade(req, socket, head, (ws) => {
      const handle = attach(broker, route, toSocket(ws));
      if (!handle) return;
      ws.on("message", (raw) => handle.message(raw.toString()));
      ws.on("close", () => handle.close());
      ws.on("error", (err) => logger.warn({ err }, "Socket error"));
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  logger.info(`Pairing broker listening on ${host}:${port}`);

  return {
    server,
    broker,
    close: () =>
      new Promise<void>((resolve) => {
        broker.shutdown();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
