import { bytesToBase64Url, randomBytes } from "./bytes";

/**
 * The digits the user reads off their phone and types into the CLI.
 *
 *     4 9 2   7 1 6 3 8 4
 *     └─┬─┘   └────┬────┘
 *      slot      secret
 *
 * The split is the load-bearing design decision. The broker assigns the public
 * three-digit slot so it can route a claim to the right pending mailbox; the
 * other end generates the secret locally and it is *never* sent to the broker,
 * not even hashed — any of these secrets is an instant offline search. A broker
 * that knew the whole code would know the PAKE password, and could run the
 * protocol against both sides at once to pair a victim's CLI to an attacker's
 * browser.
 *
 * Slots are not a scarce resource: many pairings can share slot 492 at once, and
 * a claim is fanned out to every live mailbox under it. Only the one whose
 * secret matches produces a valid key confirmation.
 *
 * ## Two wire forms, told apart by length alone
 *
 * | form  | slot | secret        | total |
 * |-------|------|---------------|-------|
 * | typed | 3    | 6 digits      | 9     |
 * | scan  | 4    | 22 base64url  | 26    |
 *
 * No prefix and no version byte: the totals are distinct, and the assertion
 * below is what keeps them that way. That assertion is not decoration — it is
 * what caught the collision this change had to resolve: a three-digit typed
 * slot makes a typed code 9 digits, which is fine, but the *legacy* 2-digit
 * scan form was 24 characters and the legacy 2-digit typed form 6, and neither
 * can survive a three-digit slot without the parse becoming a guess. Both are
 * deleted here rather than carried, which is the clean break 0.7.0 exists for.
 *
 * ## Why three digits, not two
 *
 * The secret is not the binding constraint — a code buys exactly one verified
 * guess, so it is worth 10⁻⁶. The *slot space* was: at two digits there are 100
 * slots and two mailboxes each, so the entire service supported 200 concurrent
 * typed pairings, and 100 attached claims killed every one of them. Three
 * digits takes the ceiling to 2000 and makes a full sweep slower than the
 * three-minute mailbox TTL, so the space can never be held dead.
 *
 * ## Why a scan code is not a typed code
 *
 * A QR is not a human: it is an automated typist, and there is no reason for it
 * to carry a secret a person could retype. So the scanned form carries 128 bits
 * instead of 20, and — since nobody reads its slot aloud either — draws that
 * slot from its own four-digit space. That separation is what stops a sweep of
 * the small typed space from touching a scanned pairing at all.
 *
 * Both forms feed the same CPace password input, so `cpace.ts`, `kdf.ts` and
 * `frames.ts` are untouched by any of this; the only thing that changes is how
 * much entropy the password has. A mailbox commits to one password when it
 * sends its CPace share, so the two forms cannot share one — `mtmux start`
 * parks a mailbox for each and races them.
 */

/** The typed code's routing half. The only part the broker ever sees. */
export const SLOT_DIGITS = 3;
/**
 * The typed secret.
 *
 * Six rather than four. Four was only ever safe because the broker allows one
 * online guess per code, and that bound is now actually enforced rather than
 * asserted — but the two changes are worth having together: the extra two
 * digits are what turn a bounded search from "expensive" into "hopeless".
 */
export const SECRET_DIGITS = 6;
export const CODE_DIGITS = SLOT_DIGITS + SECRET_DIGITS;

export const SLOT_COUNT = 10 ** SLOT_DIGITS;
export const SECRET_COUNT = 10 ** SECRET_DIGITS;

/** The scanned code's routing half. Nobody types a QR, so it can afford four. */
export const QR_SLOT_DIGITS = 4;
export const QR_SLOT_COUNT = 10 ** QR_SLOT_DIGITS;

/** The scanned secret: 128 bits, base64url, unpadded. */
export const LONG_SECRET_BYTES = 16;
export const LONG_SECRET_CHARS = 22;
const LONG_SECRET_RE = new RegExp(`^[A-Za-z0-9_-]{${LONG_SECRET_CHARS}}$`);

