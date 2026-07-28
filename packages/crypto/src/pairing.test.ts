import { describe, it, expect } from "vitest";
import { cpaceStart, transcriptIr } from "./cpace";
import { deriveSessionKeys, confirmationTag, verifyConfirmation } from "./kdf";
import { FrameOpener, FrameSealer, createFramePair } from "./frames";
import { bytesToHex, randomBytes, utf8ToBytes } from "./bytes";

/**
 * The whole pairing key schedule, run in both directions.
 *
 * `cpace.test.ts` proves the group maths against the draft's vectors and
 * `kdf.test.ts` proves HKDF is wired up; what neither covers is the thing that
 * actually broke when pairing learned to run CLI-first — that the *protocol*
 * around them is symmetric.
 *
 * Two rules make it so, and they pull in opposite directions, which is exactly
 * why they are easy to get wrong:
 *
 *   1. The transcript is ordered **initiator-first**, so it flips when the
 *      roles swap. Whoever claims the code is the initiator.
 *   2. The confirmation roles ("cli"/"browser") and the frame direction tags
 *      ("c2s" = browser→CLI) are **identity** labels. They do not flip.
 *
 * Getting (1) wrong derives two different keys from one correct code, which on
 * a real network is indistinguishable from a mistyped code. Getting (2) wrong
 * breaks one direction only, and only sometimes.
 */

const CI = utf8ToBytes("49");

type Side = { keys: ReturnType<typeof deriveSessionKeys>; share: Uint8Array };

/**
 * One full exchange.
 *
 * @param initiator Which end claimed the code, and is therefore CPace's A.
 */
function pair(opts: {
  initiator: "cli" | "browser";
  cliSecret: string;
  browserSecret: string;
}): { cli: Side; browser: Side } {
  // The claimant picks the session id.
  const sid = randomBytes(16);
  const cliIsInitiator = opts.initiator === "cli";

  const cli = cpaceStart(utf8ToBytes(opts.cliSecret), CI, sid);
  const browser = cpaceStart(utf8ToBytes(opts.browserSecret), CI, sid);

  const cliIsk = cli.finish(browser.share, {
    own: utf8ToBytes("cli"),
    peer: utf8ToBytes("browser"),
    isInitiator: cliIsInitiator,
  });
  const browserIsk = browser.finish(cli.share, {
    own: utf8ToBytes("browser"),
    peer: utf8ToBytes("cli"),
    isInitiator: !cliIsInitiator,
  });

  // Initiator-first, and both sides must build it the same way.
  const transcript = cliIsInitiator
    ? transcriptIr(
        cli.share,
        utf8ToBytes("cli"),
        browser.share,
        utf8ToBytes("browser"),
      )
    : transcriptIr(
        browser.share,
        utf8ToBytes("browser"),
        cli.share,
        utf8ToBytes("cli"),
      );

  return {
    cli: { keys: deriveSessionKeys(cliIsk, transcript), share: cli.share },
    browser: {
      keys: deriveSessionKeys(browserIsk, transcript),
      share: browser.share,
    },
  };
}

