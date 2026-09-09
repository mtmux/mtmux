import { describe, it, expect } from "vitest";
import {
  FrameSealer,
  FrameOpener,
  StreamOpener,
  sealOnce,
  openOnce,
  SALT_BYTES,
} from "./frames";
import { randomBytes, utf8ToBytes, bytesToHex } from "./bytes";

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const HELLO = utf8ToBytes("hello tmux");

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * Open a stream the way production does: bind on the first frame, then feed
 * the rest to the opener it returned.
 */
async function boundPair(key: Uint8Array, direction: "c2s" | "s2c") {
  const sealer = new FrameSealer(key, direction);
  let opener: FrameOpener | null = null;
  return {
    sealer,
    async roundTrip(plaintext: Uint8Array): Promise<Uint8Array> {
      const frame = await sealer.seal(plaintext);
      if (!opener) {
        const bound = await StreamOpener.bind(key, direction, frame);
        opener = bound.opener;
        return bound.plaintext;
      }
      return opener.open(frame);
    },
    get opener() {
      return opener;
    },
  };
}

describe("sealed frames", () => {
  it("round-trips a payload", async () => {
    const stream = await boundPair(KEY, "c2s");
    expect(bytesToHex(await stream.roundTrip(HELLO))).toBe(bytesToHex(HELLO));
  });

  it("round-trips an empty payload", async () => {
    const stream = await boundPair(KEY, "c2s");
    expect(await stream.roundTrip(new Uint8Array())).toHaveLength(0);
  });

  it("round-trips a large payload", async () => {
    // getRandomValues caps at 64 KiB per call, so build the buffer in chunks.
    const big = new Uint8Array(200_000);
    for (let off = 0; off < big.length; off += 32_768) {
      big.set(randomBytes(Math.min(32_768, big.length - off)), off);
    }
    const stream = await boundPair(KEY, "s2c");
    expect(bytesToHex(await stream.roundTrip(big))).toBe(bytesToHex(big));
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

  /**
   * The regression test for the whole bug.
   *
   * Two sealers on one session key used to be two encryptions under the same
   * (key, nonce) — deterministic, XOR-recoverable, and enough to recover the
   * GHASH subkey. Now each draws its own salt, so the same plaintext at the
   * same counter produces unrelated ciphertext.
   */
  it("gives two sealers on one key different salts and different ciphertext", async () => {
    const a = new FrameSealer(KEY, "s2c");
    const b = new FrameSealer(KEY, "s2c");
    expect(bytesToHex(a.salt)).not.toBe(bytesToHex(b.salt));

    const fa = await a.seal(HELLO);
    const fb = await b.seal(HELLO);
    expect(bytesToHex(fa)).not.toBe(bytesToHex(fb));

    // And specifically not merely different in the salt prefix: the bodies,
    // which is where an XOR attack would live, differ too.
    expect(bytesToHex(fa.subarray(SALT_BYTES))).not.toBe(
      bytesToHex(fb.subarray(SALT_BYTES)),
    );
  });

  it("puts the salt on frame 0 and nowhere else", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const first = await sealer.seal(HELLO);
    const second = await sealer.seal(HELLO);
    expect(bytesToHex(first.subarray(0, SALT_BYTES))).toBe(
      bytesToHex(sealer.salt),
    );
    // 16 salt + 8 counter + tag vs 8 counter + tag, same plaintext length.
    expect(first.length - second.length).toBe(SALT_BYTES);
  });

  it("keeps a monotonic counter in the clear", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    for (let i = 0; i < 5; i++) {
      const frame = await sealer.seal(HELLO);
      const at = i === 0 ? SALT_BYTES : 0;
      const view = new DataView(frame.buffer, frame.byteOffset + at, 8);
      expect(view.getBigUint64(0, false)).toBe(BigInt(i));
    }
    expect(sealer.sent).toBe(5n);
  });

  it("preserves ordering across many frames", async () => {
    const stream = await boundPair(KEY, "c2s");
    for (let i = 0; i < 50; i++) {
      const opened = await stream.roundTrip(utf8ToBytes(`frame-${i}`));
      expect(decode(opened)).toBe(`frame-${i}`);
    }
    expect(stream.opener?.highestSeen).toBe(49n);
  });
});

