import type { ClientMessage } from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";

const logger = createLogger("relay:auth");

const AUTH_TIMEOUT_MS = 5000;

export interface AuthResult {
  authenticated: boolean;
  reason?: string;
}

export function authenticateMessage(msg: ClientMessage): AuthResult {
  if (msg.type !== "auth") {
    return { authenticated: false, reason: "First message must be auth" };
  }

  if (msg.token !== config.authToken) {
    logger.warn("Authentication failed: invalid token");
    return { authenticated: false, reason: "Invalid token" };
  }

  logger.info("Client authenticated successfully");
  return { authenticated: true };
}

export function createAuthTimeout(onTimeout: () => void): NodeJS.Timeout {
  return setTimeout(() => {
    logger.warn("Authentication timeout - closing connection");
    onTimeout();
  }, AUTH_TIMEOUT_MS);
}
