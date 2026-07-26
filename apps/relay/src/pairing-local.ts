import crypto from "node:crypto";

/**
 * Tokenless sign-in for a device on the same network.
 *
 * `mtmux start` prints a QR encoding `http://<lan-ip>:<port>/login#n=<nonce>`.
 * Scanning it loads the login page, which redeems the nonce here for a scoped,
 * expiring session token. The 64-hex `AUTH_TOKEN` is never shown to the phone
 * and never typed by hand.
 *
 * Two properties carry the security argument:
 *
 *  - The nonce is single-use. A photo of the terminal taken after the first
 *    scan is worthless, and a redeemed nonce cannot be replayed.
 *  - Session tokens expire (24 h by default) and are held only in memory, so
 *    restarting the server revokes every device it ever paired.
 *
 * Nothing here is registered in split mode (apps/relay standalone), where no
 * nonce is ever issued — `redeemPairingNonce` then rejects unconditionally and
 * the endpoint is inert.
 */

const NONCE_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Secrets are held as SHA-256 digests so a heap dump yields nothing usable. */
function digest(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

type Expiring = { expiresAt: number };

const nonces = new Map<string, Expiring>();
const sessions = new Map<string, Expiring>();

function prune(map: Map<string, Expiring>, now: number): void {
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
}

/**
 * Notified whenever a nonce is successfully redeemed, so the CLI can arm a
 * fresh one and reprint the QR — otherwise the code on screen is silently dead
 * after the first device pairs.
 */
const redeemListeners = new Set<() => void>();

export function onPairingRedeemed(listener: () => void): () => void {
  redeemListeners.add(listener);
  return () => redeemListeners.delete(listener);
}

export type PairingNonce = { nonce: string; expiresAt: number };

/** Mint a nonce for the QR. Replaces any previous one — only one is live. */
export function issuePairingNonce(
  ttlMs: number = NONCE_TTL_MS,
  now: number = Date.now(),
): PairingNonce {
  nonces.clear();
  const nonce = crypto.randomBytes(16).toString("base64url");
  const expiresAt = now + ttlMs;
  nonces.set(digest(nonce), { expiresAt });
  return { nonce, expiresAt };
}

export type SessionToken = { token: string; expiresAt: number };

/**
 * Redeem a nonce for a session token, or null if it is unknown, expired, or
 * already used.
 */
export function redeemPairingNonce(
  nonce: string,
  now: number = Date.now(),
): SessionToken | null {
  prune(nonces, now);
  const key = digest(nonce);
  const entry = nonces.get(key);
  if (!entry) return null;
  // Single use: burn it whether or not the caller does anything with the token.
  nonces.delete(key);
  if (entry.expiresAt <= now) return null;
  const session = issueSessionToken(SESSION_TTL_MS, now);
  for (const listener of redeemListeners) {
    try {
      listener();
    } catch {
      // A misbehaving listener must never fail the pairing itself.
    }
  }
  return session;
}

export function issueSessionToken(
  ttlMs: number = SESSION_TTL_MS,
  now: number = Date.now(),
): SessionToken {
  prune(sessions, now);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = now + ttlMs;
  sessions.set(digest(token), { expiresAt });
  return { token, expiresAt };
}

export function isValidSessionToken(
  token: string,
  now: number = Date.now(),
): boolean {
  const entry = sessions.get(digest(token));
  if (!entry) return false;
  if (entry.expiresAt <= now) {
    sessions.delete(digest(token));
    return false;
  }
  return true;
}

export function revokeSessionToken(token: string): void {
  sessions.delete(digest(token));
}

/** True when a nonce is currently outstanding — i.e. local pairing is armed. */
export function hasLivePairingNonce(now: number = Date.now()): boolean {
  prune(nonces, now);
  return nonces.size > 0;
}

/** Test seam. */
export function resetPairingState(): void {
  nonces.clear();
  sessions.clear();
  redeemListeners.clear();
}
