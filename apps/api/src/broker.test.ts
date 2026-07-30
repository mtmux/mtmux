import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cpaceStart,
  deriveSessionKeys,
  confirmationTag,
  verifyConfirmation,
  generateSecret,
  utf8ToBytes,
  bytesToHex,
  hexToBytes,
  randomBytes,
  transcriptIr,
  generateDeviceKey,
  signChallenge,
} from "@repo/crypto";
import {
  PairClaimResponse,
  type PairingServerMessage,
  type TunnelServerMessage,
} from "@repo/protocol";
import { createBroker, type Socket } from "./broker.js";
import {
  createMailboxStore,
  MAX_MAILBOXES_PER_SLOT,
  OFFER_TTL_MS,
} from "./mailbox.js";
import { createRateLimiter } from "./rate-limit.js";

/** A socket that records everything the broker sends it. */
function fakeSocket() {
  const sent: unknown[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  const socket: Socket = {
    send: (data) => sent.push(JSON.parse(data)),
    close: (code, reason) => {
      closed ??= { code, reason };
    },
  };
  return {
    socket,
    sent: sent as PairingServerMessage[],
    tunnelSent: sent as TunnelServerMessage[],
    get closed() {
      return closed;
    },
    last<T>() {
      return sent[sent.length - 1] as T;
    },
    /** Every message of a given type, narrowed to the caller's shape. */
    ofType<T>(type: string): T[] {
      return (sent as { type: string }[]).filter((m) => m.type === type) as T[];
    },
  };
}

const IP = "203.0.113.9";

/**
 * A broker whose store and clock the test drives directly.
 *
 * Slots are drawn at random, so reaching a chosen one through `pairNew` means
 * hundreds of calls and a flaky test. Placing mailboxes through the store says
 * exactly what the scenario is instead.
 */
function harness() {
  const clock = { t: Date.now() };
  const store = createMailboxStore();
  const broker = createBroker({ store, now: () => clock.t });
  return {
    broker,
    store,
    advance: (ms: number) => {
      clock.t += ms;
    },
    /** Park `count` mailboxes on one slot, each with its socket attached. */
    openSlot(slot: string, count: number) {
      const sockets: ReturnType<typeof fakeSocket>[] = [];
      for (let i = 0; i < count; i += 1) {
        const mailbox = store.createMailbox(slot, clock.t);
        expect(mailbox).not.toBeNull();
        const s = fakeSocket();
        broker.attachMailboxSocket(mailbox!.id, s.socket);
        sockets.push(s);
      }
      return sockets;
    },
  };
}

describe("POST /v1/pair/new", () => {
  it("opens a mailbox with a two-digit slot and a future expiry", () => {
    const broker = createBroker();
    const res = broker.pairNew(IP);
    expect(res.status).toBe(200);
    const body = res.body as {
      mailboxId: string;
      slot: string;
      expiresAt: number;
    };
    expect(body.slot).toMatch(/^\d{2}$/);
    expect(body.mailboxId.length).toBeGreaterThanOrEqual(8);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rate-limits mailbox creation per address", () => {
    const broker = createBroker({
      mailboxLimiter: createRateLimiter(3),
    });
    for (let i = 0; i < 3; i++) expect(broker.pairNew(IP).status).toBe(200);
    const limited = broker.pairNew(IP);
    expect(limited.status).toBe(429);
    expect(limited.headers?.["Retry-After"]).toBeDefined();
    // A different address is unaffected.
    expect(broker.pairNew("198.51.100.1").status).toBe(200);
  });
});

describe("POST /v1/pair/claim", () => {
  const claimBody = (slot: string) => ({
    slot,
    share: "a".repeat(64),
    ad: "cli",
    sid: "b".repeat(32),
  });

  it("rejects a malformed claim", () => {
    const broker = createBroker();
    expect(broker.pairClaim(IP, {}).status).toBe(400);
    expect(broker.pairClaim(IP, { slot: "492716" }).status).toBe(400);
    expect(broker.pairClaim(IP, undefined).status).toBe(400);
  });

  it("says nothing is waiting when no mailbox holds the slot", () => {
    const broker = createBroker();
    const res = broker.pairClaim(IP, claimBody("49"));
    expect(res.status).toBe(200);
    expect((res.body as { waiting: boolean }).waiting).toBe(false);
  });

  it("reports only whether anything waits, never how many", () => {
    // A live count on a slot is a free enumeration oracle for anyone who can
    // POST, so the response is deliberately a boolean.
    const h = harness();
    h.openSlot("49", MAX_MAILBOXES_PER_SLOT);
    const body = h.broker.pairClaim(IP, claimBody("49")).body as Record<
      string,
      unknown
    >;
    expect(body.waiting).toBe(true);
    // Two mailboxes answered, but the response says only "something is here".
    // `offered` survives clamped for clients that predate `waiting`; it must
    // never again report how many pairings are live on a slot.
    expect(body.offered).toBe(1);
  });

  it("keeps the compatibility field readable by an old client", () => {
    // mtmux <= 0.4.0 parses this response strictly and requires `offered`.
    // Dropping it would make `mtmux pair` throw on every existing install.
    const broker = createBroker();
    const empty = broker.pairClaim(IP, claimBody("49")).body;
    expect(PairClaimResponse.safeParse(empty).success).toBe(true);
    expect((empty as { offered: number }).offered).toBe(0);
  });

  it("fans a claim out to every live mailbox sharing the slot", () => {
    const h = harness();
    const sockets = h.openSlot("49", MAX_MAILBOXES_PER_SLOT);

    const res = h.broker.pairClaim(IP, claimBody("49"));
    expect((res.body as { waiting: boolean }).waiting).toBe(true);
    for (const s of sockets) {
      expect(s.ofType("pair:peer-share")).toHaveLength(1);
    }
  });

  it("caps live mailboxes on one slot", () => {
    // Uncapped, an attacker parks M mailboxes on a slot with M different
    // guessed secrets and every victim claim is tested against all of them at
    // once — M tries per pairing for the price of M POSTs.
    const h = harness();
    h.openSlot("49", MAX_MAILBOXES_PER_SLOT);
    expect(h.store.createMailbox("49")).toBeNull();

    // And the fan-out a claim can buy is bounded by that same cap.
    h.broker.pairClaim(IP, claimBody("49"));
    expect(h.store.liveMailboxesForSlot("49").length).toBeLessThanOrEqual(
      MAX_MAILBOXES_PER_SLOT,
    );
  });

  it("draws a fresh slot when the one it picked is full", () => {
    // A full slot is a collision, not a failure — pairing must not start
    // failing just because two people are pairing at once.
    const h = harness();
    for (let i = 0; i < 40; i += 1) {
      const res = h.broker.pairNew(`10.1.0.${i}`);
      expect(res.status).toBe(200);
    }
  });

  it("never offers the same mailbox twice once a claim has proved itself", () => {
    const h = harness();
    h.openSlot("49", 1);

    const first = h.broker.pairClaim(IP, claimBody("49")).body as {
      claimId: string;
      waiting: boolean;
    };
    expect(first.waiting).toBe(true);

    // The guess is spent when the claim attaches its socket, not when it POSTs.
    h.broker.attachClaimSocket(first.claimId, fakeSocket().socket);

    expect(
      (h.broker.pairClaim(IP, claimBody("49")).body as { waiting: boolean })
        .waiting,
    ).toBe(false);
  });

  it("does not burn a mailbox for a claim that never attaches a socket", () => {
    // One unauthenticated POST used to retire every pairing on a slot — no
    // crypto, no socket, no protocol participation. That is a service-wide
    // outage for the price of a curl.
    const h = harness();
    h.openSlot("49", 1);

    for (let i = 0; i < 5; i += 1) {
      h.broker.pairClaim(`10.2.0.${i}`, claimBody("49"));
      // Each bare POST holds the mailbox only until its offer lapses.
      h.advance(OFFER_TTL_MS + 1);
    }

    // Still claimable by the person the code was actually meant for.
    expect(
      (h.broker.pairClaim(IP, claimBody("49")).body as { waiting: boolean })
        .waiting,
    ).toBe(true);
  });

  it("holds a mailbox for the claim in flight, then releases it", () => {
    // Two claims must not each get a guess at one mailbox, so an offer is
    // exclusive while it lasts — but it must not last, or a bare POST could
    // take a code out of circulation for its whole three minutes.
    const h = harness();
    h.openSlot("49", 1);

    h.broker.pairClaim(IP, claimBody("49"));
    expect(
      (h.broker.pairClaim(IP, claimBody("49")).body as { waiting: boolean })
        .waiting,
    ).toBe(false);

    h.advance(OFFER_TTL_MS + 1);
    expect(
      (h.broker.pairClaim(IP, claimBody("49")).body as { waiting: boolean })
        .waiting,
    ).toBe(true);
  });

  it("caps claims against one slot regardless of source address", () => {
    // The per-IP limiter isolates a client; behind a CDN or a botnet it
    // isolates nobody. This is the budget that actually bounds guessing.
    const h = harness();
    const limit = 4;
    const broker = createBroker({
      store: h.store,
      slotClaimLimiter: createRateLimiter(limit),
    });
    for (let i = 0; i < limit; i += 1) {
      expect(broker.pairClaim(`10.3.0.${i}`, claimBody("49")).status).toBe(200);
    }
    const blocked = broker.pairClaim("10.3.0.99", claimBody("49"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers?.["Retry-After"]).toBeDefined();

    // A different code is unaffected.
    expect(broker.pairClaim("10.3.0.99", claimBody("50")).status).toBe(200);
  });

  it("charges a malformed claim to the slot it names", () => {
    // Otherwise the per-slot budget is dodged by sending rubbish.
    const broker = createBroker({ slotClaimLimiter: createRateLimiter(2) });
    expect(broker.pairClaim(IP, { slot: "49" }).status).toBe(400);
    expect(broker.pairClaim(IP, { slot: "49" }).status).toBe(400);
    expect(broker.pairClaim(IP, claimBody("49")).status).toBe(429);
  });

  it("caps claims against the whole broker", () => {
    const broker = createBroker({ globalClaimLimiter: createRateLimiter(3) });
    // Different slots and different addresses; the ceiling is neither.
    expect(broker.pairClaim("10.4.0.1", claimBody("11")).status).toBe(200);
    expect(broker.pairClaim("10.4.0.2", claimBody("22")).status).toBe(200);
    expect(broker.pairClaim("10.4.0.3", claimBody("33")).status).toBe(200);
    expect(broker.pairClaim("10.4.0.4", claimBody("44")).status).toBe(429);
  });

  it("rate-limits claims per address", () => {
    const broker = createBroker({ claimLimiter: createRateLimiter(2) });
    expect(broker.pairClaim(IP, claimBody("49")).status).toBe(200);
    expect(broker.pairClaim(IP, claimBody("49")).status).toBe(200);
    expect(broker.pairClaim(IP, claimBody("49")).status).toBe(429);
  });
});

describe("mailbox sockets", () => {
  it("refuses an unknown mailbox", () => {
    const broker = createBroker();
    const s = fakeSocket();
    expect(broker.attachMailboxSocket("mbx-doesnotexist", s.socket)).toBeNull();
    expect(s.last<{ type: string; reason: string }>().reason).toBe("expired");
    expect(s.closed).not.toBeNull();
  });

  it("refuses a second socket on one mailbox", () => {
    const broker = createBroker();
    const { mailboxId } = broker.pairNew(IP).body as { mailboxId: string };
    const first = fakeSocket();
    expect(broker.attachMailboxSocket(mailboxId, first.socket)).not.toBeNull();
    const second = fakeSocket();
    expect(broker.attachMailboxSocket(mailboxId, second.socket)).toBeNull();
    expect(second.closed?.reason).toMatch(/already attached/);
  });

  it("announces pair:ready with the slot", () => {
    const broker = createBroker();
    const { mailboxId, slot } = broker.pairNew(IP).body as {
      mailboxId: string;
      slot: string;
    };
    const s = fakeSocket();
    broker.attachMailboxSocket(mailboxId, s.socket);
    const ready = s.ofType<{ slot: string }>("pair:ready")[0];
    expect(ready?.slot).toBe(slot);
  });

  it("closes on a malformed message", () => {
    const broker = createBroker();
    const { mailboxId } = broker.pairNew(IP).body as { mailboxId: string };
    const s = fakeSocket();
    const handle = broker.attachMailboxSocket(mailboxId, s.socket)!;
    handle.message("{not json");
    expect(s.closed?.reason).toMatch(/Malformed/);
  });

  it("rejects a share quoting a peer handle it was never given", () => {
    const broker = createBroker();
    const { mailboxId } = broker.pairNew(IP).body as { mailboxId: string };
    const s = fakeSocket();
    const handle = broker.attachMailboxSocket(mailboxId, s.socket)!;
    handle.message(
      JSON.stringify({
        type: "pair:share",
        peer: "peer-forged",
        share: "a".repeat(64),
        ad: "",
      }),
    );
    expect(s.closed?.reason).toMatch(/Unknown peer/);
  });

  it("rejects pair:establish for a peer it was never given", () => {
    const broker = createBroker();
    const { mailboxId } = broker.pairNew(IP).body as { mailboxId: string };
    const s = fakeSocket();
    const handle = broker.attachMailboxSocket(mailboxId, s.socket)!;
    // A mailbox holder may end the exchange — but only with the peer that
    // actually claimed it.
    handle.message(
      JSON.stringify({
        type: "pair:establish",
        peer: "peer-x",
        sealedDescriptor: "AAEC",
      }),
    );
    expect(s.closed?.reason).toMatch(/Unknown peer/);
  });
});

/**
 * The real thing: two independent CPace runs across the broker, exactly as the
 * browser and CLI perform them. This is the test that would catch the broker
 * quietly seeing or mangling something it should not.
 */
describe("end-to-end pairing", () => {
  function pairThrough(browserSecret: string, cliSecret: string) {
    const broker = createBroker();
    const { mailboxId, slot } = broker.pairNew(IP).body as {
      mailboxId: string;
      slot: string;
    };

    const browserSocket = fakeSocket();
    const browser = broker.attachMailboxSocket(
      mailboxId,
      browserSocket.socket,
    )!;

    // --- CLI side: user typed slot + its guess at the secret.
    const sid = randomBytes(16);
    const ci = utf8ToBytes(slot);
    const cliCpace = cpaceStart(utf8ToBytes(cliSecret), ci, sid);
    const cliAd = "cli";

    const claim = broker.pairClaim(IP, {
      slot,
      share: bytesToHex(cliCpace.share),
      ad: cliAd,
      sid: bytesToHex(sid),
    }).body as { claimId: string; waiting: boolean };

    const cliSocket = fakeSocket();
    const cli = broker.attachClaimSocket(claim.claimId, cliSocket.socket)!;

    // --- Browser reacts to the claim.
    const peerShare = browserSocket.ofType<{
      peer: string;
      share: string;
      ad: string;
      sid: string;
    }>("pair:peer-share")[0]!;

    const browserCpace = cpaceStart(
      utf8ToBytes(browserSecret),
      ci,
      hexToBytes(peerShare.sid),
    );
    const browserAd = "browser";
    const browserIsk = browserCpace.finish(hexToBytes(peerShare.share), {
      own: utf8ToBytes(browserAd),
      peer: utf8ToBytes(peerShare.ad),
      isInitiator: false,
    });
    const browserKeys = deriveSessionKeys(
      browserIsk,
      transcriptIr(
        hexToBytes(peerShare.share),
        utf8ToBytes(peerShare.ad),
        browserCpace.share,
        utf8ToBytes(browserAd),
      ),
    );

    browser.message(
      JSON.stringify({
        type: "pair:share",
        peer: peerShare.peer,
        share: bytesToHex(browserCpace.share),
        ad: browserAd,
      }),
    );
    browser.message(
      JSON.stringify({
        type: "pair:confirm",
        peer: peerShare.peer,
        tag: bytesToHex(confirmationTag(browserKeys.confirm, "browser")),
      }),
    );

    // --- CLI completes its own CPace against what came back.
    const fromBrowser = cliSocket.ofType<{
      peer: string;
      share: string;
      ad: string;
    }>("pair:peer-share")[0]!;
    const cliIsk = cliCpace.finish(hexToBytes(fromBrowser.share), {
      own: utf8ToBytes(cliAd),
      peer: utf8ToBytes(fromBrowser.ad),
      isInitiator: true,
    });
    const cliKeys = deriveSessionKeys(
      cliIsk,
      transcriptIr(
        cliCpace.share,
        utf8ToBytes(cliAd),
        hexToBytes(fromBrowser.share),
        utf8ToBytes(fromBrowser.ad),
      ),
    );

    const browserTag = cliSocket.ofType<{ tag: string }>(
      "pair:peer-confirm",
    )[0];
    const cliAcceptsBrowser =
      browserTag !== undefined &&
      verifyConfirmation(
        cliKeys.confirm,
        "browser",
        hexToBytes(browserTag.tag),
      );

    return {
      broker,
      browser,
      cli,
      browserSocket,
      cliSocket,
      peer: fromBrowser.peer,
      browserKeys,
      cliKeys,
      cliAcceptsBrowser,
    };
  }

  it("agrees on a key and delivers the sealed descriptor when the code matches", () => {
    const secret = generateSecret();
    const run = pairThrough(secret, secret);

    expect(run.cliAcceptsBrowser).toBe(true);
    expect(bytesToHex(run.cliKeys.c2s)).toBe(bytesToHex(run.browserKeys.c2s));
    expect(bytesToHex(run.cliKeys.s2c)).toBe(bytesToHex(run.browserKeys.s2c));
    expect(run.cliKeys.directToken).toBe(run.browserKeys.directToken);

    // CLI confirms back, then hands over the sealed descriptor.
    run.cli.message(
      JSON.stringify({
        type: "pair:confirm",
        peer: run.peer,
        tag: bytesToHex(confirmationTag(run.cliKeys.confirm, "cli")),
      }),
    );
    const cliTag = run.browserSocket.ofType<{ tag: string }>(
      "pair:peer-confirm",
    )[0]!;
    expect(
      verifyConfirmation(
        run.browserKeys.confirm,
        "cli",
        hexToBytes(cliTag.tag),
      ),
    ).toBe(true);

    run.cli.message(
      JSON.stringify({
        type: "pair:establish",
        peer: run.peer,
        sealedDescriptor: "c2VhbGVk",
      }),
    );
    const established = run.browserSocket.ofType<{ sealedDescriptor: string }>(
      "pair:established",
    )[0];
    expect(established?.sealedDescriptor).toBe("c2VhbGVk");
  });

  it("derives mismatched keys when the typed secret is wrong", () => {
    const run = pairThrough("2716", "2717");
    expect(run.cliAcceptsBrowser).toBe(false);
    expect(bytesToHex(run.cliKeys.c2s)).not.toBe(
      bytesToHex(run.browserKeys.c2s),
    );
  });

  it("burns the mailbox on a failed confirmation — one guess per code", () => {
    const run = pairThrough("2716", "2717");
    expect(run.cliAcceptsBrowser).toBe(false);

    run.cli.message(
      JSON.stringify({
        type: "pair:close",
        peer: run.peer,
        reason: "confirmation failed",
      }),
    );

    const failed = run.browserSocket.ofType<{ reason: string }>(
      "pair:failed",
    )[0];
    expect(failed?.reason).toBe("confirmation-failed");
    // And the mailbox is gone, so a second attempt on the same code finds
    // nothing to claim.
    expect(run.broker.stats().mailboxes).toBe(0);
  });

  it("never exposes the secret or the derived keys to the broker", () => {
    const secret = "2716";
    const run = pairThrough(secret, secret);
    const everything = JSON.stringify([
      ...(run.browserSocket.sent as unknown[]),
      ...(run.cliSocket.sent as unknown[]),
    ]);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(bytesToHex(run.cliKeys.c2s));
    expect(everything).not.toContain(bytesToHex(run.cliKeys.s2c));
    expect(everything).not.toContain(run.cliKeys.directToken);
  });
});

describe("agent tunnel", () => {
  it("issues a challenge and accepts a correctly signed registration", () => {
    const broker = createBroker();
    const s = fakeSocket();
    const handle = broker.attachAgentSocket(s.socket);

    const challenge = s.ofType<{ challenge: string }>("tunnel:challenge")[0]!;
    const key = generateDeviceKey();
    handle.message(
      JSON.stringify({
        type: "tunnel:register",
        deviceId: key.deviceId,
        publicKey: bytesToHex(key.publicKey),
        challenge: challenge.challenge,
        signature: bytesToHex(
          signChallenge(key.secretKey, hexToBytes(challenge.challenge)),
        ),
      }),
    );

    expect(s.ofType("tunnel:ready")).toHaveLength(1);
    expect(s.closed).toBeNull();
  });

  it("rejects a signature over a challenge it did not issue", () => {
    const broker = createBroker();
    const s = fakeSocket();
    const handle = broker.attachAgentSocket(s.socket);
    const key = generateDeviceKey();
    const forged = randomBytes(32);

    handle.message(
      JSON.stringify({
        type: "tunnel:register",
        deviceId: key.deviceId,
        publicKey: bytesToHex(key.publicKey),
        challenge: bytesToHex(forged),
        signature: bytesToHex(signChallenge(key.secretKey, forged)),
      }),
    );
    expect(s.closed?.reason).toMatch(/Registration failed/);
  });

  it("rejects a device id that is not the key's fingerprint", () => {
    const broker = createBroker();
    const s = fakeSocket();
    const handle = broker.attachAgentSocket(s.socket);
    const challenge = s.ofType<{ challenge: string }>("tunnel:challenge")[0]!;
    const key = generateDeviceKey();
    const victim = generateDeviceKey();

    handle.message(
      JSON.stringify({
        type: "tunnel:register",
        deviceId: victim.deviceId, // claiming someone else's identity
        publicKey: bytesToHex(key.publicKey),
        challenge: challenge.challenge,
        signature: bytesToHex(
          signChallenge(key.secretKey, hexToBytes(challenge.challenge)),
        ),
      }),
    );
    expect(s.closed?.reason).toMatch(/Registration failed/);
  });

  it("requires registration before anything else", () => {
    const broker = createBroker();
    const s = fakeSocket();
    const handle = broker.attachAgentSocket(s.socket);
    handle.message(
      JSON.stringify({ type: "stream:frame", streamId: "s1", data: "AA" }),
    );
    expect(s.closed?.reason).toMatch(/Must register first/);
  });
});

describe("tunnel data path", () => {
  function registeredTunnel(broker: ReturnType<typeof createBroker>) {
    const agentSocket = fakeSocket();
    const agent = broker.attachAgentSocket(agentSocket.socket);
    const challenge = agentSocket.ofType<{ challenge: string }>(
      "tunnel:challenge",
    )[0]!;
    const key = generateDeviceKey();
    agent.message(
      JSON.stringify({
        type: "tunnel:register",
        deviceId: key.deviceId,
        publicKey: bytesToHex(key.publicKey),
        challenge: challenge.challenge,
        signature: bytesToHex(
          signChallenge(key.secretKey, hexToBytes(challenge.challenge)),
        ),
      }),
    );
    const ready = agentSocket.ofType<{ tunnelId: string }>("tunnel:ready")[0]!;
    return { agent, agentSocket, tunnelId: ready.tunnelId };
  }

  /**
   * `/v1/tunnel/:id` is unauthenticated by design, and an opened stream makes
   * the *agent* dial a fresh loopback socket before any frame arrives. Without
   * a cap, anyone who learned a tunnel id could exhaust file descriptors on
   * someone else's machine — and tunnel ids are now stable across reconnects,
   * so a leaked one keeps working.
   */
  it("refuses streams past the per-tunnel cap", () => {
    const broker = createBroker({
      quotas: { maxBytes: 1024 ** 3, maxMinutes: 720, maxStreams: 2 },
    });
    const { tunnelId } = registeredTunnel(broker);

    const accepted = [0, 1].map(() => {
      const s = fakeSocket();
      const handle = broker.attachTunnelSocket(tunnelId, s.socket);
      return { s, handle };
    });
    for (const { s, handle } of accepted) {
      expect(handle).not.toBeNull();
      expect(s.ofType("stream:open")).toHaveLength(1);
    }

    const third = fakeSocket();
    expect(broker.attachTunnelSocket(tunnelId, third.socket)).toBeNull();
    expect(third.closed?.reason).toMatch(/Too many streams/);
    expect(third.ofType("stream:open")).toHaveLength(0);
  });

  it("frees capacity when a stream closes", () => {
    const broker = createBroker({
      quotas: { maxBytes: 1024 ** 3, maxMinutes: 720, maxStreams: 1 },
    });
    const { tunnelId } = registeredTunnel(broker);

    const first = fakeSocket();
    const handle = broker.attachTunnelSocket(tunnelId, first.socket)!;
    expect(broker.attachTunnelSocket(tunnelId, fakeSocket().socket)).toBeNull();

    handle.close();

    const later = fakeSocket();
    expect(broker.attachTunnelSocket(tunnelId, later.socket)).not.toBeNull();
    expect(later.ofType("stream:open")).toHaveLength(1);
  });

  describe("metering", () => {
    /** A metering seam whose promises resolve on demand, so order is testable. */
    function meter(
      owner: { userId: string } | null,
      decision: { allowed: boolean; reason?: string } = { allowed: true },
    ) {
      const recorded: { userId: string; bytes: number; seconds: number }[] = [];
      return {
        recorded,
        metering: {
          ownerOfDevice: async () => owner,
          checkTunnel: async () => decision,
          recordUsage: async (
            userId: string,
            bytes: number,
            seconds: number,
          ) => {
            recorded.push({ userId, bytes, seconds });
          },
        },
      };
    }

    // The tunnel must be usable the instant it registers. Resolving an owner
    // is a database read, and making a reconnect wait on it would let an
    // accounts outage delay every CLI on the platform.
    it("does not delay tunnel:ready on the owner lookup", () => {
      const { metering } = meter({ userId: "u1" });
      const broker = createBroker({ metering });
      const { agentSocket } = registeredTunnel(broker);
      expect(agentSocket.ofType("tunnel:ready")).toHaveLength(1);
    });

    it("closes a tunnel whose account is over its plan", async () => {
      const { metering } = meter(
        { userId: "u1" },
        { allowed: false, reason: "Out of transfer" },
      );
      const broker = createBroker({ metering });
      const { agentSocket, tunnelId } = registeredTunnel(broker);

      await vi.waitFor(() =>
        expect(agentSocket.ofType("tunnel:closed")).toHaveLength(1),
      );
      // And the id stops resolving, so no browser can open a stream on it.
      expect(
        broker.attachTunnelSocket(tunnelId, fakeSocket().socket),
      ).toBeNull();
    });

    // Anonymous use is the product, not a loophole: a machine nobody has
    // registered has no plan to be over.
    it("leaves an unregistered machine unmetered", async () => {
      const { metering, recorded } = meter(null, { allowed: false });
      const broker = createBroker({ metering });
      const { agent, agentSocket, tunnelId } = registeredTunnel(broker);

      await Promise.resolve();
      expect(agentSocket.ofType("tunnel:closed")).toHaveLength(0);
      expect(
        broker.attachTunnelSocket(tunnelId, fakeSocket().socket),
      ).not.toBeNull();

      agent.close();
      expect(recorded).toHaveLength(0);
    });

    it("folds a finished tunnel's bytes into the owner's usage", async () => {
      const { metering, recorded } = meter({ userId: "u1" });
      const broker = createBroker({ metering });
      const { agent, agentSocket, tunnelId } = registeredTunnel(broker);
      await vi.waitFor(() =>
        expect(agentSocket.ofType("tunnel:ready")).toHaveLength(1),
      );

      const browserSocket = fakeSocket();
      const browser = broker.attachTunnelSocket(
        tunnelId,
        browserSocket.socket,
      )!;
      const open = browserSocket.ofType<{ streamId: string }>(
        "stream:open",
      )[0]!;
      browser.message(
        JSON.stringify({
          type: "stream:frame",
          streamId: open.streamId,
          data: "AAAAAAAA",
        }),
      );

      agent.close();
      await vi.waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]!.userId).toBe("u1");
      expect(recorded[0]!.bytes).toBeGreaterThan(0);
    });

    // Metering is accounting. Failing it closed would take paying customers
    // offline over a database blip.
    it("keeps the tunnel up when metering throws", async () => {
      const broker = createBroker({
        metering: {
          ownerOfDevice: async () => {
            throw new Error("database gone");
          },
          checkTunnel: async () => ({ allowed: true }),
          recordUsage: async () => {},
        },
      });
      const { agentSocket, tunnelId } = registeredTunnel(broker);
      await Promise.resolve();
      expect(agentSocket.ofType("tunnel:closed")).toHaveLength(0);
      expect(
        broker.attachTunnelSocket(tunnelId, fakeSocket().socket),
      ).not.toBeNull();
    });
  });

  it("copies sealed frames in both directions verbatim", () => {
    const broker = createBroker();
    const { agent, agentSocket, tunnelId } = registeredTunnel(broker);

    const browserSocket = fakeSocket();
    const browser = broker.attachTunnelSocket(tunnelId, browserSocket.socket)!;
    const open = browserSocket.ofType<{ streamId: string }>("stream:open")[0]!;
    expect(agentSocket.ofType("stream:open")).toHaveLength(1);

    browser.message(
      JSON.stringify({
        type: "stream:frame",
        streamId: open.streamId,
        data: "dXAtZnJhbWU",
      }),
    );
    const up = agentSocket.ofType<{ data: string }>("stream:frame")[0];
    expect(up?.data).toBe("dXAtZnJhbWU");

    agent.message(
      JSON.stringify({
        type: "stream:frame",
        streamId: open.streamId,
        data: "ZG93bi1mcmFtZQ",
      }),
    );
    const down = browserSocket.ofType<{ data: string }>("stream:frame")[0];
    expect(down?.data).toBe("ZG93bi1mcmFtZQ");
  });

  it("refuses a browser socket for an unknown tunnel", () => {
    const broker = createBroker();
    const s = fakeSocket();
    expect(broker.attachTunnelSocket("tnl-nope-nope", s.socket)).toBeNull();
    expect(s.closed).not.toBeNull();
  });

  it("refuses a frame quoting another stream's id", () => {
    const broker = createBroker();
    const { tunnelId } = registeredTunnel(broker);
    const s = fakeSocket();
    const browser = broker.attachTunnelSocket(tunnelId, s.socket)!;
    browser.message(
      JSON.stringify({
        type: "stream:frame",
        streamId: "str-someone-else",
        data: "AA",
      }),
    );
    expect(s.closed?.reason).toMatch(/Unknown stream/);
  });

  it("closes the tunnel once the byte quota is exceeded", () => {
    const broker = createBroker({ quotas: { maxBytes: 16, maxMinutes: 60 } });
    const { tunnelId } = registeredTunnel(broker);
    const s = fakeSocket();
    const browser = broker.attachTunnelSocket(tunnelId, s.socket)!;
    const open = s.ofType<{ streamId: string }>("stream:open")[0]!;

    browser.message(
      JSON.stringify({
        type: "stream:frame",
        streamId: open.streamId,
        data: "A".repeat(32),
      }),
    );
    expect(s.closed?.reason).toMatch(/Quota exceeded/);
  });

  it("tears the browser stream down when the agent disconnects", () => {
    const broker = createBroker();
    const { agent, tunnelId } = registeredTunnel(broker);
    const s = fakeSocket();
    broker.attachTunnelSocket(tunnelId, s.socket);

    agent.close();
    const closed = s.ofType<{ reason: string }>("tunnel:closed")[0];
    expect(closed?.reason).toBe("agent-gone");
    expect(broker.stats().tunnels).toBe(0);
  });
});

