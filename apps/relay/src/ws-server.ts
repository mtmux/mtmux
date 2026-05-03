import { WebSocketServer, WebSocket } from "ws";
import type http from "node:http";
import { createLogger } from "@repo/logger";

const logger = createLogger("relay:ws");

function attachListeners(wss: WebSocketServer): void {
  wss.on("listening", () => {
    logger.info("WebSocket server ready");
  });

  wss.on("error", (err) => {
    logger.error({ err }, "WebSocket server error");
  });
}

export function createWsServer(httpServer: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });
  attachListeners(wss);
  return wss;
}

export function createWsServerNoBind(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  attachListeners(wss);
  return wss;
}

export function attachUpgrade(
  httpServer: http.Server,
  wss: WebSocketServer,
  path: string,
): void {
  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === path) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });
}

export function sendJson(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
