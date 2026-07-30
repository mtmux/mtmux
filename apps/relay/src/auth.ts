import crypto from "node:crypto";
import type { ClientMessage, GrantRecord } from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";
import { FULL_GRANT } from "./grant.js";
import { grantForToken } from "./pairing-local.js";
import {
  checkAuthThrottle,
  recordAuthFailure,
  recordAuthSuccess,
} from "./auth-throttle.js";

const logger = createLogger("relay:auth");

const AUTH_TIMEOUT_MS = 5000;

export interface AuthResult {
  authenticated: boolean;
  reason?: string;
  /** Set when the attempt was refused by the per-address backoff. */
  retryAfterMs?: number;
  /**
   * What this credential may do. Present exactly when `authenticated`.
   *
   * Resolution order is `AUTH_TOKEN` → `FULL_GRANT`, then a registered scoped
   * token → its own record, then failure. The first arm is the entirety of
   * legacy compatibility: an install that has never run `mtmux share` only
   * ever produces `FULL_GRANT`, so nothing about the self-hosted path changes.
   */
  grant?: GrantRecord;
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

/**
 * Accepts either the long-lived `AUTH_TOKEN` or a scoped session token issued
 * by local pairing, and applies per-address backoff to failures.
 *
 * `remoteAddress` is optional so existing callers and tests keep working; when
 * it is absent the attempt simply isn't throttled.
 */
export function authenticateMessage(
  msg: ClientMessage,
  remoteAddress: string | null = null,
): AuthResult {
  if (msg.type !== "auth") {
    return { authenticated: false, reason: "First message must be auth" };
  }

  const throttled = checkAuthThrottle(remoteAddress);
  if (!throttled.allowed) {
    logger.warn("Authentication refused: address is in backoff");
    return {
      authenticated: false,
      reason: `Too many failed attempts. Try again in ${Math.ceil(
        throttled.retryAfterMs / 1000,
      )}s.`,
      retryAfterMs: throttled.retryAfterMs,
    };
  }

  const grant = timingSafeEqualToken(msg.token, config.authToken)
    ? FULL_GRANT
    : grantForToken(msg.token);

  if (!grant) {
    const next = recordAuthFailure(remoteAddress);
    logger.warn("Authentication failed: invalid token");
    return {
      authenticated: false,
      reason: "Invalid token",
      ...(next.allowed ? {} : { retryAfterMs: next.retryAfterMs }),
    };
  }

  recordAuthSuccess(remoteAddress);
  // The grant id is logged; the scope is not. "Which share was used" is an
  // operational question the machine's owner may ask, "which sessions does it
  // cover" is in the file they already have.
  logger.info({ grant: grant.id }, "Client authenticated successfully");
  return { authenticated: true, grant };
}

export function createAuthTimeout(onTimeout: () => void): NodeJS.Timeout {
  return setTimeout(() => {
    logger.warn("Authentication timeout - closing connection");
    onTimeout();
  }, AUTH_TIMEOUT_MS);
}