describe("broker logging discipline", () => {
  let broker: ReturnType<typeof createBroker>;
  beforeEach(() => {
    broker = createBroker();
  });

  it("reports liveness from health, never how much is in flight", () => {
    // Live mailbox and tunnel counts told anyone who could curl the broker how
    // many pairings were happening — the same enumeration `offered` leaked,
    // without even needing a claim.
    broker.pairNew(IP);
    const body = broker.health().body as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body).not.toHaveProperty("mailboxes");
    expect(body).not.toHaveProperty("claims");
    expect(body).not.toHaveProperty("tunnels");
    expect(JSON.stringify(body)).not.toContain(IP);

    // Still available in-process, for diagnostics and these tests.
    expect(broker.stats().mailboxes).toBe(1);
  });

  it("rate-limits discover", () => {
    const limited = createBroker({ discoverLimiter: createRateLimiter(2) });
    expect(limited.discover(IP).status).toBe(200);
    expect(limited.discover(IP).status).toBe(200);
    expect(limited.discover(IP).status).toBe(429);
    expect(limited.discover("198.51.100.7").status).toBe(200);
  });

  it("rate-limits socket upgrades", () => {
    // Every HTTP door is budgeted; the upgrade path had no limit at all, which
    // made the rest of them bypassable for anything reachable over WS.
    const limited = createBroker({ upgradeLimiter: createRateLimiter(2) });
    expect(limited.allowUpgrade(IP)).toBe(true);
    expect(limited.allowUpgrade(IP)).toBe(true);
    expect(limited.allowUpgrade(IP)).toBe(false);
    expect(limited.allowUpgrade("198.51.100.7")).toBe(true);
  });

  it("echoes the caller's address from discover without storing it", () => {
    expect((broker.discover(IP).body as { ip: string }).ip).toBe(IP);
    expect(JSON.stringify(broker.health().body)).not.toContain(IP);
  });
});

