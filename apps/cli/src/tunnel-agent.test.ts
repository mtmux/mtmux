import { describe, it, expect } from "vitest";
import {
  generateDeviceKey,
  verifyChallenge,
  hexToBytes,
  bytesToHex,
  randomBytes,
  deriveSessionKeys,
  FrameSealer,
  FrameOpener,
  bytesToBase64Url,
  base64UrlToBytes,
  utf8ToBytes,
  type SessionKeys,
} from "@repo/crypto";
import {
  createTunnelAgent,
  type AgentSocket,
  type LocalSocket,
  type PeerIdentity,
} from "./tunnel-agent.js";

/** A distinct pairing's key schedule. */
function sessionKeys(): SessionKeys {
  return deriveSessionKeys(randomBytes(32), randomBytes(32));
}

/**
 * The browser's half of the seal, so tests exercise the real codec rather than
 * a stand-in. The browser seals on c2s and opens s2c; the agent is the mirror.
 */
function browserEnd(keys: SessionKeys) {
  const sealer = new FrameSealer(keys.c2s, "c2s");
  const opener = new FrameOpener(keys.s2c, "s2c");
  return {
    seal: async (line: string) =>
      bytesToBase64Url(await sealer.seal(utf8ToBytes(line))),
    open: async (data: string) =>
      new TextDecoder().decode(await opener.open(base64UrlToBytes(data))),
  };
}

/**
 * Let the agent's per-stream promise chain drain.
 *
 * Seal and open are WebCrypto calls, so every frame crosses at least one
 * microtask boundary before it reaches the far socket.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** A socket whose two ends the test drives by hand. */
