import { describe, it, expect } from "vitest";
import {
  PairingClientMessage,
  PairingServerMessage,
  TunnelClientMessage,
  TunnelServerMessage,
  PairClaimRequest,
  SealedDescriptor,
  codeDeadline,
  MIN_CODE_TTL_MS,
  MAX_CODE_TTL_MS,
  tryDeserializePairingServerMessage,
  tryDeserializeTunnelServerMessage,
} from "./pairing-messages";
import { PROTOCOL_VERSION } from "./version";

const HEX32 = "a".repeat(64);
const HEX16 = "b".repeat(32);
const HEX8 = "c".repeat(16);
const HEX64 = "d".repeat(128);

describe("pairing client messages", () => {
  it("accepts a well-formed share", () => {
    expect(
      PairingClientMessage.safeParse({
        type: "pair:share",
        peer: "peer-1",
        share: HEX32,
        ad: "browser",
      }).success,
    ).toBe(true);
  });

  it("rejects a share that is not 32 hex bytes", () => {
    for (const share of [
      "a".repeat(63),
      "a".repeat(66),
      "A".repeat(64),
      "zz",
    ]) {
      expect(
        PairingClientMessage.safeParse({
          type: "pair:share",
          peer: "peer-1",
          share,
          ad: "",
        }).success,
      ).toBe(false);
    }
  });

  it("accepts confirm and close", () => {
    expect(
      PairingClientMessage.safeParse({
        type: "pair:confirm",
        peer: "peer-1",
        tag: HEX32,
      }).success,
    ).toBe(true);
    expect(PairingClientMessage.safeParse({ type: "pair:close" }).success).toBe(
      true,
    );
  });

  it("rejects an unknown type", () => {
    expect(
      PairingClientMessage.safeParse({ type: "pair:whatever" }).success,
    ).toBe(false);
  });

  it("caps associated data so a mailbox cannot be used as storage", () => {
    expect(
      PairingClientMessage.safeParse({
        type: "pair:share",
        peer: "peer-1",
        share: HEX32,
        ad: "x".repeat(257),
      }).success,
    ).toBe(false);
  });
});

describe("pairing server messages", () => {
  it("accepts pair:ready", () => {
    expect(
      PairingServerMessage.safeParse({
        type: "pair:ready",
        mailboxId: "mailbox-123",
        slot: "492",
        expiresAt: Date.now() + 1000,
      }).success,
    ).toBe(true);
  });

  it("accepts a three- or four-digit slot, leading zeros allowed", () => {
    // Two spaces, not one: the typed code routes on three digits and the
    // scanned one on four, so that a sweep of the typed space cannot reach a
    // scanned pairing. Nothing else is a slot — two digits was the 0.6.x width
    // and is refused outright, which is what makes the break clean.
    const base = {
      type: "pair:ready" as const,
      mailboxId: "mailbox-123",
      expiresAt: 1,
    };
    for (const slot of ["000", "492", "0000", "0492"]) {
      expect(PairingServerMessage.safeParse({ ...base, slot }).success).toBe(
        true,
      );
    }
    for (const slot of ["0", "49", "00492", "4a2", ""]) {
      expect(PairingServerMessage.safeParse({ ...base, slot }).success).toBe(
        false,
      );
    }
  });

  it("accepts pair:peer-share with a 16-byte sid", () => {
    expect(
      PairingServerMessage.safeParse({
        type: "pair:peer-share",
        peer: "peer-1",
        share: HEX32,
        ad: "cli",
        sid: HEX16,
      }).success,
    ).toBe(true);
    expect(
      PairingServerMessage.safeParse({
        type: "pair:peer-share",
        peer: "peer-1",
        share: HEX32,
        ad: "cli",
        sid: HEX32,
      }).success,
    ).toBe(false);
  });

  it("constrains pair:failed to known reasons", () => {
    expect(
      PairingServerMessage.safeParse({
        type: "pair:failed",
        reason: "confirmation-failed",
      }).success,
    ).toBe(true);
    expect(
      PairingServerMessage.safeParse({ type: "pair:failed", reason: "meh" })
        .success,
    ).toBe(false);
  });

  it("round-trips through the codec", () => {
    const msg = {
      type: "pair:established" as const,
      peer: "peer-1",
      sealedDescriptor: "AAEC-_8",
    };
    const parsed = tryDeserializePairingServerMessage(JSON.stringify(msg));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message).toEqual(msg);
  });

  it("reports a parse error rather than throwing", () => {
    const parsed = tryDeserializePairingServerMessage("{not json");
    expect(parsed.ok).toBe(false);
  });
});

