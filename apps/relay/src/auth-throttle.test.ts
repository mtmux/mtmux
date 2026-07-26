import { describe, it, expect, beforeEach } from "vitest";
import {
  checkAuthThrottle,
  recordAuthFailure,
  recordAuthSuccess,
  resetAuthThrottle,
  FAILURES_BEFORE_LOCKOUT,
  BASE_LOCKOUT_MS,
  MAX_LOCKOUT_MS,
} from "./auth-throttle.js";

const IP = "192.168.1.50";
const T0 = 1_700_000_000_000;

function fail(times: number, at = T0) {
  let last = recordAuthFailure(IP, at);
  for (let i = 1; i < times; i++) last = recordAuthFailure(IP, at);
  return last;
}

describe("auth throttle", () => {
  beforeEach(resetAuthThrottle);

  it("allows attempts from an address it has never seen", () => {
    expect(checkAuthThrottle(IP, T0)).toEqual({ allowed: true });
  });

  it("allows the first four failures without locking out", () => {
    for (let i = 0; i < FAILURES_BEFORE_LOCKOUT - 1; i++) {
      expect(recordAuthFailure(IP, T0)).toEqual({ allowed: true });
      expect(checkAuthThrottle(IP, T0)).toEqual({ allowed: true });
    }
  });

  it("locks out for 30s on the fifth failure", () => {
    const decision = fail(FAILURES_BEFORE_LOCKOUT);
    expect(decision).toEqual({
      allowed: false,
      retryAfterMs: BASE_LOCKOUT_MS,
    });
    expect(checkAuthThrottle(IP, T0)).toEqual({
      allowed: false,
      retryAfterMs: BASE_LOCKOUT_MS,
    });
  });

  it("lets the address back in once the lockout elapses", () => {
    fail(FAILURES_BEFORE_LOCKOUT);
    expect(checkAuthThrottle(IP, T0 + BASE_LOCKOUT_MS - 1).allowed).toBe(false);
    expect(checkAuthThrottle(IP, T0 + BASE_LOCKOUT_MS)).toEqual({
      allowed: true,
    });
  });

  it("doubles the lockout on each further failure", () => {
    fail(FAILURES_BEFORE_LOCKOUT);
    let expected = BASE_LOCKOUT_MS;
    for (let i = 0; i < 4; i++) {
      expected *= 2;
      const at = T0 + i + 1;
      expect(recordAuthFailure(IP, at)).toEqual({
        allowed: false,
        retryAfterMs: expected,
      });
    }
  });

  it("caps the lockout at 15 minutes", () => {
    fail(FAILURES_BEFORE_LOCKOUT);
    let last = { allowed: true } as ReturnType<typeof recordAuthFailure>;
    for (let i = 0; i < 20; i++) last = recordAuthFailure(IP, T0);
    expect(last).toEqual({ allowed: false, retryAfterMs: MAX_LOCKOUT_MS });
  });

  it("clears the whole history on a success", () => {
    fail(FAILURES_BEFORE_LOCKOUT);
    expect(checkAuthThrottle(IP, T0).allowed).toBe(false);
    recordAuthSuccess(IP);
    expect(checkAuthThrottle(IP, T0)).toEqual({ allowed: true });
    // And the backoff restarts from 30s rather than resuming where it left off.
    expect(fail(FAILURES_BEFORE_LOCKOUT)).toEqual({
      allowed: false,
      retryAfterMs: BASE_LOCKOUT_MS,
    });
  });

  it("tracks addresses independently", () => {
    fail(FAILURES_BEFORE_LOCKOUT);
    expect(checkAuthThrottle(IP, T0).allowed).toBe(false);
    expect(checkAuthThrottle("10.0.0.9", T0).allowed).toBe(true);
  });

  it("never throttles when the address is unknown", () => {
    for (let i = 0; i < 50; i++) {
      expect(recordAuthFailure(null, T0)).toEqual({ allowed: true });
    }
    expect(checkAuthThrottle(null, T0)).toEqual({ allowed: true });
  });
});