function fakeSocket() {
  const sent: string[] = [];
  let onMessage: ((data: string) => void) | null = null;
  let onClose: (() => void) | null = null;
  const onOpen: (() => void)[] = [];
  let closed = false;

  const socket: LocalSocket & AgentSocket = {
    send: (data) => sent.push(data),
    close: () => {
      if (closed) return;
      closed = true;
      onClose?.();
    },
    onMessage: (cb) => {
      onMessage = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    onOpen: (cb) => onOpen.push(cb),
  };

  return {
    socket,
    sent,
    get closed() {
      return closed;
    },
    parsed: () => sent.map((s) => JSON.parse(s) as Record<string, unknown>),
    ofType(type: string) {
      return sent
        .map((s) => JSON.parse(s) as Record<string, unknown>)
        .filter((m) => m.type === type);
    },
    deliver: (msg: unknown) => onMessage?.(JSON.stringify(msg)),
    deliverRaw: (raw: string) => onMessage?.(raw),
    open: () => {
      for (const cb of onOpen.splice(0)) cb();
    },
    remoteClose: () => {
      closed = true;
      onClose?.();
    },
  };
}

function harness(overrides: { retryDelays?: number[] } = {}) {
  const key = generateDeviceKey();
  const brokers: ReturnType<typeof fakeSocket>[] = [];
  const locals: ReturnType<typeof fakeSocket>[] = [];
  const retries: number[] = [];
  /** Every peer a stream bound to, in order, including the undefined ones. */
  const bound: (PeerIdentity | undefined)[] = [];

  const agent = createTunnelAgent({
    apiBase: "http://broker.test",
    deviceKey: key,
    onStreamBound: (peer) => bound.push(peer),
    connectBroker: () => {
      const s = fakeSocket();
      brokers.push(s);
      return s.socket;
    },
    connectLocal: () => {
      const s = fakeSocket();
      locals.push(s);
      return s.socket;
    },
    scheduleRetry: (attempt, run) => {
      retries.push(attempt);
      // Run synchronously so reconnect behaviour is deterministic.
      if (overrides.retryDelays === undefined) run();
    },
  });

  return { agent, key, brokers, locals, retries, bound };
}

/** Register the agent and return the tunnel id the broker handed out. */
function register(h: ReturnType<typeof harness>, index = 0) {
  const broker = h.brokers[index]!;
  const challenge = randomBytes(32);
  broker.deliver({
    type: "tunnel:challenge",
    challenge: bytesToHex(challenge),
  });
  broker.deliver({ type: "tunnel:ready", tunnelId: "tnl-abcdefgh" });
  return { broker, challenge };
}

describe("registration", () => {
  it("signs the broker's challenge with the device key", () => {
    const h = harness();
    h.agent.start();
    const { broker, challenge } = register(h);

    const reg = broker.ofType("tunnel:register")[0]!;
    expect(reg.deviceId).toBe(h.key.deviceId);
    expect(reg.publicKey).toBe(bytesToHex(h.key.publicKey));
    expect(reg.challenge).toBe(bytesToHex(challenge));
    expect(
      verifyChallenge(
        h.key.publicKey,
        challenge,
        hexToBytes(reg.signature as string),
      ),
    ).toBe(true);
  });

  it("reports the tunnel id and a registered status", () => {
    const h = harness();
    h.agent.start();
    register(h);
    expect(h.agent.tunnelId).toBe("tnl-abcdefgh");
    expect(h.agent.status).toBe("registered");
  });

  it("ignores a malformed frame instead of dying", () => {
    const h = harness();
    h.agent.start();
    h.brokers[0]!.deliverRaw("{not json");
    h.brokers[0]!.deliver({ type: "nonsense" });
    expect(h.agent.status).toBe("connecting");
    expect(h.brokers[0]!.closed).toBe(false);
  });
});

describe("stream plumbing", () => {
  it("opens a local relay socket when the broker asks for a stream", () => {
    const h = harness();
    h.agent.start();
    register(h);
    expect(h.locals).toHaveLength(0);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    expect(h.locals).toHaveLength(1);
  });

  it("sends nothing of its own before the browser's first frame", async () => {
    /**
     * The regression test for the first finding.
     *
     * The agent used to authenticate this loopback socket with the machine's
     * full `AUTH_TOKEN`, so every tunnelled browser arrived on an
     * already-privileged connection and its own credential was never checked.
     * Over the tunnel there was consequently nothing to scope.
     *
     * The first thing on this socket must now be the browser's own `auth`
     * frame, verbatim — nothing injected before it.
     */
    const h = harness();
    const keys = sessionKeys();
    h.agent.addSessionKeys(keys);
    const browser = browserEnd(keys);
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    const local = h.locals[0]!;
    local.open();
    await flush();

    // Nothing at all until the browser speaks.
    expect(local.sent).toEqual([]);

    const browserAuth = JSON.stringify({
      type: "auth",
      token: "the-browsers-own-direct-token",
    });
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browser.seal(browserAuth),
    });
    await flush();

    expect(local.sent[0]).toBe(browserAuth);
    // Nothing anywhere on this socket carries the machine's token.
    expect(local.sent.join("\n")).not.toContain("AUTH_TOKEN");
  });

  it("unseals browser frames into plaintext relay lines", async () => {
    const h = harness();
    const keys = sessionKeys();
    h.agent.addSessionKeys(keys);
    const browser = browserEnd(keys);
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    const local = h.locals[0]!;
    local.open();

    const line = JSON.stringify({ type: "auth", token: "abc" });
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browser.seal(line),
    });
    await flush();

    // The relay speaks JSON, not ciphertext. Forwarding the sealed bytes
    // verbatim — the original bug — left the relay unable to parse a thing.
    expect(local.sent).toContain(line);
  });

  it("holds frames that arrive before the local socket is open", async () => {
    const h = harness();
    const keys = sessionKeys();
    h.agent.addSessionKeys(keys);
    const browser = browserEnd(keys);
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    const local = h.locals[0]!;

    // Frame races the loopback connect — it must not be dropped.
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browser.seal("early"),
    });
    await flush();
    expect(local.sent).toHaveLength(0);

    local.open();
    expect(local.sent).toContain("early");
  });

  it("seals relay output back to the browser under the same stream id", async () => {
    const h = harness();
    const keys = sessionKeys();
    h.agent.addSessionKeys(keys);
    const browser = browserEnd(keys);
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();

    // The sealer is only known once a frame has identified the pairing, so the
    // browser has to speak first — as it does in reality.
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browser.seal("hello"),
    });
    await flush();

    h.locals[0]!.deliverRaw("terminal output");
    await flush();

    const frames = h.brokers[0]!.ofType("stream:frame");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ streamId: "str-1" });
    expect(await browser.open(frames[0]!.data as string)).toBe(
      "terminal output",
    );
  });

  it("holds relay output produced before the browser identified itself", async () => {
    const h = harness();
    const keys = sessionKeys();
    h.agent.addSessionKeys(keys);
    const browser = browserEnd(keys);
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();

    // The relay answers the agent's own `auth` immediately, before any browser
    // frame has arrived. Dropping it would lose the handshake.
    h.locals[0]!.deliverRaw('{"type":"auth:success"}');
    await flush();
    expect(h.brokers[0]!.ofType("stream:frame")).toHaveLength(0);

    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browser.seal("hi"),
    });
    await flush();

    const frames = h.brokers[0]!.ofType("stream:frame");
    expect(frames).toHaveLength(1);
    expect(await browser.open(frames[0]!.data as string)).toBe(
      '{"type":"auth:success"}',
    );
  });

  it("picks the matching pairing when several are on one tunnel", async () => {
    const h = harness();
    const alice = sessionKeys();
    const bob = sessionKeys();
    h.agent.addSessionKeys(alice);
    h.agent.addSessionKeys(bob);
    h.agent.start();
    register(h);

    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-a" });
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-b" });
    h.locals[0]!.open();
    h.locals[1]!.open();

    // Bob is second in the keyring, so his stream only resolves if trial
    // decryption really walks the ring rather than assuming the first entry.
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-b",
      data: await browserEnd(bob).seal("from-bob"),
    });
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-a",
      data: await browserEnd(alice).seal("from-alice"),
    });
    await flush();

    expect(h.locals[0]!.sent).toContain("from-alice");
    expect(h.locals[1]!.sent).toContain("from-bob");
  });

  it("refuses a stream no known pairing can open", async () => {
    const h = harness();
    h.agent.addSessionKeys(sessionKeys());
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();

    // A caller who guessed the tunnel id but holds no pairing key. This is the
    // check that makes a leaked tunnel id worthless on its own.
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browserEnd(sessionKeys()).seal("let me in"),
    });
    await flush();

    expect(h.locals[0]!.sent).toHaveLength(0);
    expect(h.locals[0]!.closed).toBe(true);
    expect(h.brokers[0]!.ofType("stream:close")[0]).toMatchObject({
      streamId: "str-1",
    });
  });

  it("kills a stream whose frame fails authentication mid-session", async () => {
    const h = harness();
    const keys = sessionKeys();
    h.agent.addSessionKeys(keys);
    const browser = browserEnd(keys);
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();

    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browser.seal("legit"),
    });
    await flush();
    expect(h.locals[0]!.sent).toContain("legit");

    // Flip a byte of the ciphertext. GCM's tag must reject it.
    const tampered = base64UrlToBytes(await browser.seal("evil"));
    tampered[tampered.length - 1] ^= 0xff;
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: bytesToBase64Url(tampered),
    });
    await flush();

    expect(h.locals[0]!.sent).toHaveLength(1);
    expect(h.locals[0]!.closed).toBe(true);
  });

  it("rejects a replayed frame", async () => {
    const h = harness();
    const keys = sessionKeys();
    h.agent.addSessionKeys(keys);
    const browser = browserEnd(keys);
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();

    const frame = await browser.seal("replay me");
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: frame,
    });
    await flush();
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: frame,
    });
    await flush();

    expect(h.locals[0]!.sent).toEqual(["replay me"]);
    expect(h.locals[0]!.closed).toBe(true);
  });

  it("preserves relay line order across many frames", async () => {
    const h = harness();
    const keys = sessionKeys();
    h.agent.addSessionKeys(keys);
    const browser = browserEnd(keys);
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();

    // Sealing is async, so without a per-stream chain these would race and the
    // relay would see terminal input out of order.
    const lines = Array.from({ length: 25 }, (_, i) => `line-${i}`);
    for (const line of lines) {
      h.brokers[0]!.deliver({
        type: "stream:frame",
        streamId: "str-1",
        data: await browser.seal(line),
      });
    }
    await flush();

    expect(h.locals[0]!.sent).toEqual(lines);
  });

  it("tells the broker when the local relay hangs up", () => {
    const h = harness();
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();
    h.locals[0]!.remoteClose();

    expect(h.brokers[0]!.ofType("stream:close")[0]).toMatchObject({
      streamId: "str-1",
    });
  });

  it("closes the local socket when the broker closes the stream", () => {
    const h = harness();
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();
    h.brokers[0]!.deliver({ type: "stream:close", streamId: "str-1" });
    expect(h.locals[0]!.closed).toBe(true);
  });

  it("drops a frame for an unknown stream rather than throwing", () => {
    const h = harness();
    h.agent.start();
    register(h);
    expect(() =>
      h.brokers[0]!.deliver({
        type: "stream:frame",
        streamId: "str-unknown",
        data: "AA",
      }),
    ).not.toThrow();
  });
});