/** A form a human types: all digits, grouped for reading aloud. */
export type TypedForm = {
  slotDigits: number;
  secretDigits: number;
  total: number;
  /** How to break the code up on screen. Must sum to `total`. */
  groups: number[];
};

/** A form a scanner reads: digits, then a base64url secret. */
export type LongForm = {
  slotDigits: number;
  secretChars: number;
  total: number;
};

/**
 * One entry each, now that the legacy forms are gone. Kept as tables rather than
 * constants because the shape is what `parseCode`, `codeGroups` and the
 * ambiguity assertion all read, and because the next length change should be a
 * row, not a rewrite.
 *
 * The grouping puts the slot on its own — `492 716 384` — because the leading
 * group is the only part that reaches our servers, and every piece of copy in
 * the product leans on that being visible at a glance.
 */
const TYPED_FORMS: TypedForm[] = [
  { slotDigits: 3, secretDigits: 6, total: 9, groups: [3, 3, 3] },
];

const LONG_FORMS: LongForm[] = [
  {
    slotDigits: QR_SLOT_DIGITS,
    secretChars: LONG_SECRET_CHARS,
    total: QR_SLOT_DIGITS + LONG_SECRET_CHARS,
  },
];

/**
 * Lengths are the only thing telling the forms apart, so two forms sharing one
 * would make a code ambiguous. Checked at module load rather than in a test,
 * because the cost of getting it wrong is silent and the check is free.
 */
{
  const totals = [...TYPED_FORMS, ...LONG_FORMS].map((form) => form.total);
  if (new Set(totals).size !== totals.length) {
    throw new Error(
      `Ambiguous pairing code forms: two share a length (${totals.join(", ")})`,
    );
  }
  for (const form of TYPED_FORMS) {
    const summed = form.groups.reduce((a, b) => a + b, 0);
    if (summed !== form.total) {
      throw new Error(
        `Typed form of ${form.total} digits has groups summing to ${summed}`,
      );
    }
  }
}

/** Slot widths any form may present. */
const SLOT_WIDTHS = new Set(
  [...TYPED_FORMS, ...LONG_FORMS].map((form) => form.slotDigits),
);

/** Secret widths a typed form may present. */
const SECRET_WIDTHS = new Set(TYPED_FORMS.map((form) => form.secretDigits));

/**
 * Uniform integer in [0, bound) by rejection sampling.
 *
 * `randomBytes() % bound` would bias the low values, which for a typed secret
 * is a measurable weakening of the one-guess-per-code bound the whole design
 * rests on.
 */
