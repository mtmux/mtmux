/**
 * Sealed frames — AES-256-GCM over a WebSocket.
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`), which is present in browsers and
 * in Node 22+, so the browser and the CLI run byte-identical code rather than
 * two implementations that have to be kept in agreement.
 *
 * Nonce construction is a 4-byte direction tag followed by a big-endian 8-byte
 * counter, and it is unchanged. What changed is the *key*: every sealer draws a
 * random 16-byte salt and derives a per-connection subkey from the session key,
 * so a counter that restarts at 0 — on a reconnect, on a second stream, or on
 * the sealed descriptor — no longer repeats a (key, nonce) pair.
 *
 * That repeat was not a corner case. `pair.ts` sealed the descriptor under
 * `s2c` at counter 0 and `tunnel-agent.ts` sealed the first tunnel frame under
 * `s2c` at counter 0, so every hosted pairing handed the broker two
 * ciphertexts encrypted under one nonce — one of them a JSON object whose
 * schema is public. XOR recovers the other plaintext, and the forbidden attack
 * recovers the GHASH subkey, which is forgery.
 *
 * Wire format:
 *
 *     first frame of a direction (counter MUST be 0):
 *         salt(16) || counter(8, BE) || ciphertext || tag(16)
 *     every frame after it:
 *         counter(8, BE) || ciphertext || tag(16)
 *
 * The salt travels in the clear, inside the sealed blob rather than beside it.
 * Inside, because `stream:frame.data` is the only field the broker forwards
 * verbatim — a new protocol field would be reconstructed away, and a
 * broker-minted salt would put the broker back in the key schedule. In the
 * clear, because the receiver must derive the subkey before it can decrypt
 * anything, and because trial decryption — the CLI trying each keyring entry
 * against an unlabelled stream — is what lets the broker stay blind.
 *
 * The counter is on the wire so a receiver can name the failure ("replayed
 * frame 41, expected > 57") instead of reporting an opaque decrypt error.
 * Tampering with it is still caught: it feeds the nonce, so any change makes
 * authentication fail.
 */
import {
  deriveSubkey,
  SUBKEY_LABEL,
  SUBKEY_SALT_BYTES,
  type SubkeyPurpose,
} from "./kdf";

export type Direction = "c2s" | "s2c";

const COUNTER_BYTES = 8;
export const SALT_BYTES = SUBKEY_SALT_BYTES;
const NONCE_BYTES = 12;
const TAG_BITS = 128;
/** GCM's safety limit; we are nowhere near it, but the check is free. */
const MAX_COUNTER = (1n << 64n) - 1n;

const DIRECTION_TAG: Record<Direction, Uint8Array> = {
  c2s: Uint8Array.from([0x63, 0x32, 0x73, 0x00]), // "c2s\0"
  s2c: Uint8Array.from([0x73, 0x32, 0x63, 0x00]), // "s2c\0"
};

/**
 * WebCrypto, typed structurally instead of via the DOM lib.
 *
 * This package is imported by the browser, the CLI and the broker, and the
 * node-targeted tsconfigs deliberately omit `lib.dom`. Declaring just the
 * slice we use keeps @repo/crypto compilable from all of them rather than
 * forcing every consumer to widen its `lib` for three type names.
 */
declare const AES_KEY: unique symbol;
type OpaqueKey = { readonly [AES_KEY]: true };

type GcmParams = { name: "AES-GCM"; iv: Uint8Array; tagLength: number };

type SubtleLike = {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: "AES-GCM",
    extractable: boolean,
    usages: string[],
  ): Promise<OpaqueKey>;
  encrypt(
    algorithm: GcmParams,
    key: OpaqueKey,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: GcmParams,
    key: OpaqueKey,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
};

function subtle(): SubtleLike {
  const c = (globalThis as { crypto?: { subtle?: unknown } }).crypto;
  if (!c?.subtle) {
    throw new Error(
      "WebCrypto is unavailable. Sealed frames need globalThis.crypto.subtle " +
        "(browsers, or Node 22+).",
    );
  }
  return c.subtle as SubtleLike;
}