describe("reconnection", () => {
  it("reconnects with increasing attempt numbers after a drop", () => {
    const h = harness({ retryDelays: [] });
    h.agent.start();
    register(h);

    h.brokers[0]!.remoteClose();
    expect(h.retries).toEqual([0]);
    expect(h.agent.status).toBe("disconnected");
    expect(h.agent.tunnelId).toBeNull();
  });

  it("resets the backoff once a reconnect succeeds", () => {
    const h = harness();
    h.agent.start();
    register(h, 0);

    h.brokers[0]!.remoteClose(); // retry runs synchronously -> brokers[1]
    expect(h.brokers).toHaveLength(2);
    register(h, 1);
    expect(h.agent.status).toBe("registered");

    h.brokers[1]!.remoteClose();
    // Attempt counter restarted, so the second drop is attempt 0 again.
    expect(h.retries).toEqual([0, 0]);
  });

  it("tears local streams down on disconnect", () => {
    const h = harness({ retryDelays: [] });
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();

    h.brokers[0]!.remoteClose();
    expect(h.locals[0]!.closed).toBe(true);
  });

  it("does not reconnect after stop()", () => {
    const h = harness({ retryDelays: [] });
    h.agent.start();
    register(h);
    h.agent.stop();
    expect(h.agent.status).toBe("stopped");
    expect(h.retries).toEqual([]);
    expect(h.brokers).toHaveLength(1);
  });

  it("closes everything when the broker reports the tunnel is gone", () => {
    const h = harness({ retryDelays: [] });
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();

    h.brokers[0]!.deliver({ type: "tunnel:closed", reason: "quota-exceeded" });
    expect(h.locals[0]!.closed).toBe(true);
    expect(h.brokers[0]!.closed).toBe(true);
  });
});

