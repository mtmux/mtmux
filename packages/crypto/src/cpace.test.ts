import { describe, it, expect } from "vitest";
import { sha512 } from "@noble/hashes/sha2.js";
import { ristretto255 } from "@noble/curves/ed25519.js";
import {
  generatorString,
  calculateGenerator,
  computeShare,
  sampleScalar,
  scalarMultVfy,
  transcriptIr,
  iskInitiatorResponder,
  cpaceStart,
  SCALAR_BYTES,
} from "./cpace.js";
import { bytesToHex, hexToBytes, utf8ToBytes, randomBytes } from "./bytes.js";

/**
 * Vectors from draft-irtf-cfrg-cpace-13, Appendix B.3 (CPACE-RISTR255-SHA512).
 * These are the load-bearing tests: they are what makes a hand-written PAKE
 * trustworthy at all.
 */
const V = {
  prs: utf8ToBytes("Password"),
  ci: hexToBytes("6f630b425f726573706f6e6465720b415f696e69746961746f72"),
  sid: hexToBytes("7e4b4791d6a8ef019b936c79fb7f2c57"),
  generatorString:
    "11435061636552697374726574746f3235350850617373776f72646400000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "1a6f630b425f726573706f6e6465720b415f696e69746961746f72107e4b4791" +
    "d6a8ef019b936c79fb7f2c57",
  generatorHash:
    "c63a5750e2439c17ccd8213be14fde2f87e1bc637001a97f5929c77b30ea0e08" +
    "afbc75ace5d3d73b2842a79d01488c5fd7ea30d475ee609545af1bfd1ff77c8e",
  generator: "a6fc82c3b8968fbb2e06fee81ca858586dea50d248f0c7ca6a18b0902a30b36b",
  ada: utf8ToBytes("ADa"),
  ya: hexToBytes(
    "da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08",
  ),
  Ya: "d40fb265a7abeaee7939d91a585fe59f7053f982c296ec413c624c669308f87a",
  adb: utf8ToBytes("ADb"),
  yb: hexToBytes(
    "d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d",
  ),
  Yb: "08bcf6e9777a9c313a3db6daa510f2d398403319c2341bd506a92e672eb7e307",
  K: "e22b1ef7788f661478f3cddd4c600774fc0f41e6b711569190ff88fa0e607e09",
  transcriptIr:
    "20d40fb265a7abeaee7939d91a585fe59f7053f982c296ec413c624c669308f8" +
    "7a034144612008bcf6e9777a9c313a3db6daa510f2d398403319c2341bd506a92e67" +
    "2eb7e30703414462",
  isk:
    "4c5469a16b2364c4b944ebc1a79e51d1674ad47db26e8718154f59faebfaa52d" +
    "8346f30aa58377117eb20d527f2cbc5c76381f7fd372e89df8239f87f2e02ed1",
};

describe("CPace draft-irtf-cfrg-cpace-13 §B.3 vectors", () => {
  it("builds the generator string, including the 100-byte zero pad", () => {
    const gen = generatorString(V.prs, V.ci, V.sid);
    expect(gen.length).toBe(172);
    expect(bytesToHex(gen)).toBe(V.generatorString);
  });

  it("hashes the generator string to the published digest", () => {
    expect(bytesToHex(sha512(generatorString(V.prs, V.ci, V.sid)))).toBe(
      V.generatorHash,
    );
  });

  it("maps the digest to the published generator", () => {
    expect(bytesToHex(calculateGenerator(V.prs, V.ci, V.sid))).toBe(
      V.generator,
    );
  });

  it("derives Ya and Yb from the published scalars", () => {
    const share = (y: Uint8Array) =>
      bytesToHex(computeShare(V.prs, V.ci, V.sid, sampleScalar(y)));
    expect(share(V.ya)).toBe(V.Ya);
    expect(share(V.yb)).toBe(V.Yb);
  });

  it("agrees on K from either side", () => {
    expect(
      bytesToHex(scalarMultVfy(sampleScalar(V.ya), hexToBytes(V.Yb))),
    ).toBe(V.K);
    expect(
      bytesToHex(scalarMultVfy(sampleScalar(V.yb), hexToBytes(V.Ya))),
    ).toBe(V.K);
  });

  it("builds transcript_ir in initiator-first order", () => {
    const t = transcriptIr(hexToBytes(V.Ya), V.ada, hexToBytes(V.Yb), V.adb);
    expect(t.length).toBe(74);
    expect(bytesToHex(t)).toBe(V.transcriptIr);
  });

  it("derives the published ISK", () => {
    expect(
      bytesToHex(
        iskInitiatorResponder(
          V.sid,
          hexToBytes(V.K),
          hexToBytes(V.Ya),
          V.ada,
          hexToBytes(V.Yb),
          V.adb,
        ),
      ),
    ).toBe(V.isk);
  });

  it("reaches the published ISK through the public cpaceStart API", () => {
    const a = cpaceStart(V.prs, V.ci, V.sid, V.ya);
    const b = cpaceStart(V.prs, V.ci, V.sid, V.yb);
    expect(bytesToHex(a.share)).toBe(V.Ya);
    expect(bytesToHex(b.share)).toBe(V.Yb);

    const iskA = a.finish(b.share, {
      own: V.ada,
      peer: V.adb,
      isInitiator: true,
    });
    const iskB = b.finish(a.share, {
      own: V.adb,
      peer: V.ada,
      isInitiator: false,
    });
    expect(bytesToHex(iskA)).toBe(V.isk);
    expect(bytesToHex(iskB)).toBe(V.isk);
  });
});