describe("tunnel messages", () => {
  it("accepts a signed registration", () => {
    expect(
      TunnelClientMessage.safeParse({
        type: "tunnel:register",
        deviceId: HEX8,
        publicKey: HEX32,
        challenge: HEX32,
        signature: HEX64,
      }).success,
    ).toBe(true);
  });

  it("rejects a registration with a short signature", () => {
    expect(
      TunnelClientMessage.safeParse({
        type: "tunnel:register",
        deviceId: HEX8,
        publicKey: HEX32,
        challenge: HEX32,
        signature: HEX32,
      }).success,
    ).toBe(false);
  });

  it("accepts base64url frame payloads and rejects other encodings", () => {
    const frame = (data: string) => ({
      type: "stream:frame" as const,
      streamId: "s1",
      data,
    });
    expect(TunnelClientMessage.safeParse(frame("AAEC-_8")).success).toBe(true);
    expect(TunnelClientMessage.safeParse(frame("")).success).toBe(true);
    expect(TunnelClientMessage.safeParse(frame("AA+C/w==")).success).toBe(
      false,
    );
  });

  it("bounds frame size", () => {
    expect(
      TunnelClientMessage.safeParse({
        type: "stream:frame",
        streamId: "s1",
        data: "A".repeat(3_000_000),
      }).success,
    ).toBe(false);
  });

  it("does not let a client send stream:open — only the broker opens streams", () => {
    expect(
      TunnelClientMessage.safeParse({ type: "stream:open", streamId: "s1" })
        .success,
    ).toBe(false);
    expect(
      TunnelServerMessage.safeParse({ type: "stream:open", streamId: "s1" })
        .success,
    ).toBe(true);
  });

  it("constrains tunnel:closed to known reasons", () => {
    expect(
      TunnelServerMessage.safeParse({
        type: "tunnel:closed",
        reason: "revoked",
      }).success,
    ).toBe(true);
    expect(
      TunnelServerMessage.safeParse({
        type: "tunnel:closed",
        reason: "because",
      }).success,
    ).toBe(false);
  });

  it("round-trips through the codec", () => {
    const parsed = tryDeserializeTunnelServerMessage(
      JSON.stringify({ type: "tunnel:ready", tunnelId: "tunnel-abcdef" }),
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("HTTP bodies", () => {
  it("validates a claim request", () => {
    expect(
      PairClaimRequest.safeParse({
        v: PROTOCOL_VERSION,
        slot: "492",
        share: HEX32,
        ad: "cli",
        sid: HEX16,
      }).success,
    ).toBe(true);
  });

  it("rejects a claim carrying anything secret-shaped in the slot", () => {
    // A client that posted the whole code would hand the broker the PAKE
    // password. No typed code length is a valid slot width, so they bounce.
    for (const slot of ["492716", "492716384"]) {
      expect(
        PairClaimRequest.safeParse({
          v: PROTOCOL_VERSION,
          slot,
          share: HEX32,
          ad: "cli",
          sid: HEX16,
        }).success,
      ).toBe(false);
    }
  });

  it("clamps a code deadline into the range a mailbox can have", () => {
    const now = 1_700_000_000_000;
    // A broker whose clock is three minutes ahead of ours.
    expect(codeDeadline(now - 180_000, undefined, now)).toBe(
      now + MIN_CODE_TTL_MS,
    );
    // A duration is preferred, because a duration cannot skew.
    expect(codeDeadline(now - 180_000, 120_000, now)).toBe(now + 120_000);
    // And an absurd one is still bounded.
    expect(codeDeadline(now, 86_400_000, now)).toBe(now + MAX_CODE_TTL_MS);
  });

  it("validates a sealed descriptor's plaintext shape", () => {
    expect(
      SealedDescriptor.safeParse({
        candidates: ["https://swift-otter.lan.mtmux.com:14100"],
        tunnelId: "tunnel-abcdef",
        deviceId: HEX8,
        publicKey: HEX32,
        label: "gagan@thinkpad",
      }).success,
    ).toBe(true);
  });

  it("bounds the candidate list", () => {
    expect(
      SealedDescriptor.safeParse({
        candidates: Array.from({ length: 9 }, () => "https://example.com"),
        tunnelId: "tunnel-abcdef",
        deviceId: HEX8,
        publicKey: HEX32,
        label: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-URL candidate", () => {
    expect(
      SealedDescriptor.safeParse({
        candidates: ["not a url"],
        tunnelId: "tunnel-abcdef",
        deviceId: HEX8,
        publicKey: HEX32,
        label: "x",
      }).success,
    ).toBe(false);
  });
});
