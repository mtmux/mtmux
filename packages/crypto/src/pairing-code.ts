import { randomBytes } from "./bytes";

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
 */

export const SLOT_DIGITS = 2;
export const SECRET_DIGITS = 4;
export const CODE_DIGITS = SLOT_DIGITS + SECRET_DIGITS;

export const SLOT_COUNT = 10 ** SLOT_DIGITS;
export const SECRET_COUNT = 10 ** SECRET_DIGITS;

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

export function parseCode(input: string): ParsedCode | null {
  const digits = normalizeCode(input);
  if (digits === null) return null;
  return {
    slot: digits.slice(0, SLOT_DIGITS),
    secret: digits.slice(SLOT_DIGITS),
  };
}