/**
 * The same protocol with the roles swapped: the CLI parks the mailbox and the
 * browser claims it, which is what `mtmux start` printing a code and a QR
 * needs. The broker must not be able to tell the difference — if it can, that
 * is a fact about the user it had no business knowing.
 */
describe("end-to-end pairing, CLI-hosted", () => {
  function pairThrough(cliSecret: string, browserSecret: string) {
    const broker = createBroker();
    const { mailboxId, slot } = broker.pairNew(IP).body as {
      mailboxId: string;
      slot: string;
    };
    const ci = utf8ToBytes(slot);

    const cliSocket = fakeSocket();
    const cli = broker.attachMailboxSocket(mailboxId, cliSocket.socket)!;

    // --- Browser claims the code. It is the initiator and picks the sid.
    const sid = randomBytes(16);
    const browserAd = "browser";
    const browserCpace = cpaceStart(utf8ToBytes(browserSecret), ci, sid);
    const claim = broker.pairClaim(IP, {
      slot,
      share: bytesToHex(browserCpace.share),
      ad: browserAd,
      sid: bytesToHex(sid),
    }).body as { claimId: string; waiting: boolean };

    const browserSocket = fakeSocket();
    const browser = broker.attachClaimSocket(
      claim.claimId,
      browserSocket.socket,
    )!;

    // --- CLI answers with its share and its tag, in that order.
    const fromBrowser = cliSocket.ofType<{
      peer: string;
      share: string;
      ad: string;
      sid: string;
    }>("pair:peer-share")[0]!;

    const cliAd = "cli";
    const cliCpace = cpaceStart(
      utf8ToBytes(cliSecret),
      ci,
      hexToBytes(fromBrowser.sid),
    );
    const cliIsk = cliCpace.finish(hexToBytes(fromBrowser.share), {
      own: utf8ToBytes(cliAd),
      peer: utf8ToBytes(fromBrowser.ad),
      isInitiator: false,
    });
    const cliKeys = deriveSessionKeys(
      cliIsk,
      transcriptIr(
        hexToBytes(fromBrowser.share),
        utf8ToBytes(fromBrowser.ad),
        cliCpace.share,
        utf8ToBytes(cliAd),
      ),
    );

    cli.message(
      JSON.stringify({
        type: "pair:share",
        peer: fromBrowser.peer,
        share: bytesToHex(cliCpace.share),
        ad: cliAd,
      }),
    );
    cli.message(
      JSON.stringify({
        type: "pair:confirm",
        peer: fromBrowser.peer,
        tag: bytesToHex(confirmationTag(cliKeys.confirm, "cli")),
      }),
    );

    // --- Browser completes its own CPace against what came back.
    const fromCli = browserSocket.ofType<{
      peer: string;
      share: string;
      ad: string;
    }>("pair:peer-share")[0]!;
    const browserIsk = browserCpace.finish(hexToBytes(fromCli.share), {
      own: utf8ToBytes(browserAd),
      peer: utf8ToBytes(fromCli.ad),
      isInitiator: true,
    });
    const browserKeys = deriveSessionKeys(
      browserIsk,
      transcriptIr(
        browserCpace.share,
        utf8ToBytes(browserAd),
        hexToBytes(fromCli.share),
        utf8ToBytes(fromCli.ad),
      ),
    );

    const cliTag = browserSocket.ofType<{ tag: string }>(
      "pair:peer-confirm",
    )[0];
    const browserAcceptsCli =
      cliTag !== undefined &&
      verifyConfirmation(browserKeys.confirm, "cli", hexToBytes(cliTag.tag));

    return {
      broker,
      cli,
      browser,
      cliSocket,
      browserSocket,
      peer: fromCli.peer,
      cliKeys,
      browserKeys,
      browserAcceptsCli,
    };
  }

  it("agrees on a key and delivers the sealed descriptor when the code matches", () => {
    const secret = generateSecret();
    const run = pairThrough(secret, secret);

    expect(run.browserAcceptsCli).toBe(true);
    expect(bytesToHex(run.cliKeys.c2s)).toBe(bytesToHex(run.browserKeys.c2s));
    expect(bytesToHex(run.cliKeys.s2c)).toBe(bytesToHex(run.browserKeys.s2c));
    expect(run.cliKeys.directToken).toBe(run.browserKeys.directToken);

    // Browser confirms back, and the CLI — on the mailbox socket this time —
    // ends the exchange with the descriptor.
    run.browser.message(
      JSON.stringify({
        type: "pair:confirm",
        peer: run.peer,
        tag: bytesToHex(confirmationTag(run.browserKeys.confirm, "browser")),
      }),
    );
    const browserTag = run.cliSocket.ofType<{ tag: string }>(
      "pair:peer-confirm",
    )[0]!;
    expect(
      verifyConfirmation(
        run.cliKeys.confirm,
        "browser",
        hexToBytes(browserTag.tag),
      ),
    ).toBe(true);

    run.cli.message(
      JSON.stringify({
        type: "pair:establish",
        peer: run.peer,
        sealedDescriptor: "c2VhbGVk",
      }),
    );
    const established = run.browserSocket.ofType<{ sealedDescriptor: string }>(
      "pair:established",
    )[0];
    expect(established?.sealedDescriptor).toBe("c2VhbGVk");
    // The mailbox is spent, so the code cannot be claimed a second time.
    expect(run.broker.stats().mailboxes).toBe(0);
  });

  it("derives mismatched keys when the browser guessed wrong", () => {
    const run = pairThrough("2716", "2717");
    expect(run.browserAcceptsCli).toBe(false);
    expect(bytesToHex(run.cliKeys.c2s)).not.toBe(
      bytesToHex(run.browserKeys.c2s),
    );
  });

  it("burns the mailbox on a failed confirmation — one guess per code", () => {
    const run = pairThrough("2716", "2717");
    expect(run.browserAcceptsCli).toBe(false);

    run.browser.message(
      JSON.stringify({
        type: "pair:close",
        peer: run.peer,
        reason: "confirmation failed",
      }),
    );

    const failed = run.cliSocket.ofType<{ reason: string }>("pair:failed")[0];
    expect(failed?.reason).toBe("confirmation-failed");
    expect(run.broker.stats().mailboxes).toBe(0);
  });

  it("tells the claimant a peer-scoped close was a failed confirmation", () => {
    const run = pairThrough("2716", "2717");
    run.cli.message(
      JSON.stringify({
        type: "pair:close",
        peer: run.peer,
        reason: "confirmation failed",
      }),
    );
    const failed = run.browserSocket.ofType<{ reason: string }>(
      "pair:failed",
    )[0];
    expect(failed?.reason).toBe("confirmation-failed");
    expect(run.broker.stats().mailboxes).toBe(0);
  });

  it("never exposes the secret or the derived keys to the broker", () => {
    const secret = "2716";
    const run = pairThrough(secret, secret);
    const everything = JSON.stringify([
      ...(run.cliSocket.sent as unknown[]),
      ...(run.browserSocket.sent as unknown[]),
    ]);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(bytesToHex(run.cliKeys.c2s));
    expect(everything).not.toContain(bytesToHex(run.cliKeys.s2c));
    expect(everything).not.toContain(run.cliKeys.directToken);
  });

  it("routes a second pair:share from the claimant back to the mailbox", () => {
    const broker = createBroker();
    const { mailboxId, slot } = broker.pairNew(IP).body as {
      mailboxId: string;
      slot: string;
    };
    const mailboxSocket = fakeSocket();
    broker.attachMailboxSocket(mailboxId, mailboxSocket.socket);

    const claim = broker.pairClaim(IP, {
      slot,
      share: "a".repeat(64),
      ad: "browser",
      sid: "b".repeat(32),
    }).body as { claimId: string };
    const claimSocket = fakeSocket();
    const claimHandle = broker.attachClaimSocket(
      claim.claimId,
      claimSocket.socket,
    )!;
    const peer = mailboxSocket.ofType<{ peer: string }>("pair:peer-share")[0]!
      .peer;

    claimHandle.message(
      JSON.stringify({
        type: "pair:share",
        peer,
        share: "c".repeat(64),
        ad: "browser",
      }),
    );

    const shares = mailboxSocket.ofType<{ share: string; sid: string }>(
      "pair:peer-share",
    );
    expect(shares).toHaveLength(2);
    expect(shares[1]?.share).toBe("c".repeat(64));
    // Always the claimant's own sid, never one the broker invented.
    expect(shares[1]?.sid).toBe("b".repeat(32));
    expect(claimSocket.closed).toBeNull();
  });
});

