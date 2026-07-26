import { createLogger } from "@repo/logger";
import { startApiServer } from "./server.js";
import { acmeReady, dnsEnabled } from "./config.js";

const logger = createLogger("api");

const api = await startApiServer();

if (!dnsEnabled) {
  logger.info(
    "Reverse DNS disabled (no CLOUDFLARE_API_TOKEN / ZONE_ID / DNS_ZONE). " +
      "Pairing and tunnelling work; every remote session uses the tunnel.",
  );
} else if (!acmeReady) {
  logger.info(
    "DNS enabled, certificate issuance off (ACME_ENABLED / ACME_EMAIL). " +
      "Direct candidates will be advertised but cannot present a certificate.",
  );
}

const shutdown = (signal: string) => {
  logger.info({ signal }, "Shutting down");
  void api.close().then(() => process.exit(0));
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
