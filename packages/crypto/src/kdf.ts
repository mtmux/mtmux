import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { bytesToHex, constantTimeEqual } from "./bytes";

/**
 * The key schedule hanging off a completed CPace run.
 *
 * Everything is derived from the CPace ISK with HKDF-SHA-256, salted by the
 * transcript. Separate labels per purpose mean a leak of one key never gives
 * an attacker any of the others, and the browser→CLI and CLI→browser
 * directions use different keys so a captured frame can never be reflected
 * back at its sender.
 */

const KEY_BYTES = 32;

export const LABEL = {
  c2s: "mtmux/v1 browser→cli",
  s2c: "mtmux/v1 cli→browser",
  confirm: "mtmux/v1 confirm",
  directToken: "mtmux/v1 direct-token",
} as const;

export type SessionKeys = {
  /** AES-256-GCM key for browser → CLI frames. */
  c2s: Uint8Array;
  /** AES-256-GCM key for CLI → browser frames. */
  s2c: Uint8Array;
  /** HMAC key for key confirmation. */
  confirm: Uint8Array;
  /**
   * Relay auth token for the direct path, as hex.
   *
   * Both sides compute this from the pairing key, so the browser can
   * authenticate to the relay without the long-lived AUTH_TOKEN ever crossing
   * the wire — which is the whole reason it exists.
   */
  directToken: string;
};

function derive(
  isk: Uint8Array,
  transcript: Uint8Array,
  label: string,
): Uint8Array {
  return hkdf(sha256, isk, transcript, utf8ToBytes(label), KEY_BYTES);
}

export function deriveSessionKeys(
  isk: Uint8Array,
  transcript: Uint8Array,
): SessionKeys {
  return {
    c2s: derive(isk, transcript, LABEL.c2s),
    s2c: derive(isk, transcript, LABEL.s2c),
    confirm: derive(isk, transcript, LABEL.confirm),
    directToken: bytesToHex(derive(isk, transcript, LABEL.directToken)),
  };
}

export type Role = "cli" | "browser";

/**
 * Key confirmation.
 *
 * Each side proves it derived the same key before either does anything with
 * it. This is what turns a wrong four-digit guess into an immediate, visible
 * failure instead of a silently broken session — and what lets the broker
 * destroy the mailbox on a bad guess, so an attacker gets exactly one shot.
 */
export function confirmationTag(
  confirmKey: Uint8Array,
  role: Role,
): Uint8Array {
  return hmac(sha256, confirmKey, utf8ToBytes(`mtmux/v1 confirm ${role}`));
}

export function verifyConfirmation(
  confirmKey: Uint8Array,
  role: Role,
  tag: Uint8Array,
): boolean {
  return constantTimeEqual(confirmationTag(confirmKey, role), tag);
}