describe("StreamOpener.bind", () => {
  it("binds on the first frame and continues on unsalted ones", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const { opener, plaintext } = await StreamOpener.bind(
      KEY,
      "c2s",
      await sealer.seal(utf8ToBytes("first")),
    );
    expect(decode(plaintext)).toBe("first");
    expect(
      decode(await opener.open(await sealer.seal(utf8ToBytes("second")))),
    ).toBe("second");
  });

  /**
   * Without this a later frame could be replayed as an opener, which would
   * reset the receiver's replay window to that frame's counter.
   */
  it("refuses a first frame whose counter is not zero", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    await sealer.seal(HELLO); // burn 0
    const second = await sealer.seal(HELLO); // counter 1, no salt
    // Give it a salt prefix so it is the right *shape* but the wrong counter.
    const forged = new Uint8Array(SALT_BYTES + second.length);
    forged.set(sealer.salt, 0);
    forged.set(second, SALT_BYTES);
    await expect(StreamOpener.bind(KEY, "c2s", forged)).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("refuses a frame salted for the other direction", async () => {
    const frame = await new FrameSealer(KEY, "c2s").seal(HELLO);
    await expect(StreamOpener.bind(KEY, "s2c", frame)).rejects.toThrow(
      /failed authentication/,
    );
  });

  /**
   * The descriptor-collision regression. Same key, same direction, same
   * counter — separated only by what the bytes are for.
   */
  it("refuses a frame sealed under the other purpose", async () => {
    const descriptor = await sealOnce(KEY, "s2c", HELLO);
    await expect(
      StreamOpener.bind(KEY, "s2c", descriptor, { purpose: "frame" }),
    ).rejects.toThrow(/failed authentication/);
  });

  /**
   * Trial decryption runs this against untrusted bytes, so "not this pairing"
   * and "malformed" must be indistinguishable.
   */
  it("reports a truncated first frame exactly as it reports a wrong key", async () => {
    const message = async (frame: Uint8Array) => {
      try {
        await StreamOpener.bind(KEY, "c2s", frame);
        return "no error";
      } catch (err) {
        return (err as Error).message;
      }
    };

    const wrongKey = await message(
      await new FrameSealer(OTHER_KEY, "c2s").seal(HELLO),
    );
    const truncated = await message(new Uint8Array(SALT_BYTES + 4));
    expect(wrongKey).toBe("Sealed frame failed authentication");
    expect(truncated).toBe(wrongKey);
  });
});