describe("housekeeping", () => {
  it("sweeps claim payloads whose claim expired before a socket attached", () => {
    let clock = 1_000_000;
    const broker = createBroker({ now: () => clock });
    broker.pairClaim(IP, {
      slot: "49",
      share: "a".repeat(64),
      ad: "browser",
      sid: "b".repeat(32),
    });
    expect(broker.stats().claimPayloads).toBe(1);

    // Nothing ever connects. Past the mailbox TTL the claim is unreachable, so
    // its payload must not sit in memory for the life of the process.
    broker.sweep();
    expect(broker.stats().claimPayloads).toBe(1);
    clock += 4 * 60 * 1000;
    broker.sweep();
    expect(broker.stats().claimPayloads).toBe(0);
  });

  it("drops a claim payload as soon as its socket closes", () => {
    const broker = createBroker();
    const claim = broker.pairClaim(IP, {
      slot: "49",
      share: "a".repeat(64),
      ad: "browser",
      sid: "b".repeat(32),
    }).body as { claimId: string };
    const s = fakeSocket();
    const handle = broker.attachClaimSocket(claim.claimId, s.socket)!;
    expect(broker.stats().claimPayloads).toBe(1);
    handle.close();
    expect(broker.stats().claimPayloads).toBe(0);
  });
});

