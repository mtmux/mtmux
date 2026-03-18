import http from "node:http";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";

const logger = createLogger("relay:http");

export function createHttpServer() {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return server;
}

export function startHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      logger.info(`HTTP server listening on ${config.host}:${config.port}`);
      resolve();
    });
  });
}