async function importKey(raw: Uint8Array): Promise<OpaqueKey> {
  if (raw.length !== 32) {
    throw new Error("Sealed frames need a 32-byte AES-256 key");
  }
  return subtle().importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function randomSalt(): Uint8Array {
  const c = (
    globalThis as {
      crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (!c?.getRandomValues) {
    throw new Error(
      "Sealed frames need globalThis.crypto.getRandomValues " +
        "(browsers, or Node 22+).",
    );
  }
  return c.getRandomValues(new Uint8Array(SALT_BYTES));
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

/** How a sealer or opener is bound to a key schedule. */
export type FrameOptions = {
  /**
   * What these bytes are for. Separates a sealed descriptor from a tunnel
   * frame at the key, not merely at the counter.
   */
  purpose?: SubkeyPurpose;
};

/**
 * Encrypts outbound frames on one direction of a connection.
 *
 * The salt is chosen here, not passed in: a sealer that could be handed a
 * repeated salt is a sealer that can be handed the bug back. It is public —
 * `salt` — because the first frame has to carry it.
 */
export class FrameSealer {
  #key: Promise<OpaqueKey>;
  #counter = 0n;

  /** The per-connection salt this sealer derived its subkey from. */
  readonly salt: Uint8Array;

  constructor(
    key: Uint8Array,
    private readonly direction: Direction,
    options: FrameOptions = {},
  ) {
    const purpose = options.purpose ?? "frame";
    this.salt = randomSalt();
    this.#key = importKey(
      deriveSubkey(key, this.salt, SUBKEY_LABEL[purpose][direction]),
    );
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
          iv: nonceFor(this.direction, counter),
          tagLength: TAG_BITS,
        },
        await this.#key,
        plaintext,
      ),
    );

    // The salt rides the frame numbered 0 and nothing else — it is the same
    // sixteen bytes every time, so repeating it would only cost bandwidth.
    const prefix = counter === 0n ? SALT_BYTES : 0;
    const frame = new Uint8Array(prefix + COUNTER_BYTES + sealed.length);
    if (prefix) frame.set(this.salt, 0);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    view.setBigUint64(prefix, counter, false);
    frame.set(sealed, prefix + COUNTER_BYTES);
    return frame;
  }
}

/**
 * Decrypts inbound frames on one direction, enforcing replay protection.
 *
 * `salt` is a required positional argument, deliberately. Making it optional
 * would let every existing call site keep compiling while silently deriving a
 * key from a default — the exact class of mistake this change exists to
 * remove. A compile error at each of them is the point.
 */
export class FrameOpener {
  #key: Promise<OpaqueKey>;
  #highest: bigint | null = null;

  constructor(
    key: Uint8Array,
    private readonly direction: Direction,
    salt: Uint8Array,
    options: FrameOptions = {},
  ) {
    const purpose = options.purpose ?? "frame";
    this.#key = importKey(
      deriveSubkey(key, salt, SUBKEY_LABEL[purpose][direction]),
    );
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
          iv: nonceFor(this.direction, counter),
          tagLength: TAG_BITS,
        },
        await this.#key,
        frame.subarray(COUNTER_BYTES),
      );
    } catch {
      // Deliberately opaque: a tampered frame and a wrong key are the same
      // event as far as the peer is concerned, and the connection dies either
      // way. Trial decryption depends on this too — a loop that could tell
      // "wrong key" from "malformed" would leak which keyring entry matched.
      throw new Error("Sealed frame failed authentication");
    }

    // Only advance once the frame is known good, so a forged high counter
    // cannot lock out the legitimate stream.
    this.#highest = counter;
    return new Uint8Array(opened);
  }
}

/**
 * The salt-on-first-frame rule, in one place.
 *
 * `FrameSealer` and `FrameOpener` know about keys and counters; these know
 * that the first frame of a direction carries sixteen extra bytes. Keeping
 * that in one type is what stops the rule being re-derived — slightly
 * differently — at each of the four call sites.
 */
export class StreamOpener {
  private constructor(readonly opener: FrameOpener) {}

  /**
   * Bind to a stream from its first frame, and open that frame.
   *
   * Throws the same opaque error as `open` on every failure, so a caller
   * trying keyring entries in turn cannot distinguish "not this pairing" from
   * "malformed frame" — which is what makes trial decryption safe to run
   * against untrusted bytes.
   */
  static async bind(
    key: Uint8Array,
    direction: Direction,
    first: Uint8Array,
    options: FrameOptions = {},
  ): Promise<{ opener: FrameOpener; plaintext: Uint8Array }> {
    if (first.length <= SALT_BYTES + COUNTER_BYTES) {
      throw new Error("Sealed frame failed authentication");
    }
    const salt = first.subarray(0, SALT_BYTES);
    const body = first.subarray(SALT_BYTES);
    // A stream's first frame is frame 0 by construction. Refusing anything
    // else stops a later frame being replayed as an opener, which would
    // otherwise reset the receiver's replay window to that counter.
    if (readCounter(body) !== 0n) {
      throw new Error("Sealed frame failed authentication");
    }
    const opener = new FrameOpener(key, direction, salt, options);
    const plaintext = await opener.open(body);
    return { opener, plaintext };
  }
}

/**
 * Seal a single message under its own subkey.
 *
 * For anything sealed exactly once per key schedule — the pairing descriptor
 * is the only such thing today. It shares the envelope with streams so there
 * is one format on the wire, and takes its own purpose label so that "once"
 * is enforced by the key rather than by everybody remembering.
 */
export async function sealOnce(
  key: Uint8Array,
  direction: Direction,
  plaintext: Uint8Array,
  purpose: SubkeyPurpose = "descriptor",
): Promise<Uint8Array> {
  return new FrameSealer(key, direction, { purpose }).seal(plaintext);
}

/** Open what `sealOnce` produced. */
export async function openOnce(
  key: Uint8Array,
  direction: Direction,
  frame: Uint8Array,
  purpose: SubkeyPurpose = "descriptor",
): Promise<Uint8Array> {
  const { plaintext } = await StreamOpener.bind(key, direction, frame, {
    purpose,
  });
  return plaintext;
}
