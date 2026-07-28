import { describe, it, expect } from "vitest";
import {
  cpaceStart,
  deriveSessionKeys,
  confirmationTag,
  verifyConfirmation,
  transcriptIr,
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  bytesToBase64Url,
  FrameSealer,
  type SessionKeys,
} from "@repo/crypto";
import type { SealedDescriptor } from "@repo/protocol";
import {
  joinPairing,
  startPairing,
  type PairingUpdate,
} from "@/lib/pairing-client";

/**
 * The browser claiming a code the terminal is showing, against a scripted CLI
 * running the real CPace exchange. A transcript ordered the wrong way round
 * fails these rather than deriving two different keys from one correct code —
 * which on a real network looks exactly like a mistyped code.
 */

const DESCRIPTOR: SealedDescriptor = {
  candidates: ["http://192.168.1.5:14100"],
  tunnelId: "tnl-abcdefgh",
  deviceId: "0".repeat(16),
  publicKey: "1".repeat(64),
  label: "gagan@thinkpad",
};

const API = "http://broker.test";
const SLOT = "49";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  let closed = false;
  const ws = {
    onmessage: null as ((event: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
    send: (raw: string) =>
      sent.push(JSON.parse(raw) as Record<string, unknown>),
    close: () => {
      closed = true;
    },
  };
  return {
    ws: ws as unknown as WebSocket,
    sent,
    get closed() {
      return closed;
    },
    deliver: (msg: unknown) => ws.onmessage?.({ data: JSON.stringify(msg) }),
    drop: () => ws.onclose?.(),
    find: (type: string, peer?: string) =>
      sent.find(
        (m) => m.type === type && (peer === undefined || m.peer === peer),
      ) as Record<string, string> | undefined,
  };
}

/** Records `onUpdate` and lets a test await a particular phase. */
function recorder() {
  const updates: PairingUpdate[] = [];
  const waiters: { phase: string; resolve: (u: PairingUpdate) => void }[] = [];
  return {
    updates,
    onUpdate(update: PairingUpdate) {
      updates.push(update);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.phase === update.phase) {
          waiters.splice(i, 1)[0]!.resolve(update);
        }
      }
    },
    waitFor(phase: PairingUpdate["phase"]) {
      const seen = updates.find((u) => u.phase === phase);
      if (seen) return Promise.resolve(seen);
      return new Promise<PairingUpdate>((resolve) =>
        waiters.push({ phase, resolve }),
      );
    },
    last: () => updates[updates.length - 1],
  };
}

type Claim = { slot: string; share: string; ad: string; sid: string };

function claimHarness(opts: { offered: number; status?: number }) {
  const io = fakeSocket();
  let claim: Claim | null = null;

  const fetchImpl = ((_url: string, init?: RequestInit) => {
    claim = JSON.parse(init!.body as string) as Claim;
    const status = opts.status ?? 200;
    return Promise.resolve({
      ok: status < 400,
      status,
      json: () =>
        Promise.resolve({ claimId: "clm-abcdefgh", offered: opts.offered }),
    } as unknown as Response);
  }) as unknown as typeof fetch;

  /**
   * One terminal answering the claim: it derives its key as the CPace
   * responder, then sends its share and its tag before the browser has proved
   * anything.
   */
  function cliAnswers(peer: string, secret: string) {
    const c = claim!;
    const cpace = cpaceStart(
      utf8ToBytes(secret),
      utf8ToBytes(c.slot),
      hexToBytes(c.sid),
    );
    const peerShare = hexToBytes(c.share);
    const isk = cpace.finish(peerShare, {
      own: utf8ToBytes("cli"),
      peer: utf8ToBytes(c.ad),
      isInitiator: false,
    });
    const keys = deriveSessionKeys(
      isk,
      transcriptIr(
        peerShare,
        utf8ToBytes(c.ad),
        cpace.share,
        utf8ToBytes("cli"),
      ),
    );

    io.deliver({
      type: "pair:peer-share",
      peer,
      share: bytesToHex(cpace.share),
      ad: "cli",
      sid: c.sid,
    });
    io.deliver({
      type: "pair:peer-confirm",
      peer,
      tag: bytesToHex(confirmationTag(keys.confirm, "cli")),
    });

    return {
      keys,
      /** Seal the descriptor and end the exchange, as the CLI does. */
      async establish() {
        const sealer = new FrameSealer(keys.s2c, "s2c");
        const sealed = await sealer.seal(
          utf8ToBytes(JSON.stringify(DESCRIPTOR)),
        );
        io.deliver({
          type: "pair:established",
          peer,
          sealedDescriptor: bytesToBase64Url(sealed),
        });
      },
      /** Did the browser's answering tag verify on this side? */
      browserTagVerifies() {
        const confirm = io.find("pair:confirm", peer);
        return (
          confirm !== undefined &&
          verifyConfirmation(keys.confirm, "browser", hexToBytes(confirm.tag!))
        );
      },
    };
  }

  return {
    io,
    fetchImpl,
    cliAnswers,
    get claim() {
      return claim;
    },
  };
}