describe("tunnel identity", () => {
  function register(
    broker: ReturnType<typeof createBroker>,
    key: ReturnType<typeof generateDeviceKey>,
  ) {
    const s = fakeSocket();
    const handle = broker.attachAgentSocket(s.socket);
    const challenge = s.ofType<{ challenge: string }>("tunnel:challenge")[0]!;
    handle.message(
      JSON.stringify({
        type: "tunnel:register",
        deviceId: key.deviceId,
        publicKey: bytesToHex(key.publicKey),
        challenge: challenge.challenge,
        signature: bytesToHex(
          signChallenge(key.secretKey, hexToBytes(challenge.challenge)),
        ),
      }),
    );
    return {
      handle,
      socket: s,
      tunnelId: s.ofType<{ tunnelId: string }>("tunnel:ready")[0]!.tunnelId,
    };
  }

  it("hands the same tunnel id back when an agent reconnects", () => {
    const broker = createBroker();
    const key = generateDeviceKey();

    const first = register(broker, key);
    first.handle.close();
    const second = register(broker, key);

    // The browser sealed the old id into its descriptor and has no channel to
    // be told a new one, so a fresh id would strand every paired session.
    expect(second.tunnelId).toBe(first.tunnelId);
    expect(broker.stats().tunnels).toBe(1);
  });

  it("keeps the id across a reconnect that replaces a live socket", () => {
    const broker = createBroker();
    const key = generateDeviceKey();
    const first = register(broker, key);
    const second = register(broker, key);
    expect(second.tunnelId).toBe(first.tunnelId);
    expect(first.socket.ofType("tunnel:closed")).toHaveLength(1);
    expect(broker.stats().tunnels).toBe(1);
  });

  it("gives different devices different ids", () => {
    const broker = createBroker();
    const a = register(broker, generateDeviceKey());
    const b = register(broker, generateDeviceKey());
    expect(a.tunnelId).not.toBe(b.tunnelId);
  });

  it("still resolves the sealed tunnel id after the agent reconnects", () => {
    const broker = createBroker();
    const key = generateDeviceKey();
    const first = register(broker, key);
    first.handle.close();
    register(broker, key);

    const browser = fakeSocket();
    expect(
      broker.attachTunnelSocket(first.tunnelId, browser.socket),
    ).not.toBeNull();
  });
});

