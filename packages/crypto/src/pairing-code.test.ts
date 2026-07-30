import { describe, it, expect } from "vitest";
import {
  generateSecret,
  generateSlot,
  formatCode,
  formatCodeForDisplay,
  normalizeCode,
  parseCode,
  isValidSlot,
  isValidSecret,
  isValidLongSecret,
  generateLongSecret,
  formatLongCode,
  LONG_SECRET_BYTES,
  LONG_SECRET_CHARS,
  SECRET_COUNT,
  SLOT_COUNT,
} from "./pairing-code";

describe("code generation", () => {
  it("always produces exactly four secret digits, zeros included", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateSecret()).toMatch(/^\d{4}$/);
    }
  });

  it("always produces exactly two slot digits", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateSlot()).toMatch(/^\d{2}$/);
    }
  });

  it("covers the low end of the range — no lost leading zeros", () => {
    // With 20k draws over 10k values, seeing a value under 100 is essentially
    // certain unless zero-padding is broken.
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(generateSecret());
    expect([...seen].some((s) => s.startsWith("00"))).toBe(true);
    expect(seen.size).toBeGreaterThan(SECRET_COUNT * 0.5);
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
    expect(isValidSecret("2716")).toBe(true);
    expect(isValidSecret("0000")).toBe(true);
  });

  it("rejects the wrong number of digits or non-digits", () => {
    for (const bad of ["4", "490", "", "4a", " 9", "-9"]) {
      expect(isValidSlot(bad)).toBe(false);
    }
    for (const bad of ["271", "27160", "", "27a6", "２７１６"]) {
      expect(isValidSecret(bad)).toBe(false);
    }
  });
});

describe("formatting", () => {
  it("joins the two halves in slot-then-secret order", () => {
    expect(formatCode("49", "2716")).toBe("492716");
  });

  it("refuses to format malformed halves", () => {
    expect(() => formatCode("4", "2716")).toThrow(/slot/);
    expect(() => formatCode("49", "271")).toThrow(/secret/);
  });

  it("groups the code in pairs for reading aloud", () => {
    expect(formatCodeForDisplay("492716")).toBe("49 27 16");
    expect(formatCodeForDisplay("49 27 16")).toBe("49 27 16");
  });

  it("refuses to display a malformed code", () => {
    expect(() => formatCodeForDisplay("49271")).toThrow(/Invalid pairing code/);
  });
});

describe("parsing what a human actually types", () => {
  it("accepts spaces and dashes", () => {
    for (const input of ["492716", "49 27 16", "49-2716", " 4 9 2 7 1 6 "]) {
      expect(parseCode(input)).toEqual({ slot: "49", secret: "2716" });
    }
  });

  it("rejects anything that is not six digits", () => {
    for (const bad of ["", "49271", "4927167", "abcdef", "4927.6", "49_2716"]) {
      expect(parseCode(bad)).toBeNull();
      expect(normalizeCode(bad)).toBeNull();
    }
  });

  it("keeps leading zeros in both halves", () => {
    expect(parseCode("000000")).toEqual({ slot: "00", secret: "0000" });
    expect(parseCode("010023")).toEqual({ slot: "01", secret: "0023" });
  });

  it("round-trips generated codes", () => {
    for (let i = 0; i < 200; i++) {
      const slot = generateSlot();
      const secret = generateSecret();
      expect(parseCode(formatCode(slot, secret))).toEqual({ slot, secret });
    }
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
      const slot = generateSlot();
      const secret = generateLongSecret();
      expect(parseCode(formatLongCode(slot, secret))).toEqual({ slot, secret });
    }
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
