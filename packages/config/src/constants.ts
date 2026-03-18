export const APP_NAME = "Monorepo Starter";

export const PORTS = {
  WEB: 14100,
  ADMIN: 14101,
  DOCS: 14102,
  API: 14200,
} as const;

export const TEMPORAL = {
  TASK_QUEUE: "main-queue",
  NAMESPACE: "default",
} as const;

export const STORAGE = {
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
  ALLOWED_IMAGE_TYPES: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  PRESIGNED_URL_EXPIRY: 3600, // 1 hour
} as const;
