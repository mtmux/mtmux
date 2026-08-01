import { describe, it, expect, beforeEach } from "vitest";
import {
  issuePairingNonce,
  redeemPairingNonce,
  issueSessionToken,
  isValidSessionToken,
  revokeSessionToken,
  hasLivePairingNonce,
  resetPairingState,
  registerSessionToken,
  labelForToken,
} from "./pairing-local.js";
import { FULL_GRANT } from "./grant.js";

const T0 = 1_700_000_000_000;

describe("local pairing nonces", () => {
  beforeEach(resetPairingState);

  it("is disarmed until a nonce is issued", () => {
    expect(hasLivePairingNonce(T0)).toBe(false);
    expect(redeemPairingNonce("anything", T0)).toBeNull();
  });

  it("redeems a fresh nonce for a session token", () => {
    const { nonce } = issuePairingNonce(60_000, T0);
    const session = redeemPairingNonce(nonce, T0);
    expect(session).not.toBeNull();
    expect(session!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(session!.expiresAt).toBeGreaterThan(T0);
  });

  it("burns the nonce — a second redemption fails", () => {
    const { nonce } = issuePairingNonce(60_000, T0);
    expect(redeemPairingNonce(nonce, T0)).not.toBeNull();
    expect(redeemPairingNonce(nonce, T0)).toBeNull();
  });

  it("rejects an expired nonce", () => {
    const { nonce } = issuePairingNonce(60_000, T0);
    expect(redeemPairingNonce(nonce, T0 + 60_001)).toBeNull();
  });

  it("rejects a nonce that was never issued", () => {
    issuePairingNonce(60_000, T0);
    expect(redeemPairingNonce("not-the-nonce", T0)).toBeNull();
  });

  it("keeps only the most recently issued nonce live", () => {
    const first = issuePairingNonce(60_000, T0);
    const second = issuePairingNonce(60_000, T0);
    expect(redeemPairingNonce(first.nonce, T0)).toBeNull();
    expect(redeemPairingNonce(second.nonce, T0)).not.toBeNull();
  });

  it("issues distinct nonces", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(issuePairingNonce(60_000, T0).nonce);
    expect(seen.size).toBe(50);
  });
});

describe("session tokens", () => {
  beforeEach(resetPairingState);

  it("validates a token it issued", () => {
    const { token } = issueSessionToken(1000, T0);
    expect(isValidSessionToken(token, T0)).toBe(true);
  });

  it("rejects an unknown token", () => {
    issueSessionToken(1000, T0);
    expect(isValidSessionToken("f".repeat(64), T0)).toBe(false);
  });

  it("rejects a token past its expiry", () => {
    const { token } = issueSessionToken(1000, T0);
    // Ordered earliest-first: checking an expired token also evicts it, so a
    // later "still valid" assertion would fail for the wrong reason.
    expect(isValidSessionToken(token, T0 + 999)).toBe(true);
    expect(isValidSessionToken(token, T0 + 1000)).toBe(false);
  });

  it("supports explicit revocation", () => {
    const { token } = issueSessionToken(10_000, T0);
    revokeSessionToken(token);
    expect(isValidSessionToken(token, T0)).toBe(false);
  });

  it("keeps multiple devices signed in independently", () => {
    const a = issueSessionToken(10_000, T0);
    const b = issueSessionToken(10_000, T0);
    revokeSessionToken(a.token);
    expect(isValidSessionToken(a.token, T0)).toBe(false);
    expect(isValidSessionToken(b.token, T0)).toBe(true);
  });

  it("forgets everything on reset — a restart revokes all devices", () => {
    const { token } = issueSessionToken(10_000, T0);
    resetPairingState();
    expect(isValidSessionToken(token, T0)).toBe(false);
  });
});

describe("session token labels", () => {
  it("remembers what the CLI called the device", () => {
    const token = "c".repeat(64);
    registerSessionToken(
      token,
      60_000,
      Date.now(),
      FULL_GRANT,
      "iPhone · Safari",
    );
    expect(labelForToken(token)).toBe("iPhone · Safari");
  });

  it("has no label when none was supplied", () => {
    const token = "d".repeat(64);
    registerSessionToken(token, 60_000);
    expect(labelForToken(token)).toBeNull();
  });

  it("forgets the label once the token expires", () => {
    const token = "e".repeat(64);
    const now = Date.now();
    registerSessionToken(token, 1_000, now, FULL_GRANT, "Ghost");
    expect(labelForToken(token, now + 2_000)).toBeNull();
  });

  it("says nothing about a token it has never seen", () => {
    expect(labelForToken("f".repeat(64))).toBeNull();
  });
});
