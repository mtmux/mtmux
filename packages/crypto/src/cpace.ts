import { sha512 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { lvCat, prependLen, randomBytes } from "./bytes.js";

/**
 * CPace — balanced PAKE, ciphersuite CPACE-RISTR255-SHA512.
 *
 * Implements draft-irtf-cfrg-cpace-13 over @noble/curves' audited ristretto255.
 * `cpace.test.ts` checks every intermediate against the draft's Appendix B.3
 * vectors, which is the only reason to trust this file.
 *
 * ⚠️ SECURITY REVIEW REQUIRED BEFORE THIS SHIPS. Matching published vectors
 * proves the encoding and group maths are right; it does not prove the
 * surrounding protocol wiring (who sends what, when, and what is bound into
 * the transcript) is right. Review the callers alongside this file.
 *
 * Why it exists at all: the pairing broker must route a claim without learning
 * the password. A PAKE is what lets both sides turn a four-digit secret into a
 * strong shared key while the server sees only opaque group elements. Existing
 * npm CPace implementations are all pre-1.0 with no audit, so depending on one
 * would move the trust rather than reduce it.
 */

const Point = ristretto255.Point;

/**
 * Group elements never appear in this module's public signatures — only their
 * 32-byte encodings. Partly that keeps callers away from curve internals, and
 * partly TypeScript cannot emit declarations naming @noble's anonymous point
 * class.
 */
type RistrettoPoint = ReturnType<typeof Point.fromBytes>;

/** G_Ristretto255.DSI */
const DSI = utf8ToBytes("CPaceRistretto255");
/** G_Ristretto255.DSI_ISK */
const DSI_ISK = utf8ToBytes("CPaceRistretto255_ISK");
/** SHA-512 input block size, H.s_in_bytes. */
const S_IN_BYTES = 128;
/** G_Ristretto255.group_size_bytes */
export const SCALAR_BYTES = 32;
/** Encoded ristretto255 element length. */
export const ELEMENT_BYTES = 32;

/**
 * generator_string(DSI, PRS, CI, sid, s_in_bytes)
 *   = lv_cat(DSI, PRS, zero_bytes(len_zpad), CI, sid)
 *
 * The zero padding pushes the password out of the first hash block, so a
 * side-channel on the compression function cannot see PRS-dependent data in a
 * block whose other inputs are attacker-known.
 */
export function generatorString(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
): Uint8Array {
  const lenZpad = Math.max(
    0,
    S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length,
  );
  return lvCat(DSI, prs, new Uint8Array(lenZpad), ci, sid);
}

/**
 * ristretto255's one-way map from 64 uniform bytes — the `element_derivation`
 * CPace asks for. Deliberately NOT `hashToCurve`, which prepends an
 * expand_message_xmd step CPace does not use.
 *
 * Typed as optional upstream, so it is resolved once here and the failure is
 * loud rather than a runtime `undefined is not a function` mid-handshake.
 */
const deriveToCurve: (uniform64: Uint8Array) => RistrettoPoint = (() => {
  const fn = ristretto255_hasher.deriveToCurve;
  if (typeof fn !== "function") {
    throw new Error(
      "@noble/curves no longer exposes ristretto255_hasher.deriveToCurve — " +
        "CPace's element_derivation cannot be built without it.",
    );
  }
  return fn as (uniform64: Uint8Array) => RistrettoPoint;
})();

function generatorPoint(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
): RistrettoPoint {
  return deriveToCurve(sha512(generatorString(prs, ci, sid)));
}

/** calculate_generator(), as its 32-byte encoding. */
export function calculateGenerator(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
): Uint8Array {
  return generatorPoint(prs, ci, sid).toBytes();
}

/**
 * The public share for a given scalar: `encode(scalar * G)`. Separate from
 * `cpaceStart` only so the draft's Ya/Yb vectors can be checked directly.
 */
export function computeShare(
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
  scalar: bigint,
): Uint8Array {
  return generatorPoint(prs, ci, sid).multiply(scalar).toBytes();
}

/**
 * Sample a CPace scalar: 32 random bytes with the bits above 252 cleared, read
 * little-endian. Every such value is below the group order, so no reduction is
 * needed and no bias is introduced.
 */
export function sampleScalar(
  random: Uint8Array = randomBytes(SCALAR_BYTES),
): bigint {
  if (random.length !== SCALAR_BYTES) {
    throw new Error(`CPace scalar needs ${SCALAR_BYTES} bytes`);
  }
  const bytes = Uint8Array.from(random);
  // group_size_bits = 252, so the top nibble of the last byte goes.
  bytes[SCALAR_BYTES - 1] = (bytes[SCALAR_BYTES - 1] ?? 0) & 0x0f;
  let value = 0n;
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i] ?? 0);
  }
  return value;
}

