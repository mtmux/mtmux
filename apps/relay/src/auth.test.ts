import { describe, it, expect } from "vitest";
import { timingSafeEqualToken } from "./auth.js";

describe("timingSafeEqualToken", () => {
  it("accepts an exactly-matching token", () => {
    expect(timingSafeEqualToken("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    expect(timingSafeEqualToken("s3cret-tokeX", "s3cret-token")).toBe(false);
  });

  it("rejects a wrong token of a different length", () => {
    expect(timingSafeEqualToken("short", "s3cret-token")).toBe(false);
    expect(
      timingSafeEqualToken("s3cret-token-and-then-some", "s3cret-token"),
    ).toBe(false);
  });

  it("rejects an empty provided token", () => {
    expect(timingSafeEqualToken("", "s3cret-token")).toBe(false);
  });

  it("handles both sides empty (degenerate) as equal", () => {
    // Both hashes are the sha256 of "", so they compare equal. The relay never
    // reaches this path because config refuses to start on an empty AUTH_TOKEN.
    expect(timingSafeEqualToken("", "")).toBe(true);
  });
});
