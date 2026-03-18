import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { trpcHandler } from "./trpc";
import { authHandler } from "./auth";
import { healthRoutes } from "./routes/health";
import { webhookRoutes } from "./routes/webhooks";

export const app = new Hono();

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["http://localhost:14100", "http://localhost:14101"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Routes
app.route("/health", healthRoutes);
app.route("/webhooks", webhookRoutes);

// Auth
app.all("/api/auth/**", authHandler);

// tRPC
app.all("/api/trpc/*", trpcHandler);

// Root
app.get("/", (c) => c.json({ name: "Monorepo Starter API", version: "1.0.0" }));
