import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().default("file:./dev.db"),
    BETTER_AUTH_SECRET: z.string().min(1).optional(),
    BETTER_AUTH_URL: z.string().url().optional(),
    RESEND_API_KEY: z.string().optional(),
    MINIO_ENDPOINT: z.string().default("localhost"),
    MINIO_PORT: z.coerce.number().default(19000),
    MINIO_ACCESS_KEY: z.string().default("minioadmin"),
    MINIO_SECRET_KEY: z.string().default("minioadmin"),
    MINIO_BUCKET: z.string().default("uploads"),
    MINIO_USE_SSL: z.coerce.boolean().default(false),
    TEMPORAL_ADDRESS: z.string().default("localhost:17233"),
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    REDIS_URL: z.string().optional(),
  },
  runtimeEnv: process.env,
});
