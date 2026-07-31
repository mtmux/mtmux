import { describe, it, expect } from "vitest";
import {
  codeGroups,
  generateSecret,
  generateSlot,
  generateQrSlot,
  formatCode,
  formatCodeForDisplay,
  normalizeCode,
  parseCode,
  isValidSlot,
  isValidSecret,
  isValidLongSecret,
  generateLongSecret,
  formatLongCode,
  typedCodeLengths,
  LONG_SECRET_BYTES,
  LONG_SECRET_CHARS,
  QR_SLOT_COUNT,
  SECRET_COUNT,
  SLOT_COUNT,
} from "./pairing-code";

describe("code generation", () => {
  it("always produces exactly six secret digits, zeros included", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateSecret()).toMatch(/^\d{6}$/);
    }
  });

  it("always produces exactly two slot digits", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateSlot()).toMatch(/^\d{2}$/);
    }
  });

  it("always produces exactly four scan-slot digits", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateQrSlot()).toMatch(/^\d{4}$/);
    }
  });

  it("keeps leading zeros rather than dropping them", () => {
    // Exhaustive coverage is out of reach at 10⁶, so this asks the question
    // that actually matters: does zero-padding survive? A dropped leading zero
    // would shorten the code and shrink the space it is drawn from.
    const seen = new Set<string>();
    for (let i = 0; i < 40_000; i++) seen.add(generateSecret());
    expect([...seen].every((s) => s.length === 6)).toBe(true);
    // ~4% of a million start with "00"; 40k draws make seeing one a certainty.
    expect([...seen].some((s) => s.startsWith("00"))).toBe(true);
    // And they must not all be distinct-by-luck only — no collapsed range.
    expect(seen.size).toBeGreaterThan(30_000);
  });

  it("is not obviously biased across the secret range", () => {
    // Rejection sampling should spread draws evenly over the four quartiles.
    const buckets = [0, 0, 0, 0];
    const draws = 20_000;
    for (let i = 0; i < draws; i++) {
      const value = Number(generateSecret());
      buckets[Math.floor((value / SECRET_COUNT) * 4)]!++;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(draws / 4 - draws / 20);
      expect(count).toBeLessThan(draws / 4 + draws / 20);
    }
  });

  it("is not obviously biased across the slot range", () => {
    const counts = new Map<string, number>();
    const draws = 20_000;
    for (let i = 0; i < draws; i++) {
      const slot = generateSlot();
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }
    expect(counts.size).toBe(SLOT_COUNT);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(draws / SLOT_COUNT / 2);
      expect(count).toBeLessThan((draws / SLOT_COUNT) * 2);
    }
  });
});

describe("validation", () => {
  it("accepts well-formed halves", () => {
    expect(isValidSlot("49")).toBe(true);
    expect(isValidSlot("00")).toBe(true);
    // The scan space is four digits wide and shares the same predicate.
    expect(isValidSlot("0049")).toBe(true);
    expect(isValidSecret("271638")).toBe(true);
    expect(isValidSecret("000000")).toBe(true);
    // Still valid: the legacy four-digit secret is parsed, just never emitted.
    expect(isValidSecret("2716")).toBe(true);
  });

  it("rejects the wrong number of digits or non-digits", () => {
    for (const bad of ["4", "490", "", "4a", " 9", "-9", "00490"]) {
      expect(isValidSlot(bad)).toBe(false);
    }
    for (const bad of ["271", "27163", "2716380", "", "27a638", "２７１６"]) {
      expect(isValidSecret(bad)).toBe(false);
    }
  });
});

describe("formatting", () => {
  it("joins the two halves in slot-then-secret order", () => {
    expect(formatCode("49", "271638")).toBe("49271638");
  });

  it("refuses to format malformed halves", () => {
    expect(() => formatCode("4", "271638")).toThrow(/slot/);
    expect(() => formatCode("49", "27163")).toThrow(/secret/);
  });

  it("groups an eight-digit code as slot, then thirds", () => {
    // The leading pair stays visually separate because it is the only part
    // that reaches our servers, and the copy everywhere leans on that.
    expect(formatCodeForDisplay("49271638")).toBe("49 271 638");
    expect(formatCodeForDisplay("49 271 638")).toBe("49 271 638");
    expect(codeGroups("49271638")).toEqual(["49", "271", "638"]);
  });

  it("still groups a legacy six-digit code in pairs", () => {
    // Kept as regression coverage for the legacy parse path: a code minted by
    // a CLI at 0.5 must still render on a client at 0.6.
    expect(formatCodeForDisplay("492716")).toBe("49 27 16");
  });

  it("refuses to display a malformed code", () => {
    expect(() => formatCodeForDisplay("49271")).toThrow(/Invalid pairing code/);
  });
});

describe("parsing what a human actually types", () => {
  it("accepts spaces and dashes", () => {
    for (const input of [
      "49271638",
      "49 271 638",
      "49-271638",
      " 4 9 2 7 1 6 3 8 ",
    ]) {
      expect(parseCode(input)).toEqual({ slot: "49", secret: "271638" });
    }
  });

  it("accepts six and eight digits, and rejects seven", () => {
    // Both lengths parse, because a big-bang length change still has to read
    // codes minted by whatever is already installed. Only one is *emitted*.
    expect(parseCode("492716")).toEqual({ slot: "49", secret: "2716" });
    expect(parseCode("49271638")).toEqual({ slot: "49", secret: "271638" });
    for (const bad of [
      "",
      "49271",
      "4927163",
      "492716389",
      "abcdefgh",
      "492716.8",
      "49_271638",
    ]) {
      expect(parseCode(bad)).toBeNull();
      expect(normalizeCode(bad)).toBeNull();
    }
  });

  it("keeps leading zeros in both halves", () => {
    expect(parseCode("00000000")).toEqual({ slot: "00", secret: "000000" });
    expect(parseCode("01000023")).toEqual({ slot: "01", secret: "000023" });
  });

  it("round-trips generated codes", () => {
    for (let i = 0; i < 200; i++) {
      const slot = generateSlot();
      const secret = generateSecret();
      expect(parseCode(formatCode(slot, secret))).toEqual({ slot, secret });
    }
  });
});

