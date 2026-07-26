import { describe, it, expect } from "vitest";
import {
  generateDeviceKey,
  deviceIdFor,
  newChallenge,
  signChallenge,
  verifyChallenge,
  encodeDeviceKey,
  decodeDeviceKey,
  CHALLENGE_BYTES,
} from "./device-key.js";
import { bytesToHex, randomBytes } from "./bytes.js";

describe("device keys", () => {
  it("generates a 32-byte keypair with a stable 16-hex id", () => {
    const key = generateDeviceKey();
    expect(key.publicKey).toHaveLength(32);
    expect(key.secretKey).toHaveLength(32);
    expect(key.deviceId).toMatch(/^[0-9a-f]{16}$/);
    expect(key.deviceId).toBe(deviceIdFor(key.publicKey));
  });

  it("gives every device a distinct identity", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(generateDeviceKey().deviceId);
    expect(ids.size).toBe(50);
  });

  it("derives the id from the public key, not at random", () => {
    const key = generateDeviceKey();
    expect(deviceIdFor(key.publicKey)).toBe(deviceIdFor(key.publicKey));
  });
});

describe("challenge signing", () => {
  it("issues 32-byte challenges that never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const c = newChallenge();
      expect(c).toHaveLength(CHALLENGE_BYTES);
      seen.add(bytesToHex(c));
    }
    expect(seen.size).toBe(100);
  });

  it("verifies a signature from the matching key", () => {
    const key = generateDeviceKey();
    const challenge = newChallenge();
    const sig = signChallenge(key.secretKey, challenge);
    expect(verifyChallenge(key.publicKey, challenge, sig)).toBe(true);
  });

  it("rejects a signature from a different device", () => {
    const mine = generateDeviceKey();
    const theirs = generateDeviceKey();
    const challenge = newChallenge();
    const sig = signChallenge(theirs.secretKey, challenge);
    expect(verifyChallenge(mine.publicKey, challenge, sig)).toBe(false);
  });

  it("rejects a signature over a different challenge — no replay", () => {
    const key = generateDeviceKey();
    const sig = signChallenge(key.secretKey, newChallenge());
    expect(verifyChallenge(key.publicKey, newChallenge(), sig)).toBe(false);
  });

  it("rejects a tampered signature without throwing", () => {
    const key = generateDeviceKey();
    const challenge = newChallenge();
    const sig = signChallenge(key.secretKey, challenge);
    sig[0] = (sig[0] ?? 0) ^ 0xff;
    expect(verifyChallenge(key.publicKey, challenge, sig)).toBe(false);
  });

  it("rejects garbage of the wrong length without throwing", () => {
    const key = generateDeviceKey();
    const challenge = newChallenge();
    expect(verifyChallenge(key.publicKey, challenge, new Uint8Array(10))).toBe(
      false,
    );
    expect(verifyChallenge(new Uint8Array(5), challenge, randomBytes(64))).toBe(
      false,
    );
  });
});

describe("device key storage", () => {
  it("round-trips through the stored form", () => {
    const key = generateDeviceKey();
    const restored = decodeDeviceKey(encodeDeviceKey(key));
    expect(restored.deviceId).toBe(key.deviceId);
    expect(bytesToHex(restored.publicKey)).toBe(bytesToHex(key.publicKey));
    expect(bytesToHex(restored.secretKey)).toBe(bytesToHex(key.secretKey));
  });

  it("still signs correctly after a round trip", () => {
    const restored = decodeDeviceKey(encodeDeviceKey(generateDeviceKey()));
    const challenge = newChallenge();
    expect(
      verifyChallenge(
        restored.publicKey,
        challenge,
        signChallenge(restored.secretKey, challenge),
      ),
    ).toBe(true);
  });

  it("refuses a stored id that disagrees with its public key", () => {
    const stored = encodeDeviceKey(generateDeviceKey());
    stored.deviceId = "0".repeat(16);
    expect(() => decodeDeviceKey(stored)).toThrow(/does not match/);
  });

  it("refuses malformed key material", () => {
    const stored = encodeDeviceKey(generateDeviceKey());
    expect(() =>
      decodeDeviceKey({ ...stored, deviceId: "", publicKey: "aabb" }),
    ).toThrow(/malformed/);
  });
});
