import crypto from "node:crypto";
import type { ClientMessage } from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";

const logger = createLogger("relay:auth");

const AUTH_TIMEOUT_MS = 5000;

export interface AuthResult {
  authenticated: boolean;
  reason?: string;
}

/**
 * Timing-safe token comparison. Both sides are hashed with SHA-256 first so the
 * digests are always equal length (a requirement of `timingSafeEqual`) and so
 * length differences between the tokens don't leak through the comparison.
 */
export function timingSafeEqualToken(
  provided: string,
  expected: string,
): boolean {
  const providedHash = crypto
    .createHash("sha256")
    .update(provided, "utf8")
    .digest();
  const expectedHash = crypto
    .createHash("sha256")
    .update(expected, "utf8")
    .digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

export function authenticateMessage(msg: ClientMessage): AuthResult {
  if (msg.type !== "auth") {
    return { authenticated: false, reason: "First message must be auth" };
  }

  if (!timingSafeEqualToken(msg.token, config.authToken)) {
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