describe("sealOnce / openOnce", () => {
  it("round-trips the descriptor", async () => {
    const sealed = await sealOnce(KEY, "s2c", HELLO);
    expect(bytesToHex(await openOnce(KEY, "s2c", sealed))).toBe(
      bytesToHex(HELLO),
    );
  });

  it("seals the same descriptor differently every time", async () => {
    const a = await sealOnce(KEY, "s2c", HELLO);
    const b = await sealOnce(KEY, "s2c", HELLO);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});

describe("sealed frames reject tampering", () => {
  it("rejects a flipped ciphertext byte", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const frame = await sealer.seal(HELLO);
    frame[SALT_BYTES + 10] = (frame[SALT_BYTES + 10] ?? 0) ^ 0x01;
    await expect(StreamOpener.bind(KEY, "c2s", frame)).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("rejects a flipped tag byte", async () => {
    const frame = await new FrameSealer(KEY, "c2s").seal(HELLO);
    frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 0x80;
    await expect(StreamOpener.bind(KEY, "c2s", frame)).rejects.toThrow(
      /failed authentication/,
    );
  });

  /** The salt feeds the key, so flipping it is a wrong key, not a wrong frame. */
  it("rejects a flipped salt byte", async () => {
    const frame = await new FrameSealer(KEY, "c2s").seal(HELLO);
    frame[0] = (frame[0] ?? 0) ^ 0x01;
    await expect(StreamOpener.bind(KEY, "c2s", frame)).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("rejects a rewritten counter", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const first = await sealer.seal(HELLO);
    const { opener } = await StreamOpener.bind(KEY, "c2s", first);
    const frame = await sealer.seal(HELLO); // counter 1, unsalted
    new DataView(frame.buffer, frame.byteOffset, 8).setBigUint64(0, 99n, false);
    await expect(opener.open(frame)).rejects.toThrow(/failed authentication/);
  });

  it("rejects a truncated frame", async () => {
    const first = await new FrameSealer(KEY, "c2s").seal(HELLO);
    const { opener } = await StreamOpener.bind(KEY, "c2s", first);
    await expect(opener.open(new Uint8Array(8))).rejects.toThrow(/truncated/);
    await expect(opener.open(new Uint8Array(3))).rejects.toThrow(/truncated/);
  });

  it("rejects a frame sealed under a different key", async () => {
    const frame = await new FrameSealer(OTHER_KEY, "c2s").seal(HELLO);
    await expect(StreamOpener.bind(KEY, "c2s", frame)).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("rejects a frame reflected back at its sender's direction", async () => {
    // Same key, wrong direction: both the subkey label and the nonce differ.
    const frame = await new FrameSealer(KEY, "c2s").seal(HELLO);
    await expect(StreamOpener.bind(KEY, "s2c", frame)).rejects.toThrow(
      /failed authentication/,
    );
  });
});

describe("sealed frames reject replay", () => {
  it("refuses the same frame twice", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const first = await sealer.seal(HELLO);
    const { opener } = await StreamOpener.bind(KEY, "c2s", first);
    const second = await sealer.seal(HELLO);
    await opener.open(second);
    await expect(opener.open(second)).rejects.toThrow(/Replayed or reordered/);
  });

  it("refuses an out-of-order frame", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const { opener } = await StreamOpener.bind(
      KEY,
      "c2s",
      await sealer.seal(HELLO),
    );
    const second = await sealer.seal(HELLO);
    const third = await sealer.seal(HELLO);
    await opener.open(third);
    await expect(opener.open(second)).rejects.toThrow(/Replayed or reordered/);
  });

  it("does not advance its counter on a rejected frame", async () => {
    const sealer = new FrameSealer(KEY, "c2s");
    const { opener } = await StreamOpener.bind(
      KEY,
      "c2s",
      await sealer.seal(HELLO),
    );

    // A forged frame claiming a far-future counter must not lock out the
    // legitimate stream that follows it.
    const forged = await new FrameSealer(OTHER_KEY, "c2s").seal(HELLO);
    const body = forged.subarray(SALT_BYTES);
    new DataView(body.buffer, body.byteOffset, 8).setBigUint64(
      0,
      10_000n,
      false,
    );
    await expect(opener.open(body)).rejects.toThrow();
    expect(opener.highestSeen).toBe(0n);

    const legit = await sealer.seal(utf8ToBytes("still fine"));
    expect(decode(await opener.open(legit))).toBe("still fine");
  });

  /**
   * A reconnect used to reset `#highest` to null while reusing the key, so
   * every frame of the previous connection replayed cleanly. Now the fresh
   * connection has a fresh salt, and those frames do not even authenticate.
   */
  it("cannot replay a previous connection's frames into a new one", async () => {
    const old = new FrameSealer(KEY, "c2s");
    const captured = await old.seal(utf8ToBytes("old traffic"));

    const fresh = new FrameSealer(KEY, "c2s");
    const { opener } = await StreamOpener.bind(
      KEY,
      "c2s",
      await fresh.seal(utf8ToBytes("new traffic")),
    );
    await expect(opener.open(captured.subarray(SALT_BYTES))).rejects.toThrow();
  });
});

describe("key validation", () => {
  it("refuses a key that is not 32 bytes", () => {
    expect(() => new FrameSealer(new Uint8Array(16), "c2s")).toThrow(
      /32-byte session key/,
    );
  });

  it("refuses a salt that is not 16 bytes", () => {
    expect(() => new FrameOpener(KEY, "c2s", new Uint8Array(15))).toThrow(
      /16-byte salt/,
    );
    expect(() => new FrameOpener(KEY, "c2s", new Uint8Array(17))).toThrow(
      /16-byte salt/,
    );
  });
});