describe("the form table", () => {
  it("gives every wire form a unique length", () => {
    // Length is the *only* thing telling the four forms apart — there is no
    // prefix and no version byte. Two forms sharing a length would make a code
    // ambiguous, and the failure mode is a pairing that derives two different
    // keys from one correct code: indistinguishable from a wrong code.
    const codes = [
      formatCode("49", "2716"), // legacy typed
      formatCode("49", "271638"), // typed
      formatLongCode("49", generateLongSecret()), // legacy scan
      formatLongCode("0049", generateLongSecret()), // scan
    ];
    const lengths = codes.map((c) => c.length);
    expect(lengths).toEqual([6, 8, 24, 26]);
    expect(new Set(lengths).size).toBe(lengths.length);
  });

  it("parses each form back to the halves it was built from", () => {
    expect(parseCode(formatCode("49", "2716"))).toEqual({
      slot: "49",
      secret: "2716",
    });
    expect(parseCode(formatCode("49", "271638"))).toEqual({
      slot: "49",
      secret: "271638",
    });
    const long = generateLongSecret();
    expect(parseCode(formatLongCode("49", long))).toEqual({
      slot: "49",
      secret: long,
    });
    expect(parseCode(formatLongCode("0049", long))).toEqual({
      slot: "0049",
      secret: long,
    });
  });

  it("reports the lengths it accepts, for error copy", () => {
    expect(typedCodeLengths()).toEqual([6, 8]);
  });
});

describe("the long secret the QR carries", () => {
  it("is 22 base64url characters, and always exactly that", () => {
    for (let i = 0; i < 200; i++) {
      const secret = generateLongSecret();
      expect(secret).toHaveLength(LONG_SECRET_CHARS);
      expect(isValidLongSecret(secret)).toBe(true);
      // Unpadded: '=' would have to be escaped in a URL fragment.
      expect(secret).not.toContain("=");
    }
  });

  it("carries the full 128 bits", () => {
    // Not a distribution test — that is what a CSPRNG is for. This pins the
    // width, because silently generating fewer bytes here would weaken the
    // path most people use while every other test kept passing.
    expect(LONG_SECRET_BYTES).toBe(16);
    expect(LONG_SECRET_CHARS).toBe(Math.ceil((LONG_SECRET_BYTES * 4) / 3));

    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateLongSecret());
    expect(seen.size).toBe(500);
  });

  it("rejects anything that is not the exact shape", () => {
    for (const bad of [
      "",
      "short",
      "A".repeat(LONG_SECRET_CHARS - 1),
      "A".repeat(LONG_SECRET_CHARS + 1),
      // '+' and '/' are base64, not base64url — they would need escaping.
      `${"A".repeat(LONG_SECRET_CHARS - 1)}+`,
      `${"A".repeat(LONG_SECRET_CHARS - 1)}/`,
    ]) {
      expect(isValidLongSecret(bad)).toBe(false);
    }
  });

  it("round-trips through parseCode alongside the typed form", () => {
    for (let i = 0; i < 200; i++) {
      const slot = generateQrSlot();
      const secret = generateLongSecret();
      expect(parseCode(formatLongCode(slot, secret))).toEqual({ slot, secret });
    }
  });

  it("draws its slot from the whole four-digit space", () => {
    // The scan space is 100× the typed one, which is what stops a sweep of the
    // two-digit space from touching a scanned pairing at all.
    //
    // Not coupon-collector — that would need ~92k draws. 40k over 10k values
    // covers 1-e⁻⁴ ≈ 98% of the space, and a generator that had quietly
    // collapsed to a narrower range could not reach anywhere near it.
    const seen = new Set<string>();
    for (let i = 0; i < 40_000; i++) seen.add(generateQrSlot());
    expect(seen.size).toBeGreaterThan(QR_SLOT_COUNT * 0.97);
    expect([...seen].some((s) => s.startsWith("00"))).toBe(true);
    expect([...seen].every((s) => s.length === 4)).toBe(true);
  });

  it("never mangles a secret containing a dash", () => {
    // The whole reason the long form skips `normalizeCode`: '-' is a base64url
    // character, and stripping it as punctuation would corrupt roughly one
    // secret in eight while looking like a wrong code.
    const secret = `-${"A".repeat(LONG_SECRET_CHARS - 2)}-`;
    expect(isValidLongSecret(secret)).toBe(true);
    expect(parseCode(`49${secret}`)).toEqual({ slot: "49", secret });
  });

  it("still rejects the shapes that are neither form", () => {
    for (const bad of ["49", "4".repeat(23), `49${"A".repeat(21)}`]) {
      expect(parseCode(bad)).toBeNull();
    }
  });

  it("refuses to format a malformed long code", () => {
    expect(() => formatLongCode("4", generateLongSecret())).toThrow();
    expect(() => formatLongCode("49", "too-short")).toThrow();
  });
});
