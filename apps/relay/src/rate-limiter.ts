import { config } from "./config.js";

export interface RateLimiter {
  check(): boolean;
  reset(): void;
}

export function createRateLimiter(): RateLimiter {
  const limit = config.wsRateLimit;
  let count = 0;
  let windowStart = Date.now();

  return {
    check(): boolean {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        count = 0;
        windowStart = now;
      }
      count++;
      return count <= limit;
    },
    reset() {
      count = 0;
      windowStart = Date.now();
    },
  };
}