function join(
  h: ReturnType<typeof claimHarness>,
  rec: ReturnType<typeof recorder>,
  code: string,
) {
  return joinPairing({
    apiBase: API,
    code,
    onUpdate: rec.onUpdate,
    fetchImpl: h.fetchImpl,
    socketImpl: () => h.io.ws,
  });
}

describe("joinPairing", () => {
  it("rejects anything that is not six digits before contacting the broker", async () => {
    const h = claimHarness({ offered: 1 });
    const rec = recorder();
    join(h, rec, "12345");
    const failed = await rec.waitFor("failed");
    expect(failed).toMatchObject({ phase: "failed" });
    expect(h.claim).toBeNull();
  });

  it("accepts spaced and dashed codes", async () => {
    const h = claimHarness({ offered: 0 });
    const rec = recorder();
    join(h, rec, "49 27-16");
    await rec.waitFor("failed");
    expect(h.claim?.slot).toBe("49");
  });

  it("never puts the four-digit secret in the claim", async () => {
    const h = claimHarness({ offered: 0 });
    const rec = recorder();
    join(h, rec, `${SLOT}2716`);
    await rec.waitFor("failed");
    expect(JSON.stringify(h.claim)).not.toContain("2716");
    expect(h.claim?.ad).toBe("browser");
  });

  it("pairs with the terminal and opens the sealed descriptor", async () => {
    const secret = "2716";
    const h = claimHarness({ offered: 1 });
    const rec = recorder();
    join(h, rec, `${SLOT}${secret}`);
    await flush();

    const cli = h.cliAnswers("peer-0", secret);
    expect(cli.browserTagVerifies()).toBe(true);
    await cli.establish();

    const paired = (await rec.waitFor("paired")) as Extract<
      PairingUpdate,
      { phase: "paired" }
    >;
    expect(paired.descriptor).toEqual(DESCRIPTOR);
    expect(bytesToHex(paired.keys.c2s)).toBe(bytesToHex(cli.keys.c2s));
    expect(paired.keys.directToken).toBe(cli.keys.directToken);
  });

  it("keeps the terminal whose tag verifies and closes every decoy", async () => {
    const secret = "2716";
    const h = claimHarness({ offered: 3 });
    const rec = recorder();
    join(h, rec, `${SLOT}${secret}`);
    await flush();

    h.cliAnswers("peer-0", "0000");
    h.cliAnswers("peer-1", "9999");
    const real = h.cliAnswers("peer-2", secret);
    await real.establish();

    const paired = (await rec.waitFor("paired")) as Extract<
      PairingUpdate,
      { phase: "paired" }
    >;
    expect(bytesToHex(paired.keys.c2s)).toBe(bytesToHex(real.keys.c2s));

    // Closing a decoy destroys its mailbox — one guess per code, even when the
    // slot is shared by several pairings at once.
    expect(h.io.find("pair:close", "peer-0")).toBeDefined();
    expect(h.io.find("pair:close", "peer-1")).toBeDefined();
    expect(h.io.find("pair:close", "peer-2")).toBeUndefined();
  });

  it("fails once every offered mailbox has been ruled out", async () => {
    const h = claimHarness({ offered: 2 });
    const rec = recorder();
    join(h, rec, `${SLOT}2716`);
    await flush();
    h.cliAnswers("peer-0", "0000");
    h.cliAnswers("peer-1", "9999");

    const failed = (await rec.waitFor("failed")) as Extract<
      PairingUpdate,
      { phase: "failed" }
    >;
    expect(failed.message).toMatch(/did not match/);
  });

  it("refuses a tampered confirmation tag", async () => {
    const secret = "2716";
    const h = claimHarness({ offered: 1 });
    const rec = recorder();
    join(h, rec, `${SLOT}${secret}`);
    await flush();

    const c = h.claim!;
    const cpace = cpaceStart(
      utf8ToBytes(secret),
      utf8ToBytes(c.slot),
      hexToBytes(c.sid),
    );
    h.io.deliver({
      type: "pair:peer-share",
      peer: "peer-0",
      share: bytesToHex(cpace.share),
      ad: "cli",
      sid: c.sid,
    });
    h.io.deliver({
      type: "pair:peer-confirm",
      peer: "peer-0",
      tag: "a".repeat(64),
    });

    await rec.waitFor("failed");
    expect(h.io.find("pair:close", "peer-0")).toBeDefined();
    expect(h.io.find("pair:confirm", "peer-0")).toBeUndefined();
  });

  it("refuses a share that is not a valid group element", async () => {
    const h = claimHarness({ offered: 1 });
    const rec = recorder();
    join(h, rec, `${SLOT}2716`);
    await flush();
    h.io.deliver({
      type: "pair:peer-share",
      peer: "peer-evil",
      share: "f".repeat(64),
      ad: "cli",
      sid: h.claim!.sid,
    });
    await rec.waitFor("failed");
    expect(h.io.find("pair:close", "peer-evil")).toBeDefined();
  });

  it("ignores a second share for a conversation already under way", async () => {
    const secret = "2716";
    const h = claimHarness({ offered: 1 });
    const rec = recorder();
    join(h, rec, `${SLOT}${secret}`);
    await flush();

    const cli = h.cliAnswers("peer-0", secret);
    h.io.deliver({
      type: "pair:peer-share",
      peer: "peer-0",
      share: "f".repeat(64),
      ad: "cli",
      sid: h.claim!.sid,
    });
    expect(h.io.find("pair:close", "peer-0")).toBeUndefined();

    await cli.establish();
    const paired = (await rec.waitFor("paired")) as Extract<
      PairingUpdate,
      { phase: "paired" }
    >;
    expect(bytesToHex(paired.keys.c2s)).toBe(bytesToHex(cli.keys.c2s));
  });

  it("reports a code nobody is waiting for", async () => {
    const h = claimHarness({ offered: 0 });
    const rec = recorder();
    join(h, rec, `${SLOT}2716`);
    const failed = (await rec.waitFor("failed")) as Extract<
      PairingUpdate,
      { phase: "failed" }
    >;
    expect(failed.message).toMatch(/Nothing is waiting/);
  });

  it("reports being rate limited", async () => {
    const h = claimHarness({ offered: 1, status: 429 });
    const rec = recorder();
    join(h, rec, `${SLOT}2716`);
    const failed = (await rec.waitFor("failed")) as Extract<
      PairingUpdate,
      { phase: "failed" }
    >;
    expect(failed.message).toMatch(/Too many/);
  });

  it("surfaces a lost broker connection", async () => {
    const h = claimHarness({ offered: 1 });
    const rec = recorder();
    join(h, rec, `${SLOT}2716`);
    await flush();
    h.io.drop();
    const failed = (await rec.waitFor("failed")) as Extract<
      PairingUpdate,
      { phase: "failed" }
    >;
    expect(failed.message).toMatch(/Lost the connection/);
  });

  it("stops reacting once cancelled", async () => {
    const secret = "2716";
    const h = claimHarness({ offered: 1 });
    const rec = recorder();
    const handle = join(h, rec, `${SLOT}${secret}`);
    await flush();
    handle.cancel();
    const cli = h.cliAnswers("peer-0", secret);
    await cli.establish();
    await flush();
    expect(rec.updates.some((u) => u.phase === "paired")).toBe(false);
  });
});

