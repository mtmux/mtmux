import { Hono } from "hono";
import { createLogger } from "@repo/logger";

const logger = createLogger("webhooks");

export const webhookRoutes = new Hono();

webhookRoutes.post("/stripe", async (c) => {
  const body = await c.req.text();
  logger.info("Received Stripe webhook");
  // TODO: Verify signature and handle event
  return c.json({ received: true });
});

webhookRoutes.post("/github", async (c) => {
  const body = await c.req.json();
  logger.info("Received GitHub webhook");
  // TODO: Verify signature and handle event
  return c.json({ received: true });
});
