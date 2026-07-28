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
import type { PairingServerMessage, TunnelServerMessage } from "@repo/protocol";
import { createBroker, type Socket } from "./broker.js";
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

  it("reports zero offers when no mailbox holds the slot", () => {
    const broker = createBroker();
    const res = broker.pairClaim(IP, claimBody("49"));
    expect(res.status).toBe(200);
    expect((res.body as { offered: number }).offered).toBe(0);
  });

  it("fans a claim out to every live mailbox sharing the slot", () => {
    const broker = createBroker();
    const first = broker.pairNew(IP).body as {
      slot: string;
      mailboxId: string;
    };
    const slot = first.slot;

    // Keep opening mailboxes until three share that slot. Slots collide on
    // purpose — that is the whole point of fan-out.
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const ids: string[] = [first.mailboxId];
    let guard = 0;
    while (ids.length < 3 && guard++ < 5000) {
      const body = broker.pairNew(`10.0.0.${guard % 250}`).body as {
        slot: string;
        mailboxId: string;
      };
      if (body.slot === slot) ids.push(body.mailboxId);
    }
    expect(ids.length).toBe(3);

    for (const id of ids) {
      const s = fakeSocket();
      broker.attachMailboxSocket(id, s.socket);
      sockets.push(s);
    }

    const res = broker.pairClaim(IP, claimBody(slot));
    expect((res.body as { offered: number }).offered).toBe(3);
    for (const s of sockets) {
      expect(s.ofType("pair:peer-share")).toHaveLength(1);
    }
  });

  it("never offers the same mailbox twice", () => {
    const broker = createBroker();
    const { slot, mailboxId } = broker.pairNew(IP).body as {
      slot: string;
      mailboxId: string;
    };
    const s = fakeSocket();
    broker.attachMailboxSocket(mailboxId, s.socket);

    expect(
      (broker.pairClaim(IP, claimBody(slot)).body as { offered: number })
        .offered,
    ).toBe(1);
    // Second claim on the same slot sees the mailbox as already spent.
    expect(
      (broker.pairClaim(IP, claimBody(slot)).body as { offered: number })
        .offered,
    ).toBe(0);
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
    }).body as { claimId: string; offered: number };

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

  it("reports only counts from health, never contents", () => {
    broker.pairNew(IP);
    const body = broker.health().body as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.mailboxes).toBe(1);
    expect(JSON.stringify(body)).not.toContain(IP);
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
    }).body as { claimId: string; offered: number };

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
