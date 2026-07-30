import { describe, it, expect } from "vitest";
import {
  SAS_DIGITS,
  deriveSas,
  formatSas,
  newEphemeralKey,
  sasCommitment,
  sasSharedSecret,
  sasTranscript,
  verifySasCommitment,
} from "./sas";
import { deriveSessionKeys } from "./kdf";
import { bytesToHex } from "./bytes";

const REQUEST = "req-abcdefgh";

/** Both halves of an honest exchange, in the order the protocol runs them. */
function exchange(requestId = REQUEST) {
  const browser = newEphemeralKey();
  const cli = newEphemeralKey();
  const commitment = sasCommitment(browser.publicKey, requestId);

  const transcript = sasTranscript(
    requestId,
    commitment,
    browser.publicKey,
    cli.publicKey,
  );
  const browserIkm = sasSharedSecret(browser.secret, cli.publicKey);
  const cliIkm = sasSharedSecret(cli.secret, browser.publicKey);

  return { browser, cli, commitment, transcript, browserIkm, cliIkm };
}

describe("the SAS both screens show", () => {
  it("agrees on both sides of an honest exchange", () => {
    const x = exchange();
    expect(bytesToHex(x.browserIkm)).toBe(bytesToHex(x.cliIkm));
    expect(deriveSas(x.browserIkm, x.transcript)).toBe(
      deriveSas(x.cliIkm, x.transcript),
    );
  });

  it("is always exactly six digits, leading zeros kept", () => {
    for (let i = 0; i < 300; i++) {
      const x = exchange(`req-${i}`);
      const sas = deriveSas(x.browserIkm, x.transcript);
      expect(sas).toMatch(new RegExp(`^\\d{${SAS_DIGITS}}$`));
    }
  });

  it("spreads across the range rather than clustering", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const x = exchange(`req-${i}`);
      seen.add(deriveSas(x.browserIkm, x.transcript));
    }
    // Collisions in 300 draws over 10^6 are vanishingly unlikely.
    expect(seen.size).toBe(300);
  });

  it("groups for reading aloud", () => {
    expect(formatSas("482173")).toBe("482 173");
  });
});

describe("what the broker cannot do", () => {
  it("changes the SAS if it substitutes the CLI's key", () => {
    // The browser computes its SAS against whatever key it was handed. A broker
    // splicing itself in derives a different secret with the browser than the
    // CLI does, so the two screens disagree and the human refuses.
    const requestId = REQUEST;
    const browser = newEphemeralKey();
    const cli = newEphemeralKey();
    const attacker = newEphemeralKey();
    const commitment = sasCommitment(browser.publicKey, requestId);

    const browserSas = deriveSas(
      sasSharedSecret(browser.secret, attacker.publicKey),
      sasTranscript(
        requestId,
        commitment,
        browser.publicKey,
        attacker.publicKey,
      ),
    );
    const cliSas = deriveSas(
      sasSharedSecret(cli.secret, browser.publicKey),
      sasTranscript(requestId, commitment, browser.publicKey, cli.publicKey),
    );

    expect(browserSas).not.toBe(cliSas);
  });

  it("fails the commitment if it substitutes the browser's key", () => {
    const browser = newEphemeralKey();
    const attacker = newEphemeralKey();
    const commitment = sasCommitment(browser.publicKey, REQUEST);

    expect(verifySasCommitment(commitment, browser.publicKey, REQUEST)).toBe(
      true,
    );
    expect(verifySasCommitment(commitment, attacker.publicKey, REQUEST)).toBe(
      false,
    );
  });

  it("cannot replay a commitment into another request", () => {
    const browser = newEphemeralKey();
    const commitment = sasCommitment(browser.publicKey, "req-one");
    expect(verifySasCommitment(commitment, browser.publicKey, "req-two")).toBe(
      false,
    );
  });

  it("refuses a degenerate peer key", () => {
    // A low-order point forces a known shared secret whatever our scalar is,
    // which would let the broker fix the SAS outright.
    const own = newEphemeralKey();
    const lowOrder = new Uint8Array(32); // all zeroes
    expect(() => sasSharedSecret(own.secret, lowOrder)).toThrow();
  });
});

describe("the transcript", () => {
  it("changes the SAS when any field changes", () => {
    const x = exchange();
    const base = deriveSas(x.browserIkm, x.transcript);

    const other = newEphemeralKey();
    const variants = [
      sasTranscript(
        "req-other",
        x.commitment,
        x.browser.publicKey,
        x.cli.publicKey,
      ),
      sasTranscript(REQUEST, x.commitment, other.publicKey, x.cli.publicKey),
      sasTranscript(
        REQUEST,
        x.commitment,
        x.browser.publicKey,
        other.publicKey,
      ),
    ];
    for (const variant of variants) {
      expect(deriveSas(x.browserIkm, variant)).not.toBe(base);
    }
  });

  it("cannot be forged by shifting a boundary between fields", () => {
    // Length-prefixed concatenation: "ab"+"c" and "a"+"bc" must not collide,
    // or two different exchanges could derive the same key.
    const key = newEphemeralKey().publicKey;
    expect(bytesToHex(sasTranscript("ab", key, key, key))).not.toBe(
      bytesToHex(sasTranscript("a", key, key, key)),
    );
  });
});

describe("the session keys hanging off it", () => {
  it("reuses the existing schedule verbatim and agrees on both sides", () => {
    // Only the source of the ikm changes — CPace's ISK there, X25519 here.
    const x = exchange();
    const a = deriveSessionKeys(x.browserIkm, x.transcript);
    const b = deriveSessionKeys(x.cliIkm, x.transcript);

    expect(bytesToHex(a.c2s)).toBe(bytesToHex(b.c2s));
    expect(bytesToHex(a.s2c)).toBe(bytesToHex(b.s2c));
    expect(a.directToken).toBe(b.directToken);
    expect(bytesToHex(a.c2s)).not.toBe(bytesToHex(a.s2c));
  });

  it("does not leak a session key through the SAS", () => {
    // The SAS is shown to a human and read over a shoulder; it must be a
    // separate HKDF label, not a slice of anything that carries the session.
    const x = exchange();
    const keys = deriveSessionKeys(x.browserIkm, x.transcript);
    const sas = deriveSas(x.browserIkm, x.transcript);
    for (const key of [keys.c2s, keys.s2c, keys.confirm]) {
      expect(bytesToHex(key)).not.toContain(sas);
    }
    expect(keys.directToken).not.toContain(sas);
  });
});