function uniformBelow(bound: number): number {
  if (!Number.isInteger(bound) || bound <= 0 || bound > 2 ** 32) {
    throw new Error("uniformBelow supports integer bounds in (0, 2^32]");
  }
  const width = Math.ceil(Math.log2(bound) / 8); // 1..4 bytes
  const span = 2 ** (width * 8);
  const limit = Math.floor(span / bound) * bound;
  for (;;) {
    const bytes = randomBytes(width);
    // Accumulate with `* 256` rather than `<<`: `1 << 31` is negative in JS,
    // so a four-byte draw would come back as a negative number.
    let value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + (bytes[i] ?? 0);
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
 * The scanned secret. Same role as `generateSecret`, 128 bits instead of 19.9.
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

/** Broker side: the public routing half of a typed code. */
export function generateSlot(): string {
  return pad(uniformBelow(SLOT_COUNT), SLOT_DIGITS);
}

/** Broker side: the routing half of a scanned code, from its own space. */
export function generateQrSlot(): string {
  return pad(uniformBelow(QR_SLOT_COUNT), QR_SLOT_DIGITS);
}

export function formatCode(slot: string, secret: string): string {
  if (!isValidSlot(slot)) throw new Error("Invalid pairing slot");
  if (!isValidSecret(secret)) throw new Error("Invalid pairing secret");
  return `${slot}${secret}`;
}

/**
 * How to break a code up on screen: `["492", "716", "384"]`.
 *
 * Exported so the CLI banner and the web's `/pair` page cannot drift apart —
 * they used to each slice the string themselves, which is exactly the kind of
 * duplication a change of length turns into a bug.
 */
export function codeGroups(code: string): string[] {
  const digits = normalizeCode(code);
  if (digits === null) throw new Error("Invalid pairing code");
  const form = TYPED_FORMS.find((f) => f.total === digits.length)!;
  const out: string[] = [];
  let at = 0;
  for (const size of form.groups) {
    out.push(digits.slice(at, at + size));
    at += size;
  }
  return out;
}

/** Grouped for reading aloud: "492 716 384". */
export function formatCodeForDisplay(code: string): string {
  return codeGroups(code).join(" ");
}

export function isValidSlot(slot: string): boolean {
  return /^\d+$/.test(slot) && SLOT_WIDTHS.has(slot.length);
}

export function isValidSecret(secret: string): boolean {
  return /^\d+$/.test(secret) && SECRET_WIDTHS.has(secret.length);
}

/**
 * Strip whatever the user typed down to a known typed length, or null.
 *
 * People paste "49 271 638", "49-271638", and "49271638" interchangeably, and a
 * pairing code that rejects a space is a pairing code that gets retyped.
 */
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  return TYPED_FORMS.some((form) => form.total === digits.length)
    ? digits
    : null;
}

/** The typed lengths we accept, ascending. */
export function typedCodeLengths(): number[] {
  return TYPED_FORMS.map((form) => form.total).sort((a, b) => a - b);
}

/**
 * Why a code did not parse, in terms the reader can act on.
 *
 * Shared by both clients rather than written twice, because the two used to
 * carry slightly different wordings and both hard-coded a digit count — which
 * is precisely what turned the last length change into a message that lied
 * about a code the page had just shown. Here the count is derived, and it is
 * only mentioned where the count *is* the problem.
 */
export function describeBadCode(input: string): string {
  const digits = input.replace(/[\s-]/g, "");
  if (digits.length > 0 && /^\d+$/.test(digits)) {
    const lengths = typedCodeLengths();
    // One accepted length is the normal case now, and `[a, b].slice(0, -1)`
    // renders "codes are  or 9" for it. Both wordings live here rather than in
    // either client, which is how the last length change managed to ship a
    // message that lied about the code the page was showing.
    const expected =
      lengths.length === 1
        ? `${lengths[0]}`
        : `${lengths.slice(0, -1).join(", ")} or ${lengths[lengths.length - 1]}`;
    return (
      `That code is ${digits.length} digits — pairing codes are ${expected}. ` +
      `Check for a missing digit.`
    );
  }
  return "That doesn't look like a pairing code.";
}

export type ParsedCode = { slot: string; secret: string };

/** What the QR encodes: the routing slot, then a 128-bit secret. */
export function formatLongCode(slot: string, secret: string): string {
  if (!isValidSlot(slot)) throw new Error("Invalid pairing slot");
  if (!isValidLongSecret(secret)) throw new Error("Invalid pairing secret");
  return `${slot}${secret}`;
}

/**
 * Parse either form.
 *
 * No two forms can collide, because they are different lengths and the
 * module-load assertion above enforces it. The long form is deliberately *not*
 * run through `normalizeCode`: `-` is a base64url
 * character, and stripping it as punctuation would silently corrupt one secret
 * in eight.
 */
export function parseCode(input: string): ParsedCode | null {
  const digits = normalizeCode(input);
  if (digits !== null) {
    const form = TYPED_FORMS.find((f) => f.total === digits.length)!;
    return {
      slot: digits.slice(0, form.slotDigits),
      secret: digits.slice(form.slotDigits),
    };
  }

  const trimmed = input.trim();
  const form = LONG_FORMS.find((f) => f.total === trimmed.length);
  if (!form) return null;
  const slot = trimmed.slice(0, form.slotDigits);
  const secret = trimmed.slice(form.slotDigits);
  if (!/^\d+$/.test(slot) || !isValidLongSecret(secret)) return null;
  return { slot, secret };
}
