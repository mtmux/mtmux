import { describe, it, expect } from "vitest";
import {
  generateDeviceKey,
  verifyChallenge,
  hexToBytes,
  bytesToHex,
  randomBytes,
} from "@repo/crypto";
import {
  createTunnelAgent,
  type AgentSocket,
  type LocalSocket,
} from "./tunnel-agent.js";

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

  const agent = createTunnelAgent({
    apiBase: "http://broker.test",
    deviceKey: key,
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

  return { agent, key, brokers, locals, retries };
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

  it("copies frames from the browser into the local relay", () => {
    const h = harness();
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    const local = h.locals[0]!;
    local.open();

    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: "c2VhbGVk",
    });
    expect(local.sent).toContain("c2VhbGVk");
  });

  it("holds frames that arrive before the local socket is open", () => {
    const h = harness();
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    const local = h.locals[0]!;

    // Frame races the loopback connect — it must not be dropped.
    h.brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: "ZWFybHk",
    });
    expect(local.sent).not.toContain("ZWFybHk");

    local.open();
    expect(local.sent).toContain("ZWFybHk");
  });

  it("copies relay output back to the broker under the same stream id", () => {
    const h = harness();
    h.agent.start();
    register(h);
    h.brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    h.locals[0]!.open();
    h.locals[0]!.deliver("terminal output");

    const frames = h.brokers[0]!.ofType("stream:frame");
    expect(frames[0]).toMatchObject({ streamId: "str-1" });
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
