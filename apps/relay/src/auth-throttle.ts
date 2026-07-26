/**
 * Per-address backoff for failed authentication.
 *
 * Without this, the relay accepts unlimited token guesses at whatever rate the
 * network allows. That matters more now than it did: `mtmux start` binds the
 * LAN interface by default, and the short-lived session tokens issued by local
 * pairing are a second guessable credential.
 *
 * The shape is deliberately boring — 5 free failures, then a 30 s lockout that
 * doubles on every further failure up to 15 minutes, cleared entirely by one
 * success. A legitimate user fat-fingering a paste never notices; a script gets
 * roughly 5 tries per quarter hour.
 */

export const FAILURES_BEFORE_LOCKOUT = 5;
export const BASE_LOCKOUT_MS = 30_000;
export const MAX_LOCKOUT_MS = 15 * 60 * 1000;

/** Addresses with no activity for this long are forgotten, bounding the map. */
const ENTRY_TTL_MS = 60 * 60 * 1000;
/** Hard cap on tracked addresses, in case something pathological happens. */
const MAX_ENTRIES = 10_000;

type Entry = {
  failures: number;
  /** Epoch ms until which this address is locked out; 0 when not locked. */
  lockedUntil: number;
  /** Current lockout length, doubled on each failure past the threshold. */
  lockoutMs: number;
  touchedAt: number;
};

const entries = new Map<string, Entry>();

export type ThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

function sweep(now: number): void {
  // Only pay for a full scan once the map is actually large.
  if (entries.size < 256) return;
  for (const [key, entry] of entries) {
    if (now - entry.touchedAt > ENTRY_TTL_MS && entry.lockedUntil <= now) {
      entries.delete(key);
    }
  }
  // Still over the cap after sweeping (all entries fresh): drop the oldest.
  if (entries.size > MAX_ENTRIES) {
    const oldest = [...entries.entries()]
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)
      .slice(0, entries.size - MAX_ENTRIES);
    for (const [key] of oldest) entries.delete(key);
  }
}

/** Whether `address` may attempt authentication right now. */
export function checkAuthThrottle(
  address: string | null,
  now: number = Date.now(),
): ThrottleDecision {
  if (!address) return { allowed: true };
  const entry = entries.get(address);
  if (!entry || entry.lockedUntil <= now) return { allowed: true };
  return { allowed: false, retryAfterMs: entry.lockedUntil - now };
}

/**
 * Record a failed attempt. Returns the decision that will apply to the *next*
 * attempt, so callers can tell the client how long to wait.
 */
export function recordAuthFailure(
  address: string | null,
  now: number = Date.now(),
): ThrottleDecision {
  if (!address) return { allowed: true };
  sweep(now);

  const entry = entries.get(address) ?? {
    failures: 0,
    lockedUntil: 0,
    lockoutMs: 0,
    touchedAt: now,
  };
  entry.failures += 1;
  entry.touchedAt = now;

  if (entry.failures >= FAILURES_BEFORE_LOCKOUT) {
    entry.lockoutMs =
      entry.lockoutMs === 0
        ? BASE_LOCKOUT_MS
        : Math.min(entry.lockoutMs * 2, MAX_LOCKOUT_MS);
    entry.lockedUntil = now + entry.lockoutMs;
  }

  entries.set(address, entry);
  return entry.lockedUntil > now
    ? { allowed: false, retryAfterMs: entry.lockedUntil - now }
    : { allowed: true };
}

/** A success wipes the address's history entirely. */
export function recordAuthSuccess(address: string | null): void {
  if (!address) return;
  entries.delete(address);
}

/** Test seam. */
export function resetAuthThrottle(): void {
  entries.clear();
}