/**
 * Requested pairing: the dashboard asking a machine to let it in.
 *
 * The broker's job here is narrow — forward opaque blobs between an
 * account-authenticated browser and a device-authenticated machine, and never
 * be in a position to answer for either. These pin the parts of that which are
 * the broker's responsibility rather than the crypto's.
 */
describe("POST /v1/pair/request", () => {
  /** A registered agent, and the socket the broker talks to it on. */
  function machine(broker: ReturnType<typeof createBroker>) {
    const s = fakeSocket();
    const handle = broker.attachAgentSocket(s.socket);
    const challenge = s.ofType<{ challenge: string }>("tunnel:challenge")[0]!;
    const key = generateDeviceKey();
    handle.message(
      JSON.stringify({
        type: "tunnel:register",
        deviceId: key.deviceId,
        publicKey: bytesToHex(key.publicKey),
        challenge: challenge.challenge,
        signature: bytesToHex(
          signChallenge(key.secretKey, hexToBytes(challenge.challenge)),
        ),
      }),
    );
    return { socket: s, handle, key };
  }

  const ask = (broker: ReturnType<typeof createBroker>, deviceId: string) =>
    broker.pairRequest(deviceId, {
      deviceLabel: "iPhone · Safari",
      accountEmail: "someone@example.com",
    });

  const COMMITMENT = "a".repeat(64);

  it("refuses when the machine is not online", () => {
    const broker = createBroker();
    expect(ask(broker, "0".repeat(16)).status).toBe(409);
  });

  it("tells the machine nothing until the browser has committed", () => {
    // The commitment covers the request id, so it cannot ride the POST. The
    // machine must not be prompted before there is a commitment to bind it.
    const broker = createBroker();
    const m = machine(broker);
    const { requestId } = ask(broker, m.key.deviceId).body as {
      requestId: string;
    };
    expect(m.socket.ofType("pair:request")).toHaveLength(0);

    const browser = fakeSocket();
    const handle = broker.attachRequestSocket(requestId, browser.socket)!;
    handle.message(
      JSON.stringify({
        type: "pair:commit",
        requestId,
        commitment: COMMITMENT,
      }),
    );

    const forwarded = m.socket.ofType<{ commitment: string }>("pair:request");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.commitment).toBe(COMMITMENT);
  });

  it("forwards a commitment only once", () => {
    // A second commitment would be a second chance to choose a key after
    // seeing the machine's, which is exactly what committing exists to stop.
    const broker = createBroker();
    const m = machine(broker);
    const { requestId } = ask(broker, m.key.deviceId).body as {
      requestId: string;
    };
    const browser = fakeSocket();
    const handle = broker.attachRequestSocket(requestId, browser.socket)!;
    const commit = JSON.stringify({
      type: "pair:commit",
      requestId,
      commitment: COMMITMENT,
    });
    handle.message(commit);
    handle.message(
      JSON.stringify({ ...JSON.parse(commit), commitment: "b".repeat(64) }),
    );

    expect(m.socket.ofType("pair:request")).toHaveLength(1);
  });

  it("allows one undecided request per machine", () => {
    // Otherwise a compromised session buries a real prompt under a hundred
    // others, and approval fatigue does the attacker's work.
    const broker = createBroker();
    const m = machine(broker);
    expect(ask(broker, m.key.deviceId).status).toBe(200);
    expect(ask(broker, m.key.deviceId).status).toBe(409);
  });

  it("lets a refusal be asked again, but not retried", () => {
    const broker = createBroker();
    const m = machine(broker);
    const { requestId } = ask(broker, m.key.deviceId).body as {
      requestId: string;
    };
    const browser = fakeSocket();
    broker.attachRequestSocket(requestId, browser.socket);

    m.handle.message(
      JSON.stringify({ type: "pair:denied", requestId, reason: "refused" }),
    );
    expect(browser.ofType("pair:denied")).toHaveLength(1);

    // The denial burned it: the same request cannot be answered twice.
    m.handle.message(
      JSON.stringify({
        type: "pair:approved",
        requestId,
        sealedDescriptor: "AQID",
      }),
    );
    expect(browser.ofType("pair:approved")).toHaveLength(0);

    // But the machine is free for a fresh request.
    expect(ask(broker, m.key.deviceId).status).toBe(200);
  });

  it("refuses to let one machine answer another's request", () => {
    const broker = createBroker();
    const target = machine(broker);
    const other = machine(broker);
    const { requestId } = ask(broker, target.key.deviceId).body as {
      requestId: string;
    };
    const browser = fakeSocket();
    broker.attachRequestSocket(requestId, browser.socket);

    other.handle.message(
      JSON.stringify({
        type: "pair:approved",
        requestId,
        sealedDescriptor: "AQID",
      }),
    );
    expect(browser.ofType("pair:approved")).toHaveLength(0);
  });

  it("buffers the machine's reply until the browser's socket attaches", () => {
    const broker = createBroker();
    const m = machine(broker);
    const { requestId } = ask(broker, m.key.deviceId).body as {
      requestId: string;
    };

    m.handle.message(
      JSON.stringify({
        type: "pair:request-ack",
        requestId,
        cliPublicKey: "c".repeat(64),
      }),
    );

    const browser = fakeSocket();
    broker.attachRequestSocket(requestId, browser.socket);
    expect(browser.ofType("pair:request-ack")).toHaveLength(1);
  });

  it("closes a second listener on one request", () => {
    const broker = createBroker();
    const m = machine(broker);
    const { requestId } = ask(broker, m.key.deviceId).body as {
      requestId: string;
    };
    const first = fakeSocket();
    broker.attachRequestSocket(requestId, first.socket);
    const second = fakeSocket();
    expect(broker.attachRequestSocket(requestId, second.socket)).toBeNull();
    expect(second.closed).not.toBeNull();
  });

  it("never writes down which account asked which machine", () => {
    const broker = createBroker();
    const m = machine(broker);
    const result = ask(broker, m.key.deviceId);
    // The response carries a handle and a deadline; the request record the
    // broker keeps is not otherwise observable, and health reports nothing.
    expect(Object.keys(result.body as object).sort()).toEqual([
      "expiresAt",
      "requestId",
    ]);
    expect(JSON.stringify(broker.health().body)).not.toContain("example.com");
  });
});
