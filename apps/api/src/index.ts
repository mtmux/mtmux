import { serve } from "@hono/node-server";
import { app } from "./app";
import { createLogger } from "@repo/logger";

const logger = createLogger("api");
const port = Number(process.env.API_PORT ?? 14200);

serve({ fetch: app.fetch, port }, () => {
  logger.info(`API server running on http://localhost:${port}`);
});
