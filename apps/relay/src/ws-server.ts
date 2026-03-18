import { WebSocketServer, WebSocket } from "ws";
import type http from "node:http";
import { createLogger } from "@repo/logger";

const logger = createLogger("relay:ws");

export function createWsServer(httpServer: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("listening", () => {
    logger.info("WebSocket server ready");
  });

  wss.on("error", (err) => {
    logger.error({ err }, "WebSocket server error");
  });

  return wss;
}

export function sendJson(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
