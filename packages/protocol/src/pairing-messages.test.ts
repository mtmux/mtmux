import { describe, it, expect } from "vitest";
import {
  PairingClientMessage,
  PairingServerMessage,
  TunnelClientMessage,
  TunnelServerMessage,
  PairClaimRequest,
  SealedDescriptor,
  tryDeserializePairingServerMessage,
  tryDeserializeTunnelServerMessage,
} from "./pairing-messages";

const HEX32 = "a".repeat(64);
const HEX16 = "b".repeat(32);
const HEX8 = "c".repeat(16);
const HEX64 = "d".repeat(128);

describe("pairing client messages", () => {
  it("accepts a well-formed share", () => {
    expect(
      PairingClientMessage.safeParse({
        type: "pair:share",
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
        PairingClientMessage.safeParse({ type: "pair:share", share, ad: "" })
          .success,
      ).toBe(false);
    }
  });

  it("accepts confirm and close", () => {
    expect(
      PairingClientMessage.safeParse({ type: "pair:confirm", tag: HEX32 })
        .success,
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
        slot: "49",
        expiresAt: Date.now() + 1000,
      }).success,
    ).toBe(true);
  });

  it("requires a two-digit slot, leading zeros allowed", () => {
    const base = {
      type: "pair:ready" as const,
      mailboxId: "mailbox-123",
      expiresAt: 1,
    };
    expect(
      PairingServerMessage.safeParse({ ...base, slot: "00" }).success,
    ).toBe(true);
    for (const slot of ["0", "490", "4a", ""]) {
      expect(PairingServerMessage.safeParse({ ...base, slot }).success).toBe(
        false,
      );
    }
  });

  it("accepts pair:claimed with a 16-byte sid", () => {
    expect(
      PairingServerMessage.safeParse({
        type: "pair:claimed",
        share: HEX32,
        ad: "cli",
        sid: HEX16,
      }).success,
    ).toBe(true);
    expect(
      PairingServerMessage.safeParse({
        type: "pair:claimed",
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
        slot: "49",
        share: HEX32,
        ad: "cli",
        sid: HEX16,
      }).success,
    ).toBe(true);
  });

  it("rejects a claim carrying anything secret-shaped in the slot", () => {
    expect(
      PairClaimRequest.safeParse({
        slot: "492716",
        share: HEX32,
        ad: "cli",
        sid: HEX16,
      }).success,
    ).toBe(false);
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