export type CPaceState = {
  /** Our ephemeral public share, to be sent to the peer. */
  readonly share: Uint8Array;
  /** Finish the exchange against the peer's share. Throws on a bad share. */
  finish: (peerShare: Uint8Array, ad: CPaceAd) => Uint8Array;
};

export type CPaceAd = {
  /** Associated data we sent alongside our share. */
  own: Uint8Array;
  /** Associated data the peer sent alongside theirs. */
  peer: Uint8Array;
  /**
   * True when we are the initiator (A). The transcript is ordered
   * initiator-first, so both sides must agree on this.
   */
  isInitiator: boolean;
};

/**
 * Begin a CPace run.
 *
 * @param password  PRS — the shared low-entropy secret (the 4-digit half).
 * @param channelId CI — binds the run to its channel (we use the slot).
 * @param sid       Session id, chosen by whichever side opens the exchange.
 */
export function cpaceStart(
  password: Uint8Array,
  channelId: Uint8Array,
  sid: Uint8Array,
  scalarSeed?: Uint8Array,
): CPaceState {
  const generator = generatorPoint(password, channelId, sid);
  const scalar = sampleScalar(scalarSeed);
  const ownShare = generator.multiply(scalar).toBytes();

  return {
    share: ownShare,
    finish(peerShare: Uint8Array, ad: CPaceAd): Uint8Array {
      const k = scalarMultVfy(scalar, peerShare);
      const transcript = ad.isInitiator
        ? transcriptIr(ownShare, ad.own, peerShare, ad.peer)
        : transcriptIr(peerShare, ad.peer, ownShare, ad.own);
      return sha512(concatBytes(lvCat(DSI_ISK, sid, k), transcript));
    },
  };
}

/**
 * scalar_mult_vfy: decode the peer's share, multiply, and refuse the identity.
 *
 * A peer that sends a low-order or identity element would otherwise force a
 * predictable shared secret. Ristretto255 has no small-order elements by
 * construction, so the identity is the only case left — but it is a real one,
 * and the spec requires the abort.
 */
export function scalarMultVfy(
  scalar: bigint,
  peerShare: Uint8Array,
): Uint8Array {
  if (peerShare.length !== ELEMENT_BYTES) {
    throw new Error("CPace: peer share must be 32 bytes");
  }
  let point: RistrettoPoint;
  try {
    point = Point.fromBytes(peerShare);
  } catch {
    throw new Error("CPace: peer share is not a valid ristretto255 element");
  }
  const shared = point.multiply(scalar);
  if (shared.is0()) {
    throw new Error("CPace: peer share yielded the identity element");
  }
  return shared.toBytes();
}

/** transcript_ir(Ya, ADa, Yb, ADb) = lv_cat(Ya, ADa) || lv_cat(Yb, ADb) */
export function transcriptIr(
  ya: Uint8Array,
  ada: Uint8Array,
  yb: Uint8Array,
  adb: Uint8Array,
): Uint8Array {
  return concatBytes(lvCat(ya, ada), lvCat(yb, adb));
}

/** The full ISK computation, exposed for the test vectors. */
export function iskInitiatorResponder(
  sid: Uint8Array,
  k: Uint8Array,
  ya: Uint8Array,
  ada: Uint8Array,
  yb: Uint8Array,
  adb: Uint8Array,
): Uint8Array {
  return sha512(
    concatBytes(lvCat(DSI_ISK, sid, k), transcriptIr(ya, ada, yb, adb)),
  );
}
