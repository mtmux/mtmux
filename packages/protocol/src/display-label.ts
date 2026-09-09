/**
 * Text supplied by a peer that ends up on a human's terminal.
 *
 * `deviceLabel` is the name a browser gives itself, and it is printed straight
 * into the SAS approval prompt — the one strong human gate in the product.
 * Length was the only thing ever checked, and 120 bytes is ample room for ANSI
 * that walks the cursor back up the screen, erases the prompt, and reprints a
 * *matching* comparison code. The human then confirms a code the attacker
 * chose.
 *
 * So labels are stripped, not rejected: a hostile label must not be able to
 * fail a pairing either, or the sanitiser becomes its own denial of service,
 * and a phone with an unusual name is not an attack.
 */

/**
 * C0 (including ESC), DEL, C1, and the Unicode direction overrides.
 *
 * The bidi controls are here for the same reason as ESC: they do not move the
 * cursor, but they do let a label render as text other than what it contains,
 * which is the whole trick this is closing.
 */
/* eslint-disable no-control-regex -- matching control characters is the point */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

/** Longest label anything will display. Matches the wire schemas. */
export const MAX_LABEL_LENGTH = 120;

/**
 * Make a peer-supplied label safe to print, and bounded.
 *
 * Applied at parse time so nothing downstream can forget, and again at each
 * render site as defence in depth — the cost is a regex on a 120-byte string
 * once per pairing, and the failure it prevents is someone approving a code an
 * attacker drew on their screen.
 */
export function sanitizeLabel(
  raw: string,
  maxLength: number = MAX_LABEL_LENGTH,
): string {
  return raw.replace(UNSAFE, "").trim().slice(0, maxLength);
}

/**
 * The label as it should be shown when it survived sanitising to nothing.
 *
 * A blank label is not an error — an empty string is what an anonymous browser
 * sends — but printing nothing where a device name belongs reads as a
 * rendering bug rather than as "this device did not name itself".
 */
export function displayLabel(
  raw: string | null | undefined,
  fallback: string,
): string {
  const clean = sanitizeLabel(raw ?? "");
  return clean === "" ? fallback : clean;
}
