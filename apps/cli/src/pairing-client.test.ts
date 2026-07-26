import { describe, it, expect } from "vitest";
import {
  cpaceStart,
  deriveSessionKeys,
  confirmationTag,
  transcriptIr,
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  randomBytes,
  type SessionKeys,
} from "@repo/crypto";
import type { SealedDescriptor } from "@repo/protocol";
import {
  pairWithCode,
  PairingError,
  type PairingSocket,
  type PairingTransport,
} from "./pairing-client.js";

const DESCRIPTOR: SealedDescriptor = {
  candidates: ["http://192.168.1.5:14100"],
  tunnelId: "tnl-abcdefgh",
  deviceId: "0".repeat(16),
  publicKey: "1".repeat(64),
  label: "gagan@thinkpad",
};

/**
 * A stand-in broker plus one or more scripted browsers, each running real
 * CPace. The point is to exercise fan-out: the CLI must survive answering
 * several mailboxes and keep only the one whose confirmation verifies.
 */
function scenario(opts: {
  /** One entry per mailbox that answers, with the secret it believes in. */
  browserSecrets: string[];
  /** Mailboxes that are offered the claim but never answer. */
  silent?: number;
}) {
  const sent: Record<string, unknown>[] = [];
  let inbound: ((raw: string) => void) | null = null;
  let onClose: (() => void) | null = null;
  const closedPeers: string[] = [];
  // Resolves once pairWithCode has posted its claim and wired up the socket,
  // so scripted browsers cannot fire into a listener that does not exist yet.
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  let slot = "";
  let cliShare = "";
  let cliAd = "";
  let sid = "";

  const socket: PairingSocket = {
    send(message) {
      const msg = message as Record<string, unknown>;
      sent.push(msg);
      if (msg.type === "pair:close" && typeof msg.peer === "string") {
        closedPeers.push(msg.peer);
      }
    },
    onMessage(cb) {
      inbound = cb;
      markReady();
    },
    onClose(cb) {
      onClose = cb;
    },
    close() {},
  };

  const transport: PairingTransport = {
    postClaim(body) {
      const b = body as {
        slot: string;
        share: string;
        ad: string;
        sid: string;
      };
      slot = b.slot;
      cliShare = b.share;
      cliAd = b.ad;
      sid = b.sid;
      return Promise.resolve({
        claimId: "clm-abcdefgh",
        offered: opts.browserSecrets.length + (opts.silent ?? 0),
      });
    },
    openClaimSocket() {
      return Promise.resolve(socket);
    },
  };

  function deliver(msg: unknown) {
    inbound?.(JSON.stringify(msg));
  }

  /** Run one browser's half of the exchange and push its messages at the CLI. */
  function runBrowser(index: number) {
    const secret = opts.browserSecrets[index]!;
    const peer = `peer-${index}`;
    const browser = cpaceStart(
      utf8ToBytes(secret),
      utf8ToBytes(slot),
      hexToBytes(sid),
    );
    const ad = "browser";
    const isk = browser.finish(hexToBytes(cliShare), {
      own: utf8ToBytes(ad),
      peer: utf8ToBytes(cliAd),
      isInitiator: false,
    });
    const keys = deriveSessionKeys(
      isk,
      transcriptIr(
        hexToBytes(cliShare),
        utf8ToBytes(cliAd),
        browser.share,
        utf8ToBytes(ad),
      ),
    );

    deliver({
      type: "pair:peer-share",
      peer,
      share: bytesToHex(browser.share),
      ad,
      sid,
    });
    deliver({
      type: "pair:peer-confirm",
      peer,
      tag: bytesToHex(confirmationTag(keys.confirm, "browser")),
    });
    return { peer, keys };
  }

  return {
    transport,
    sent,
    closedPeers,
    deliver,
    runBrowser,
    ready,
    get slot() {
      return slot;
    },
    dropConnection: () => onClose?.(),
  };
}

const sealed: (
  keys: SessionKeys,
  d: SealedDescriptor,
) => Promise<Uint8Array> = () => Promise.resolve(new Uint8Array([1, 2, 3]));

describe("code validation", () => {
  const transport: PairingTransport = {
    postClaim: () => Promise.reject(new Error("should not be called")),
    openClaimSocket: () => Promise.reject(new Error("should not be called")),
  };

  it("refuses anything that is not six digits before contacting the broker", async () => {
    for (const code of ["", "12345", "1234567", "abcdef", "12 34 5"]) {
      await expect(
        pairWithCode({
          code,
          transport,
          buildDescriptor: () => DESCRIPTOR,
          seal: sealed,
        }),
      ).rejects.toThrow(/six-digit/);
    }
  });

  it("accepts spaced and dashed codes", async () => {
    const s = scenario({ browserSecrets: [] });
    // offered === 0 short-circuits, which is enough to prove the code parsed.
    await expect(
      pairWithCode({
        code: "49 27-16",
        transport: s.transport,
        buildDescriptor: () => DESCRIPTOR,
        seal: sealed,
      }),
    ).rejects.toThrow(/No pairing is waiting/);
    expect(s.slot).toBe("49");
  });
});