/**
 * The restart case.
 *
 * The keyring used to hold only pairings completed in the running process, so
 * every device that had ever paired was refused after a restart — silently, and
 * only over the tunnel, because the relay credential half of the restore kept
 * the LAN path working. These tests pin the half that was missing.
 */
describe("pairings restored from disk", () => {
  const alicePeer: PeerIdentity = {
    deviceId: "browser-alice",
    label: "iPhone · Safari",
    restored: true,
  };

  it("opens a stream sealed under a key it was never live-paired with", async () => {
    const keys = sessionKeys();

    // No pairing happens here. This is the whole point: the schedule arrives
    // from `~/.mtmux/config.json` before the agent has ever run a handshake.
    const h = harness();
    h.agent.addSessionKeys(keys, alicePeer);
    h.agent.start();
    register(h);

    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browserEnd(keys).seal("auth-line"),
    });
    await flush();

    expect(h.locals[0]!.sent).toContain("auth-line");
    expect(h.brokers[0]!.ofType("stream:close")).toHaveLength(0);
  });

  it("names the device that came back", async () => {
    const keys = sessionKeys();
    const h = harness();
    h.agent.addSessionKeys(keys, alicePeer);
    h.agent.start();
    register(h);

    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browserEnd(keys).seal("auth-line"),
    });
    await flush();

    expect(h.bound).toEqual([alicePeer]);
  });

  it("still refuses a stream when only restored keys are on the ring", async () => {
    // The restore must widen who gets in, not whether the check happens.
    const h = harness();
    h.agent.addSessionKeys(sessionKeys(), alicePeer);
    h.agent.start();
    register(h);

    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browserEnd(sessionKeys()).seal("let me in"),
    });
    await flush();

    expect(h.locals[0]!.sent).toHaveLength(0);
    expect(h.locals[0]!.closed).toBe(true);
    expect(h.bound).toEqual([]);
  });

  it("keeps every restored device on the ring, not just the last few", async () => {
    // The cap used to be 8, which a household passes without noticing. An
    // evicted entry is not a slow path — it is a device that cannot reconnect.
    const h = harness();
    const many = Array.from({ length: 24 }, () => sessionKeys());
    many.forEach((keys, i) =>
      h.agent.addSessionKeys(keys, {
        deviceId: `browser-${i}`,
        label: `Device ${i}`,
        restored: true,
      }),
    );
    h.agent.start();
    register(h);

    // The first one added is the one an eviction would have dropped.
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: await browserEnd(many[0]!).seal("still-here"),
    });
    await flush();

    expect(h.locals[0]!.sent).toContain("still-here");
  });
});
