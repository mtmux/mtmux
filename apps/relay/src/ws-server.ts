import { WebSocketServer, WebSocket } from "ws";
import type http from "node:http";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";

const logger = createLogger("relay:ws");

// Cap inbound frames so a single client can't force the relay to buffer
// arbitrarily large messages. 1 MiB comfortably covers terminal I/O and the
// chunked file-upload protocol (which sends <=64 KiB base64 chunks).
const MAX_PAYLOAD = 1024 * 1024;

/**
 * Whether a WebSocket upgrade Origin is acceptable. Requests without an Origin
 * header (native/CLI clients that aren't browsers) are always allowed. When
 * `corsOrigins` is configured, browser Origins must be on the allow-list.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (config.corsOrigins.length === 0) return true;
  return config.corsOrigins.includes(origin);
}

function attachListeners(wss: WebSocketServer): void {
  wss.on("listening", () => {
    logger.info("WebSocket server ready");
  });

  wss.on("error", (err) => {
    logger.error({ err }, "WebSocket server error");
  });
}

export function createWsServer(httpServer: http.Server): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_PAYLOAD,
    verifyClient: (info, done) => {
      if (!isOriginAllowed(info.origin)) {
        logger.warn(
          { origin: info.origin },
          "Rejected upgrade: origin not allowed",
        );
        done(false, 403, "Forbidden origin");
        return;
      }
      done(true);
    },
  });
  attachListeners(wss);
  return wss;
}

export function createWsServerNoBind(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  attachListeners(wss);
  return wss;
}

/**
 * Route WebSocket upgrades on `httpServer`: `path` goes to the relay, anything
 * else to `fallback` (or is destroyed when there is no fallback).
 *
 * The fallback exists for single-port dev, where Next.js needs its own upgrades
 * for HMR. In the shipped CLI nothing else upgrades, so the default stands.
 */
export function attachUpgrade(
  httpServer: http.Server,
  wss: WebSocketServer,
  path: string,
  fallback?: (
    req: http.IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => void,
): void {
  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== path) {
      if (fallback) fallback(req, socket, head);
      else socket.destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin)) {
      logger.warn(
        { origin: req.headers.origin },
        "Rejected upgrade: origin not allowed",
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
}

export function sendJson(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