describe("startPairing", () => {
  function newHarness(expiresAt: number) {
    const io = fakeSocket();
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            mailboxId: "mbx-abcdefgh",
            slot: SLOT,
            expiresAt,
          }),
      } as unknown as Response)) as unknown as typeof fetch;
    return { io, fetchImpl };
  }

  it("shows a six-digit code whose first two digits are the broker's slot", async () => {
    const h = newHarness(Date.now() + 180_000);
    const rec = recorder();
    startPairing({
      apiBase: API,
      onUpdate: rec.onUpdate,
      fetchImpl: h.fetchImpl,
      socketImpl: () => h.io.ws,
    });
    const waiting = (await rec.waitFor("waiting")) as Extract<
      PairingUpdate,
      { phase: "waiting" }
    >;
    expect(waiting.code).toMatch(/^\d{6}$/);
    expect(waiting.code.slice(0, 2)).toBe(SLOT);
  });

  it("takes the mailbox's own deadline from pair:ready", async () => {
    const fromPost = Date.now() + 180_000;
    const fromSocket = fromPost - 5_000;
    const h = newHarness(fromPost);
    const rec = recorder();
    startPairing({
      apiBase: API,
      onUpdate: rec.onUpdate,
      fetchImpl: h.fetchImpl,
      socketImpl: () => h.io.ws,
    });
    const first = (await rec.waitFor("waiting")) as Extract<
      PairingUpdate,
      { phase: "waiting" }
    >;

    h.io.deliver({
      type: "pair:ready",
      mailboxId: "mbx-abcdefgh",
      slot: SLOT,
      expiresAt: fromSocket,
    });

    const updates = rec.updates.filter((u) => u.phase === "waiting") as Extract<
      PairingUpdate,
      { phase: "waiting" }
    >[];
    expect(updates).toHaveLength(2);
    // Same code, the broker's authoritative expiry.
    expect(updates[1]!.code).toBe(first.code);
    expect(updates[1]!.expiresAt).toBe(fromSocket);
  });

  it("pairs with a terminal that claims its code", async () => {
    const h = newHarness(Date.now() + 180_000);
    const rec = recorder();
    startPairing({
      apiBase: API,
      onUpdate: rec.onUpdate,
      fetchImpl: h.fetchImpl,
      socketImpl: () => h.io.ws,
    });
    const waiting = (await rec.waitFor("waiting")) as Extract<
      PairingUpdate,
      { phase: "waiting" }
    >;
    const secret = waiting.code.slice(2);

    // The CLI claims it: initiator, and it picks the sid.
    const sid = "b".repeat(32);
    const cpace = cpaceStart(
      utf8ToBytes(secret),
      utf8ToBytes(SLOT),
      hexToBytes(sid),
    );
    h.io.deliver({
      type: "pair:peer-share",
      peer: "peer-0",
      share: bytesToHex(cpace.share),
      ad: "cli",
      sid,
    });

    const share = h.io.find("pair:share", "peer-0")!;
    const isk = cpace.finish(hexToBytes(share.share!), {
      own: utf8ToBytes("cli"),
      peer: utf8ToBytes(share.ad!),
      isInitiator: true,
    });
    const keys: SessionKeys = deriveSessionKeys(
      isk,
      transcriptIr(
        cpace.share,
        utf8ToBytes("cli"),
        hexToBytes(share.share!),
        utf8ToBytes(share.ad!),
      ),
    );

    const browserTag = h.io.find("pair:confirm", "peer-0")!;
    expect(
      verifyConfirmation(keys.confirm, "browser", hexToBytes(browserTag.tag!)),
    ).toBe(true);

    h.io.deliver({
      type: "pair:peer-confirm",
      peer: "peer-0",
      tag: bytesToHex(confirmationTag(keys.confirm, "cli")),
    });
    const sealed = await new FrameSealer(keys.s2c, "s2c").seal(
      utf8ToBytes(JSON.stringify(DESCRIPTOR)),
    );
    h.io.deliver({
      type: "pair:established",
      peer: "peer-0",
      sealedDescriptor: bytesToBase64Url(sealed),
    });

    const paired = (await rec.waitFor("paired")) as Extract<
      PairingUpdate,
      { phase: "paired" }
    >;
    expect(paired.descriptor).toEqual(DESCRIPTOR);
    expect(paired.keys.directToken).toBe(keys.directToken);
  });
});
