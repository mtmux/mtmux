/**
 * Per-key sliding-window rate limiting.
 *
 * These limits carry part of the security argument rather than being polite
 * capacity management: the guessing bound assumes an attacker cannot spray
 * claims across every slot, and the mailbox limit stops one client filling
 * every slot to raise its odds of a collision.
 */

export type RateLimiter = {
  /** Consume one unit. False means the caller is over the limit. */
  take(key: string, now?: number): boolean;
  /** Milliseconds until the oldest hit in the window expires. */
  retryAfterMs(key: string, now?: number): number;
  reset(): void;
};

/** Keys untouched for this long are dropped, bounding memory. */
const IDLE_EVICT_MS = 10 * 60 * 1000;
const MAX_KEYS = 50_000;

export function createRateLimiter(
  limit: number,
  windowMs = 60_000,
): RateLimiter {
  /** key → timestamps of hits inside the window, oldest first. */
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  function prune(key: string, now: number): number[] {
    const cutoff = now - windowMs;
    const times = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (times.length === 0) hits.delete(key);
    else hits.set(key, times);
    return times;
  }

  function sweep(now: number): void {
    if (now - lastSweep < IDLE_EVICT_MS && hits.size < MAX_KEYS) return;
    lastSweep = now;
    const cutoff = now - windowMs;
    for (const [key, times] of hits) {
      if (times.every((t) => t <= cutoff)) hits.delete(key);
    }
  }

  return {
    take(key, now = Date.now()) {
      sweep(now);
      const times = prune(key, now);
      if (times.length >= limit) return false;
      times.push(now);
      hits.set(key, times);
      return true;
    },

    retryAfterMs(key, now = Date.now()) {
      const times = prune(key, now);
      const oldest = times[0];
      if (oldest === undefined || times.length < limit) return 0;
      return Math.max(0, oldest + windowMs - now);
    },

    reset() {
      hits.clear();
      lastSweep = 0;
    },
  };
}
