import { bytesToBase64Url, randomBytes } from "./bytes";

/**
 * The six digits the user reads off their phone and types into the CLI.
 *
 *     4 9   2 7 1 6
 *     └┬┘   └──┬──┘
 *   slot     secret
 *
 * The split is the load-bearing design decision. The broker assigns the public
 * two-digit slot so it can route a claim to the right pending mailbox; the
 * browser generates the four-digit secret locally and it is *never* sent to
 * the broker, not even hashed — 10⁴ is an instant offline search. A broker
 * that knew the whole code would know the PAKE password, and could run the
 * protocol against both sides at once to pair a victim's CLI to an attacker's
 * browser.
 *
 * Slots are not a scarce resource: many pairings can share slot 49 at once,
 * and a claim is offered to every live mailbox under it. Only the one whose
 * secret matches produces a valid key confirmation.
 *
 * ## Two lengths of secret
 *
 * Four digits is what a human can read off a screen and retype, and its 13.3
 * bits are only safe because the broker allows one online guess per code. A QR
 * is not a human: it is an automated typist, and there is no reason for it to
 * carry the same weak secret. So there is a second form —
 *
 *     4 9   qX8_2mKf... (22 chars)
 *     └┬┘   └─────┬─────┘
 *   slot      secret (128 bits)
 *
 * — which is what the QR encodes. Both feed the same CPace password input, so
 * `cpace.ts`, `kdf.ts` and `frames.ts` are untouched by this; the only thing
 * that changes is how much entropy the password has. The path most people use
 * goes from 19.9 bits to 128 at no cost in friction, and the typed fallback
 * stays six digits.
 *
 * A single mailbox commits to one password when it sends its CPace share, so
 * the two forms cannot share one — `mtmux start` parks a mailbox for each and
 * races them.
 */

export const SLOT_DIGITS = 2;
export const SECRET_DIGITS = 4;
export const CODE_DIGITS = SLOT_DIGITS + SECRET_DIGITS;

export const SLOT_COUNT = 10 ** SLOT_DIGITS;
export const SECRET_COUNT = 10 ** SECRET_DIGITS;

/** The QR's secret: 128 bits, base64url, unpadded. */
export const LONG_SECRET_BYTES = 16;
export const LONG_SECRET_CHARS = 22;
const LONG_SECRET_RE = new RegExp(`^[A-Za-z0-9_-]{${LONG_SECRET_CHARS}}$`);

/**
 * Uniform integer in [0, bound) by rejection sampling.
 *
 * `randomBytes() % bound` would bias the low values, which for a four-digit
 * secret is a measurable weakening of the one-shot guessing bound the whole
 * design rests on.
 */
function uniformBelow(bound: number): number {
  if (bound <= 0 || bound > 0x10000) {
    throw new Error("uniformBelow supports bounds in (0, 65536]");
  }
  const limit = Math.floor(0x10000 / bound) * bound;
  for (;;) {
    const bytes = randomBytes(2);
    const value = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
    if (value < limit) return value % bound;
  }
}

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, "0");
}

/** Browser side: the half the broker must never see. */
export function generateSecret(): string {
  return pad(uniformBelow(SECRET_COUNT), SECRET_DIGITS);
}

/**
 * The QR's secret. Same role as `generateSecret`, 128 bits instead of 13.3.
 *
 * Straight from the CSPRNG with no rejection sampling, because base64url of 16
 * random bytes is already uniform — the bias `uniformBelow` exists to avoid
 * only arises when folding random bytes into a range that does not divide them.
 */
export function generateLongSecret(): string {
  return bytesToBase64Url(randomBytes(LONG_SECRET_BYTES));
}

export function isValidLongSecret(secret: string): boolean {
  return LONG_SECRET_RE.test(secret);
}

/** Broker side: the public routing half. */
export function generateSlot(): string {
  return pad(uniformBelow(SLOT_COUNT), SLOT_DIGITS);
}

export function formatCode(slot: string, secret: string): string {
  if (!isValidSlot(slot)) throw new Error("Invalid pairing slot");
  if (!isValidSecret(secret)) throw new Error("Invalid pairing secret");
  return `${slot}${secret}`;
}

/** Grouped for reading aloud: "49 27 16". */
export function formatCodeForDisplay(code: string): string {
  const digits = normalizeCode(code);
  if (digits === null) throw new Error("Invalid pairing code");
  return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)}`;
}

export function isValidSlot(slot: string): boolean {
  return new RegExp(`^\\d{${SLOT_DIGITS}}$`).test(slot);
}

export function isValidSecret(secret: string): boolean {
  return new RegExp(`^\\d{${SECRET_DIGITS}}$`).test(secret);
}

/**
 * Strip whatever the user typed down to six digits, or null.
 *
 * People paste "49 27 16", "49-2716", and "492716" interchangeably, and a
 * pairing code that rejects a space is a pairing code that gets retyped.
 */
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${CODE_DIGITS}}$`).test(digits) ? digits : null;
}

export type ParsedCode = { slot: string; secret: string };

/** What the QR encodes: the routing slot, then a 128-bit secret. */
export function formatLongCode(slot: string, secret: string): string {
  if (!isValidSlot(slot)) throw new Error("Invalid pairing slot");
  if (!isValidLongSecret(secret)) throw new Error("Invalid pairing secret");
  return `${slot}${secret}`;
}

/**
 * Parse either form: six typed digits, or a scanned slot + 128-bit secret.
 *
 * Order matters only for clarity — the two cannot collide, because they are
 * different lengths. The long form is deliberately *not* run through
 * `normalizeCode`: `-` is a base64url character, and stripping it as
 * punctuation would silently corrupt one secret in eight.
 */
export function parseCode(input: string): ParsedCode | null {
  const digits = normalizeCode(input);
  if (digits !== null) {
    return {
      slot: digits.slice(0, SLOT_DIGITS),
      secret: digits.slice(SLOT_DIGITS),
    };
  }

  const trimmed = input.trim();
  if (trimmed.length !== SLOT_DIGITS + LONG_SECRET_CHARS) return null;
  const slot = trimmed.slice(0, SLOT_DIGITS);
  const secret = trimmed.slice(SLOT_DIGITS);
  if (!isValidSlot(slot) || !isValidLongSecret(secret)) return null;
  return { slot, secret };
}