describe("successful pairing", () => {
  it("derives the browser's key and hands over the sealed descriptor", async () => {
    const secret = "2716";
    const s = scenario({ browserSecrets: [secret] });

    const promise = pairWithCode({
      code: `49${secret}`,
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });

    await s.ready;
    const browser = s.runBrowser(0);
    const result = await promise;

    expect(bytesToHex(result.keys.c2s)).toBe(bytesToHex(browser.keys.c2s));
    expect(result.keys.directToken).toBe(browser.keys.directToken);

    const confirm = s.sent.find((m) => m.type === "pair:confirm");
    expect(confirm?.peer).toBe(browser.peer);
    const establish = s.sent.find((m) => m.type === "pair:establish");
    expect(establish?.sealedDescriptor).toBe("AQID");
  });

  it("never puts the secret on the wire", async () => {
    const secret = "2716";
    const s = scenario({ browserSecrets: [secret] });
    const promise = pairWithCode({
      code: `49${secret}`,
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });
    await s.ready;
    s.runBrowser(0);
    await promise;
    expect(JSON.stringify(s.sent)).not.toContain(secret);
  });
});

describe("fan-out", () => {
  it("ignores mailboxes whose secret does not match and keeps the one that does", async () => {
    const secret = "2716";
    // Two decoys sharing the slot, then the real one.
    const s = scenario({ browserSecrets: ["0000", "9999", secret] });

    const promise = pairWithCode({
      code: `49${secret}`,
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });

    await s.ready;
    s.runBrowser(0);
    s.runBrowser(1);
    const real = s.runBrowser(2);
    const result = await promise;

    expect(bytesToHex(result.keys.c2s)).toBe(bytesToHex(real.keys.c2s));
    // Both decoys were closed, which destroys their mailboxes.
    expect(s.closedPeers.sort()).toEqual(["peer-0", "peer-1"]);
  });

  it("fails once every offered mailbox has been ruled out", async () => {
    const s = scenario({ browserSecrets: ["0000", "9999"] });
    const promise = pairWithCode({
      code: "492716",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });
    await s.ready;
    s.runBrowser(0);
    s.runBrowser(1);
    await expect(promise).rejects.toThrow(/did not match/);
  });
});

describe("failure handling", () => {
  it("reports a code nobody is waiting for", async () => {
    const s = scenario({ browserSecrets: [] });
    await expect(
      pairWithCode({
        code: "492716",
        transport: s.transport,
        buildDescriptor: () => DESCRIPTOR,
        seal: sealed,
      }),
    ).rejects.toThrow(/No pairing is waiting/);
  });

  it("times out rather than hanging", async () => {
    const s = scenario({ browserSecrets: [], silent: 1 });
    await expect(
      pairWithCode({
        code: "492716",
        transport: s.transport,
        buildDescriptor: () => DESCRIPTOR,
        seal: sealed,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("surfaces a lost broker connection", async () => {
    const s = scenario({ browserSecrets: [], silent: 1 });
    const promise = pairWithCode({
      code: "492716",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });
    await s.ready;
    s.dropConnection();
    await expect(promise).rejects.toThrow(/Lost the connection/);
  });

  it("translates broker failure reasons into something actionable", async () => {
    const s = scenario({ browserSecrets: [], silent: 1 });
    const promise = pairWithCode({
      code: "492716",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });
    await s.ready;
    s.deliver({ type: "pair:failed", reason: "expired" });
    await expect(promise).rejects.toThrow(/expired/);
  });

  it("rejects a share that is not a valid group element", async () => {
    const s = scenario({ browserSecrets: [], silent: 1 });
    const promise = pairWithCode({
      code: "492716",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });
    await s.ready;
    s.deliver({
      type: "pair:peer-share",
      peer: "peer-evil",
      share: "f".repeat(64),
      ad: "browser",
      sid: bytesToHex(randomBytes(16)),
    });
    await expect(promise).rejects.toThrow(/did not match/);
    expect(s.closedPeers).toContain("peer-evil");
  });

  it("carries a hint alongside the message", async () => {
    const s = scenario({ browserSecrets: [] });
    const err = await pairWithCode({
      code: "492716",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PairingError);
    expect((err as PairingError).hint).toMatch(/three minutes/);
  });
});
