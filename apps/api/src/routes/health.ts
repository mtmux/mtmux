import { Hono } from "hono";
import { prisma } from "@repo/db";

export const healthRoutes = new Hono();

healthRoutes.get("/", async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return c.json({ status: "healthy", timestamp: new Date().toISOString() });
  } catch {
    return c.json({ status: "unhealthy", timestamp: new Date().toISOString() }, 503);
  }
});

healthRoutes.get("/ready", (c) => {
  return c.json({ status: "ready", timestamp: new Date().toISOString() });
});