describe.each(["cli", "browser"] as const)(
  "pairing with the %s as initiator",
  (initiator) => {
    const secret = "2716";

    it("derives one identical key schedule on both ends", () => {
      const { cli, browser } = pair({
        initiator,
        cliSecret: secret,
        browserSecret: secret,
      });
      expect(bytesToHex(cli.keys.c2s)).toBe(bytesToHex(browser.keys.c2s));
      expect(bytesToHex(cli.keys.s2c)).toBe(bytesToHex(browser.keys.s2c));
      expect(bytesToHex(cli.keys.confirm)).toBe(
        bytesToHex(browser.keys.confirm),
      );
      expect(cli.keys.directToken).toBe(browser.keys.directToken);
    });

    it("cross-verifies confirmation tags under fixed identity labels", () => {
      const { cli, browser } = pair({
        initiator,
        cliSecret: secret,
        browserSecret: secret,
      });
      // "cli" and "browser" name who produced the tag, not who initiated, so
      // these two lines are byte-identical in both parameterisations.
      expect(
        verifyConfirmation(
          browser.keys.confirm,
          "cli",
          confirmationTag(cli.keys.confirm, "cli"),
        ),
      ).toBe(true);
      expect(
        verifyConfirmation(
          cli.keys.confirm,
          "browser",
          confirmationTag(browser.keys.confirm, "browser"),
        ),
      ).toBe(true);
    });

    it("refuses a tag produced under the other identity", () => {
      const { cli, browser } = pair({
        initiator,
        cliSecret: secret,
        browserSecret: secret,
      });
      expect(
        verifyConfirmation(
          browser.keys.confirm,
          "cli",
          confirmationTag(cli.keys.confirm, "browser"),
        ),
      ).toBe(false);
    });

    it("carries frames in both directions with unswapped direction tags", async () => {
      const { cli, browser } = pair({
        initiator,
        cliSecret: secret,
        browserSecret: secret,
      });
      const b = createFramePair(browser.keys, "browser");
      const c = createFramePair(cli.keys, "cli");

      const up = await b.sealer.seal(utf8ToBytes("browser says hello"));
      expect(new TextDecoder().decode(await c.opener.open(up))).toBe(
        "browser says hello",
      );
      const down = await c.sealer.seal(utf8ToBytes("cli says hello"));
      expect(new TextDecoder().decode(await b.opener.open(down))).toBe(
        "cli says hello",
      );
    });

    it("opens the descriptor a fresh sealer produced at counter 0", async () => {
      const { cli, browser } = pair({
        initiator,
        cliSecret: secret,
        browserSecret: secret,
      });
      // The descriptor is sealed by a sealer that exists only for it, so the
      // browser can open it with a fresh opener and no shared counter state.
      const sealed = await new FrameSealer(cli.keys.s2c, "s2c").seal(
        utf8ToBytes('{"tunnelId":"tnl-abcdefgh"}'),
      );
      const opened = await new FrameOpener(browser.keys.s2c, "s2c").open(
        sealed,
      );
      expect(new TextDecoder().decode(opened)).toContain("tnl-abcdefgh");
    });

    it("derives nothing in common when the four digits differ", () => {
      const { cli, browser } = pair({
        initiator,
        cliSecret: "2716",
        browserSecret: "2717",
      });
      expect(bytesToHex(cli.keys.c2s)).not.toBe(bytesToHex(browser.keys.c2s));
      expect(
        verifyConfirmation(
          browser.keys.confirm,
          "cli",
          confirmationTag(cli.keys.confirm, "cli"),
        ),
      ).toBe(false);
    });
  },
);

describe("transcript ordering", () => {
  it("breaks the pairing if one end orders the transcript responder-first", () => {
    const sid = randomBytes(16);
    const pw = utf8ToBytes("2716");
    const cli = cpaceStart(pw, CI, sid);
    const browser = cpaceStart(pw, CI, sid);

    const cliIsk = cli.finish(browser.share, {
      own: utf8ToBytes("cli"),
      peer: utf8ToBytes("browser"),
      isInitiator: false,
    });
    const browserIsk = browser.finish(cli.share, {
      own: utf8ToBytes("browser"),
      peer: utf8ToBytes("cli"),
      isInitiator: true,
    });

    // The browser initiated, so its share leads. A CLI that forgot to flip the
    // order when the direction inverted salts HKDF with a different transcript.
    const correct = transcriptIr(
      browser.share,
      utf8ToBytes("browser"),
      cli.share,
      utf8ToBytes("cli"),
    );
    const wrong = transcriptIr(
      cli.share,
      utf8ToBytes("cli"),
      browser.share,
      utf8ToBytes("browser"),
    );

    expect(bytesToHex(cliIsk)).toBe(bytesToHex(browserIsk));
    expect(bytesToHex(deriveSessionKeys(cliIsk, wrong).c2s)).not.toBe(
      bytesToHex(deriveSessionKeys(browserIsk, correct).c2s),
    );
  });
});
