import { z } from "zod";

const ConfigSchema = z.object({
  port: z.coerce.number().default(14300),
  host: z.string().default("0.0.0.0"),
  authToken: z.string().default("change-me-in-production"),
  allowedPaths: z
    .string()
    .default("/home")
    .transform((s) => s.split(",").map((p) => p.trim())),
  tmuxSocket: z.string().default(""),
  tmuxDefaultShell: z.string().default("/bin/bash"),
  wsRateLimit: z.coerce.number().default(100),
  idleTimeoutMinutes: z.coerce.number().default(30),
  corsOrigins: z
    .string()
    .default("http://localhost:14100")
    .transform((s) => s.split(",").map((o) => o.trim())),
});

export const config = ConfigSchema.parse({
  port: process.env.RELAY_PORT,
  host: process.env.RELAY_HOST,
  authToken: process.env.AUTH_TOKEN,
  allowedPaths: process.env.ALLOWED_PATHS,
  tmuxSocket: process.env.TMUX_SOCKET,
  tmuxDefaultShell: process.env.TMUX_DEFAULT_SHELL,
  wsRateLimit: process.env.WS_RATE_LIMIT,
  idleTimeoutMinutes: process.env.IDLE_TIMEOUT_MINUTES,
  corsOrigins: process.env.CORS_ORIGINS,
});
