import { describe, it, expect } from "vitest";
import { FrameSealer, FrameOpener, createFramePair } from "./frames";
import { randomBytes, utf8ToBytes, bytesToHex } from "./bytes";

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const HELLO = utf8ToBytes("hello tmux");

describe("sealed frames", () => {
  it("round-trips a payload", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const opener = new FrameOpener(KEY, "c2s");
    const opened = await opener.open(await sealer.seal(HELLO));
    expect(bytesToHex(opened)).toBe(bytesToHex(HELLO));
  });

  it("round-trips an empty payload", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const opener = new FrameOpener(KEY, "c2s");
    const opened = await opener.open(await sealer.seal(new Uint8Array()));
    expect(opened).toHaveLength(0);
  });

  it("round-trips a large payload", async () => {
    // getRandomValues caps at 64 KiB per call, so build the buffer in chunks.
    const big = new Uint8Array(200_000);
    for (let off = 0; off < big.length; off += 32_768) {
      big.set(randomBytes(Math.min(32_768, big.length - off)), off);
    }
    const sealer = new FrameSealer(KEY, "s2c");
    const opener = new FrameOpener(KEY, "s2c");
    expect(bytesToHex(await opener.open(await sealer.seal(big)))).toBe(
      bytesToHex(big),
    );
  });

  it("never emits the plaintext on the wire", async () => {
    const secret = utf8ToBytes("SUPER_SECRET_TOKEN_VALUE");
    const frame = await new FrameSealer(KEY, "c2s").seal(secret);
    expect(bytesToHex(frame)).not.toContain(bytesToHex(secret));
  });

  it("produces a different ciphertext each time for identical plaintext", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const a = await sealer.seal(HELLO);
    const b = await sealer.seal(HELLO);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("keeps a monotonic counter in the clear", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    for (let i = 0; i < 5; i++) {
      const frame = await sealer.seal(HELLO);
      expect(new DataView(frame.buffer).getBigUint64(0, false)).toBe(BigInt(i));
    }
    expect(sealer.sent).toBe(5n);
  });

  it("preserves ordering across many frames", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const opener = new FrameOpener(KEY, "c2s");
    for (let i = 0; i < 50; i++) {
      const payload = utf8ToBytes(`frame-${i}`);
      const opened = await opener.open(await sealer.seal(payload));
      expect(new TextDecoder().decode(opened)).toBe(`frame-${i}`);
    }
    expect(opener.highestSeen).toBe(49n);
  });
});

describe("sealed frames reject tampering", () => {
  it("rejects a flipped ciphertext byte", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const opener = new FrameOpener(KEY, "c2s");
    const frame = await sealer.seal(HELLO);
    frame[10] = (frame[10] ?? 0) ^ 0x01;
    await expect(opener.open(frame)).rejects.toThrow(/failed authentication/);
  });

  it("rejects a flipped tag byte", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const opener = new FrameOpener(KEY, "c2s");
    const frame = await sealer.seal(HELLO);
    frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 0x80;
    await expect(opener.open(frame)).rejects.toThrow(/failed authentication/);
  });

  it("rejects a rewritten counter", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const opener = new FrameOpener(KEY, "c2s");
    await sealer.seal(HELLO); // burn counter 0
    const frame = await sealer.seal(HELLO); // counter 1
    new DataView(frame.buffer).setBigUint64(0, 99n, false);
    await expect(opener.open(frame)).rejects.toThrow(/failed authentication/);
  });

  it("rejects a truncated frame", async () => {
    const opener = new FrameOpener(KEY, "c2s");
    await expect(opener.open(new Uint8Array(8))).rejects.toThrow(/truncated/);
    await expect(opener.open(new Uint8Array(3))).rejects.toThrow(/truncated/);
  });

  it("rejects a frame sealed under a different key", async () => {
    const frame = await new FrameSealer(OTHER_KEY, "c2s").seal(HELLO);
    await expect(new FrameOpener(KEY, "c2s").open(frame)).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("rejects a frame reflected back at its sender's direction", async () => {
    // Same key, wrong direction tag — the nonce differs, so GCM refuses.
    const frame = await new FrameSealer(KEY, "c2s").seal(HELLO);
    await expect(new FrameOpener(KEY, "s2c").open(frame)).rejects.toThrow(
      /failed authentication/,
    );
  });
});

describe("sealed frames reject replay", () => {
  it("refuses the same frame twice", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const opener = new FrameOpener(KEY, "c2s");
    const frame = await sealer.seal(HELLO);
    await opener.open(frame);
    await expect(opener.open(frame)).rejects.toThrow(/Replayed or reordered/);
  });

  it("refuses an out-of-order frame", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const opener = new FrameOpener(KEY, "c2s");
    const first = await sealer.seal(HELLO);
    const second = await sealer.seal(HELLO);
    await opener.open(second);
    await expect(opener.open(first)).rejects.toThrow(/Replayed or reordered/);
  });

  it("does not advance its counter on a rejected frame", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const opener = new FrameOpener(KEY, "c2s");
    await opener.open(await sealer.seal(HELLO));

    // A forged frame claiming a far-future counter must not lock out the
    // legitimate stream that follows it.
    const forged = await new FrameSealer(OTHER_KEY, "c2s").seal(HELLO);
    new DataView(forged.buffer).setBigUint64(0, 10_000n, false);
    await expect(opener.open(forged)).rejects.toThrow();
    expect(opener.highestSeen).toBe(0n);

    const legit = await sealer.seal(utf8ToBytes("still fine"));
    expect(new TextDecoder().decode(await opener.open(legit))).toBe(
      "still fine",
    );
  });
});

describe("createFramePair", () => {
  const keys = { c2s: KEY, s2c: OTHER_KEY };

  it("wires browser and CLI so each opens what the other seals", async () => {
    const browser = createFramePair(keys, "browser");
    const cli = createFramePair(keys, "cli");

    const up = await browser.sealer.seal(utf8ToBytes("ls -la"));
    expect(new TextDecoder().decode(await cli.opener.open(up))).toBe("ls -la");

    const down = await cli.sealer.seal(utf8ToBytes("total 0"));
    expect(new TextDecoder().decode(await browser.opener.open(down))).toBe(
      "total 0",
    );
  });

  it("does not let a side open its own frames", async () => {
    const browser = createFramePair(keys, "browser");
    const frame = await browser.sealer.seal(HELLO);
    await expect(browser.opener.open(frame)).rejects.toThrow();
  });
});

describe("key validation", () => {
  it("refuses a key that is not 32 bytes", async () => {
    await expect(
      new FrameSealer(new Uint8Array(16), "c2s").seal(HELLO),
    ).rejects.toThrow(/32-byte/);
  });
});
