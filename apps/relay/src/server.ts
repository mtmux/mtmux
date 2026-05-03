import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";
import { isPathAllowed } from "./file-service.js";
import { getMimeType } from "./mime.js";

const logger = createLogger("relay:http");

/**
 * Returns the relay's request handler for `/health` and `/file?...`. Returns
 * `true` if the request was handled (caller must not respond), `false` if the
 * caller should fall through to its own handler (e.g. Next.js).
 */
export async function handleRelayRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return true;
  }

  if (req.url?.startsWith("/file?") && req.method === "GET") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    const url = new URL(req.url, `http://${req.headers.host}`);
    const filePath = url.searchParams.get("path");
    const token = url.searchParams.get("token");
    const download = url.searchParams.get("download") === "1";

    if (!token || token !== config.authToken) {
      res.writeHead(401);
      res.end("Unauthorized");
      return true;
    }

    if (!filePath) {
      res.writeHead(400);
      res.end("Missing path parameter");
      return true;
    }

    if (!isPathAllowed(filePath)) {
      res.writeHead(403);
      res.end("Access denied");
      return true;
    }

    try {
      const resolved = path.resolve(filePath);
      const stat = await fsp.stat(resolved);
      if (!stat.isFile()) {
        res.writeHead(404);
        res.end("Not a file");
        return true;
      }

      const mime = getMimeType(resolved);
      const fileName = path.basename(resolved);
      const headers: Record<string, string> = {
        "Content-Type": mime,
        "Cache-Control": "private, max-age=60",
      };

      if (download) {
        headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
      }

      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        if (match) {
          const start = parseInt(match[1]!, 10);
          const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
          if (start >= stat.size) {
            res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            res.end();
            return true;
          }
          const clampedEnd = Math.min(end, stat.size - 1);
          headers["Content-Range"] = `bytes ${start}-${clampedEnd}/${stat.size}`;
          headers["Content-Length"] = String(clampedEnd - start + 1);
          headers["Accept-Ranges"] = "bytes";
          res.writeHead(206, headers);
          fs.createReadStream(resolved, { start, end: clampedEnd }).pipe(res);
          return true;
        }
      }

      headers["Content-Length"] = String(stat.size);
      headers["Accept-Ranges"] = "bytes";
      res.writeHead(200, headers);
      fs.createReadStream(resolved).pipe(res);
    } catch (err) {
      logger.error({ err, path: filePath }, "File serve error");
      res.writeHead(404);
      res.end("File not found");
    }
    return true;
  }

  return false;
}

export function createHttpServer() {
  return http.createServer(async (req, res) => {
    const handled = await handleRelayRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end("Not found");
    }
  });
}

export function startHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      logger.info(`HTTP server listening on ${config.host}:${config.port}`);
      resolve();
    });
  });
}
