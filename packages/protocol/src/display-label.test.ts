import { describe, it, expect } from "vitest";
import { sanitizeLabel, displayLabel, MAX_LABEL_LENGTH } from "./display-label";
import { PairRequestMessage, PairRequestBody } from "./pairing-messages";
import { PROTOCOL_VERSION } from "./version";

const ESC = "\u001b";
const CSI = `${ESC}[`;

describe("sanitizeLabel", () => {
  it("leaves an ordinary device name untouched", () => {
    expect(sanitizeLabel("iPhone · Safari")).toBe("iPhone · Safari");
    expect(sanitizeLabel("gagan@thinkpad")).toBe("gagan@thinkpad");
  });

  it("keeps non-ASCII text, which is not the threat", () => {
    expect(sanitizeLabel("Gagan's 📱 — Chrome")).toBe("Gagan's 📱 — Chrome");
    expect(sanitizeLabel("端末")).toBe("端末");
  });

  /**
   * The attack this exists for. 120 bytes is ample room to walk the cursor
   * back over the SAS prompt, erase it, and reprint a code the attacker chose
   * — which the human then confirms.
   */
  it("strips the escape sequences that could redraw the approval prompt", () => {
    const hostile = `${CSI}2A${CSI}2K    Code     123 456${CSI}0m  iPhone`;
    const clean = sanitizeLabel(hostile);
    expect(clean).not.toContain(ESC);
    expect(clean).toBe("[2A[2K    Code     123 456[0m  iPhone");
  });

  it("strips carriage returns and newlines, so a label stays one line", () => {
    expect(sanitizeLabel("iPhone\r\n  Code  000 000")).toBe(
      "iPhone  Code  000 000",
    );
  });

  it("strips C1 and the bidi overrides", () => {
    expect(sanitizeLabel("iPhone\u009bA")).toBe("iPhoneA");
    expect(sanitizeLabel("iPhone\u202egnihP")).toBe("iPhonegnihP");
    expect(sanitizeLabel("iPhone\u200b\u2066x\u2069")).toBe("iPhonex");
  });

  it("bounds the result", () => {
    expect(sanitizeLabel("x".repeat(500))).toHaveLength(MAX_LABEL_LENGTH);
    expect(sanitizeLabel("x".repeat(500), 128)).toHaveLength(128);
  });

  it("does not reject — a hostile label must not be able to fail a pairing", () => {
    expect(sanitizeLabel(`${ESC}${ESC}${ESC}`)).toBe("");
  });
});

describe("displayLabel", () => {
  it("falls back when the label sanitises away to nothing", () => {
    expect(displayLabel(`${ESC}[2K`, "unknown device")).toBe("[2K");
    expect(displayLabel("", "unknown device")).toBe("unknown device");
    expect(displayLabel(null, "unknown device")).toBe("unknown device");
    expect(displayLabel(`${ESC}\r\n`, "unknown device")).toBe("unknown device");
  });
});

describe("the wire schemas sanitise at parse", () => {
  it("cleans pair:request's deviceLabel", () => {
    const parsed = PairRequestMessage.parse({
      type: "pair:request",
      requestId: "r".repeat(32),
      commitment: "a".repeat(64),
      deviceLabel: `${CSI}2A${CSI}2KiPhone`,
      accountEmail: "someone@example.com",
    });
    expect(parsed.deviceLabel).not.toContain(ESC);
  });

  it("cleans the HTTP request body's deviceLabel", () => {
    const parsed = PairRequestBody.parse({
      v: PROTOCOL_VERSION,
      serverId: "srv_12345678",
      deviceLabel: `iPhone${ESC}[31m`,
    });
    expect(parsed.deviceLabel).toBe("iPhone[31m");
  });
});