describe("CPace scalar sampling", () => {
  it("clears the bits above 252 so every scalar is below the group order", () => {
    const order = ristretto255.Point.Fn.ORDER;
    for (let i = 0; i < 200; i++) {
      const scalar = sampleScalar();
      expect(scalar).toBeLessThan(order);
      expect(scalar).toBeLessThan(1n << 252n);
    }
  });

  it("clamps a maximal seed rather than overflowing", () => {
    const scalar = sampleScalar(new Uint8Array(SCALAR_BYTES).fill(0xff));
    expect(scalar).toBe((1n << 252n) - 1n);
  });

  it("rejects a seed of the wrong length", () => {
    expect(() => sampleScalar(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe("CPace end-to-end behaviour", () => {
  const ci = utf8ToBytes("49");
  const sid = randomBytes(16);
  const ad = { own: new Uint8Array(), peer: new Uint8Array() };

  it("agrees on a key when both sides know the password", () => {
    const pw = utf8ToBytes("2716");
    const a = cpaceStart(pw, ci, sid);
    const b = cpaceStart(pw, ci, sid);
    const iskA = a.finish(b.share, { ...ad, isInitiator: true });
    const iskB = b.finish(a.share, { ...ad, isInitiator: false });
    expect(bytesToHex(iskA)).toBe(bytesToHex(iskB));
    expect(iskA.length).toBe(64);
  });

  it("produces unrelated keys when the passwords differ by one digit", () => {
    const a = cpaceStart(utf8ToBytes("2716"), ci, sid);
    const b = cpaceStart(utf8ToBytes("2717"), ci, sid);
    const iskA = a.finish(b.share, { ...ad, isInitiator: true });
    const iskB = b.finish(a.share, { ...ad, isInitiator: false });
    expect(bytesToHex(iskA)).not.toBe(bytesToHex(iskB));
  });

  it("produces unrelated keys when the channel identifier differs", () => {
    const pw = utf8ToBytes("2716");
    const a = cpaceStart(pw, utf8ToBytes("49"), sid);
    const b = cpaceStart(pw, utf8ToBytes("50"), sid);
    expect(
      bytesToHex(a.finish(b.share, { ...ad, isInitiator: true })),
    ).not.toBe(bytesToHex(b.finish(a.share, { ...ad, isInitiator: false })));
  });

  it("produces unrelated keys when the session id differs", () => {
    const pw = utf8ToBytes("2716");
    const a = cpaceStart(pw, ci, randomBytes(16));
    const b = cpaceStart(pw, ci, randomBytes(16));
    expect(
      bytesToHex(a.finish(b.share, { ...ad, isInitiator: true })),
    ).not.toBe(bytesToHex(b.finish(a.share, { ...ad, isInitiator: false })));
  });

  it("binds the associated data into the key", () => {
    const pw = utf8ToBytes("2716");
    const a = cpaceStart(pw, ci, sid);
    const b = cpaceStart(pw, ci, sid);
    const honest = a.finish(b.share, {
      own: utf8ToBytes("device-a"),
      peer: utf8ToBytes("device-b"),
      isInitiator: true,
    });
    const tampered = b.finish(a.share, {
      own: utf8ToBytes("device-b"),
      peer: utf8ToBytes("device-EVIL"),
      isInitiator: false,
    });
    expect(bytesToHex(honest)).not.toBe(bytesToHex(tampered));
  });

  it("fails both ways if the two sides disagree on who initiated", () => {
    const pw = utf8ToBytes("2716");
    const a = cpaceStart(pw, ci, sid);
    const b = cpaceStart(pw, ci, sid);
    expect(
      bytesToHex(a.finish(b.share, { ...ad, isInitiator: true })),
    ).not.toBe(bytesToHex(b.finish(a.share, { ...ad, isInitiator: true })));
  });

  it("gives a different key on every run with the same password", () => {
    const pw = utf8ToBytes("2716");
    const keys = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const s = randomBytes(16);
      const a = cpaceStart(pw, ci, s);
      const b = cpaceStart(pw, ci, s);
      keys.add(bytesToHex(a.finish(b.share, { ...ad, isInitiator: true })));
    }
    expect(keys.size).toBe(10);
  });
});

describe("scalarMultVfy rejects hostile shares", () => {
  const scalar = sampleScalar();

  it("refuses the identity element", () => {
    expect(() =>
      scalarMultVfy(scalar, ristretto255.Point.ZERO.toBytes()),
    ).toThrow(/identity/);
  });

  it("refuses a share of the wrong length", () => {
    expect(() => scalarMultVfy(scalar, new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => scalarMultVfy(scalar, new Uint8Array(33))).toThrow(/32 bytes/);
  });

  it("refuses 32 bytes that are not a canonical ristretto255 encoding", () => {
    expect(() => scalarMultVfy(scalar, new Uint8Array(32).fill(0xff))).toThrow(
      /valid ristretto255 element/,
    );
  });

  it("accepts a genuine share", () => {
    expect(
      scalarMultVfy(scalar, ristretto255.Point.BASE.toBytes()),
    ).toHaveLength(32);
  });
});
