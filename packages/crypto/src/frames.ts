/**
 * Sealed frames — AES-256-GCM over a WebSocket.
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`), which is present in browsers and
 * in Node 22+, so the browser and the CLI run byte-identical code rather than
 * two implementations that have to be kept in agreement.
 *
 * Nonce construction is a 4-byte direction tag followed by a big-endian 8-byte
 * counter. The direction tag means the two directions can never collide even
 * though they are separate keys anyway; the counter must strictly increase, so
 * a replayed or reordered frame is rejected rather than decrypted.
 *
 * Wire format:  [8-byte BE counter][ciphertext || 16-byte GCM tag]
 *
 * The counter is on the wire so a receiver can name the failure ("replayed
 * frame 41, expected > 57") instead of reporting an opaque decrypt error.
 * Tampering with it is still caught: it feeds the nonce, so any change makes
 * authentication fail.
 */

export type Direction = "c2s" | "s2c";

const COUNTER_BYTES = 8;
const NONCE_BYTES = 12;
const TAG_BITS = 128;
/** GCM's safety limit; we are nowhere near it, but the check is free. */
const MAX_COUNTER = (1n << 64n) - 1n;

const DIRECTION_TAG: Record<Direction, Uint8Array> = {
  c2s: Uint8Array.from([0x63, 0x32, 0x73, 0x00]), // "c2s\0"
  s2c: Uint8Array.from([0x73, 0x32, 0x63, 0x00]), // "s2c\0"
};

/**
 * TypeScript 5.7 made `Uint8Array` generic over its backing buffer, so a plain
 * `Uint8Array` no longer satisfies `BufferSource` (which insists on
 * `ArrayBuffer`, not `SharedArrayBuffer`). Nothing here is ever backed by
 * shared memory; this narrows the type without copying.
 */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error(
      "WebCrypto is unavailable. Sealed frames need globalThis.crypto.subtle " +
        "(browsers, or Node 22+).",
    );
  }
  return c.subtle;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) {
    throw new Error("Sealed frames need a 32-byte AES-256 key");
  }
  return subtle().importKey("raw", asBufferSource(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function nonceFor(direction: Direction, counter: bigint): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.set(DIRECTION_TAG[direction], 0);
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  view.setBigUint64(4, counter, false);
  return nonce;
}

function readCounter(frame: Uint8Array): bigint {
  const view = new DataView(frame.buffer, frame.byteOffset, COUNTER_BYTES);
  return view.getBigUint64(0, false);
}

/** Encrypts outbound frames on one direction of a connection. */
export class FrameSealer {
  #key: Promise<CryptoKey>;
  #counter = 0n;

  constructor(
    key: Uint8Array,
    private readonly direction: Direction,
  ) {
    this.#key = importKey(key);
  }

  /** Number of frames sealed so far — exposed for tests and diagnostics. */
  get sent(): bigint {
    return this.#counter;
  }

  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.#counter > MAX_COUNTER) {
      throw new Error("Frame counter exhausted — rekey required");
    }
    const counter = this.#counter++;
    const sealed = new Uint8Array(
      await subtle().encrypt(
        {
          name: "AES-GCM",
          iv: asBufferSource(nonceFor(this.direction, counter)),
          tagLength: TAG_BITS,
        },
        await this.#key,
        asBufferSource(plaintext),
      ),
    );

    const frame = new Uint8Array(COUNTER_BYTES + sealed.length);
    new DataView(frame.buffer).setBigUint64(0, counter, false);
    frame.set(sealed, COUNTER_BYTES);
    return frame;
  }
}

/** Decrypts inbound frames on one direction, enforcing replay protection. */
export class FrameOpener {
  #key: Promise<CryptoKey>;
  #highest: bigint | null = null;

  constructor(
    key: Uint8Array,
    private readonly direction: Direction,
  ) {
    this.#key = importKey(key);
  }

  /** Highest counter accepted so far, or null before the first frame. */
  get highestSeen(): bigint | null {
    return this.#highest;
  }

  async open(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.length <= COUNTER_BYTES) {
      throw new Error("Sealed frame is truncated");
    }
    const counter = readCounter(frame);
    if (this.#highest !== null && counter <= this.#highest) {
      throw new Error(
        `Replayed or reordered frame ${counter}, expected > ${this.#highest}`,
      );
    }

    let opened: ArrayBuffer;
    try {
      opened = await subtle().decrypt(
        {
          name: "AES-GCM",
          iv: asBufferSource(nonceFor(this.direction, counter)),
          tagLength: TAG_BITS,
        },
        await this.#key,
        asBufferSource(frame.subarray(COUNTER_BYTES)),
      );
    } catch {
      // Deliberately opaque: a tampered frame and a wrong key are the same
      // event as far as the peer is concerned, and the connection dies either
      // way.
      throw new Error("Sealed frame failed authentication");
    }

    // Only advance once the frame is known good, so a forged high counter
    // cannot lock out the legitimate stream.
    this.#highest = counter;
    return new Uint8Array(opened);
  }
}

/** Both directions of one connection, from the derived session keys. */
export function createFramePair(
  keys: { c2s: Uint8Array; s2c: Uint8Array },
  role: "cli" | "browser",
): { sealer: FrameSealer; opener: FrameOpener } {
  // The browser seals on c2s and opens s2c; the CLI is the mirror image.
  return role === "browser"
    ? {
        sealer: new FrameSealer(keys.c2s, "c2s"),
        opener: new FrameOpener(keys.s2c, "s2c"),
      }
    : {
        sealer: new FrameSealer(keys.s2c, "s2c"),
        opener: new FrameOpener(keys.c2s, "c2s"),
      };
}
