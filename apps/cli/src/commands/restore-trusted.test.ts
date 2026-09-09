import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bytesToBase64Url,
  bytesToHex,
  deriveSessionKeys,
  encodeSessionKeys,
  FrameSealer,
  randomBytes,
  utf8ToBytes,
  type SessionKeys,
} from "@repo/crypto";
import {
  createTunnelAgent,
  type AgentSocket,
  type LocalSocket,
} from "../tunnel-agent.js";

/**
 * The restart bug, at the layer it actually lived.
 *
 * `mtmux start` → pair a phone → Ctrl+C → `mtmux start` again left every
 * previously paired device unable to reconnect over the tunnel, while a newly
 * paired one worked. The tunnel agent was never at fault: its keyring check is
 * correct and always was. Nothing repopulated that keyring from disk, because
 * the key schedule was never written there — only `directToken` was, which is
 * the relay's credential and covers the direct/LAN path alone. So a phone at
 * home kept working and the same phone on mobile data did not.
 *
 * These tests are about what `restoreTrustedDevices` hands back, which is the
 * thing that used not to exist.
 */
let dir: string;
let store: typeof import("../config-store.js");
let start: typeof import("./start.js");

/** Stands in for the loopback POST to the running relay. */
const accepts = async () => true;
const refuses = async () => false;

function keysFor(): SessionKeys {
  return deriveSessionKeys(randomBytes(32), randomBytes(32));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mtmux-restore-"));
  process.env.MTMUX_CONFIG_DIR = dir;
  // Both modules read MTMUX_CONFIG_DIR at import time.
  vi.resetModules();
  store = await import("../config-store.js");
  start = await import("./start.js");
});

afterEach(async () => {
  delete process.env.MTMUX_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("restoreTrustedDevices", () => {
  it("hands back the key schedule of a device paired before the restart", async () => {
    const keys = keysFor();
    await store.addPeer({
      deviceId: "browser-alice",
      publicKey: "",
      label: "iPhone · Safari",
      pairedAt: 1,
      lastSeenAt: Date.now(),
      directToken: keys.directToken,
      sessionKeys: encodeSessionKeys(keys),
    });

    const result = await start.restoreTrustedDevices(14100, "tok", accepts);

    expect(result.restored).toBe(1);
    expect(result.needRekey).toBe(0);
    expect(result.trusted).toHaveLength(1);
    // Byte-identical, or the agent's trial decryption will not match a frame.
    expect(result.trusted[0]!.keys.c2s).toEqual(keys.c2s);
    expect(result.trusted[0]!.keys.s2c).toEqual(keys.s2c);
    expect(result.trusted[0]!.identity).toEqual({
      deviceId: "browser-alice",
      label: "iPhone · Safari",
      restored: true,
    });
  });

  it("reports a pre-upgrade peer as local-only rather than broken", async () => {
    // Paired by 0.6.x: it has a relay credential and no key schedule. It can
    // still be reached on this network, so calling it "needs to pair again"
    // would be wrong in the direction that matters to someone on their sofa.
    await store.addPeer({
      deviceId: "browser-bob",
      publicKey: "",
      label: "MacBook · Chrome",
      pairedAt: 1,
      lastSeenAt: Date.now(),
      directToken: "a".repeat(64),
    });

    const result = await start.restoreTrustedDevices(14100, "tok", accepts);

    expect(result.restored).toBe(1);
    expect(result.needRekey).toBe(1);
    expect(result.needRepair).toBe(0);
    expect(result.trusted).toEqual([]);
  });

  it("counts a peer with no credential at all as needing to pair again", async () => {
    await store.addPeer({
      deviceId: "browser-old",
      publicKey: "",
      label: "Ancient",
      pairedAt: 1,
      lastSeenAt: Date.now(),
    });

    const result = await start.restoreTrustedDevices(14100, "tok", accepts);

    expect(result.needRepair).toBe(1);
    expect(result.restored).toBe(0);
    expect(result.trusted).toEqual([]);
  });

  it("skips an expired peer entirely", async () => {
    const keys = keysFor();
    await store.addPeer({
      deviceId: "browser-stale",
      publicKey: "",
      label: "Forgotten",
      pairedAt: 1,
      lastSeenAt: Date.now() - store.PEER_EXPIRY_MS - 1,
      directToken: keys.directToken,
      sessionKeys: encodeSessionKeys(keys),
    });

    const result = await start.restoreTrustedDevices(14100, "tok", accepts);

    expect(result).toMatchObject({ restored: 0, needRekey: 0, needRepair: 0 });
    expect(result.trusted).toEqual([]);
  });

  it("gives the relay the peer record's remaining lifetime, not its own default", async () => {
    // The one-day disconnect. The relay's own default is a 24 h window and the
    // restore used to leave it there, so every paired device stopped being able
    // to authenticate exactly a day after `mtmux start` — over LAN and over the
    // tunnel — while the CLI went on listing it as trusted and the fix looked
    // like restarting the CLI. What it must send is what the peer record has
    // left, so the relay can never outlive, or fall short of, `mtmux devices`.
    const keys = keysFor();
    const now = Date.UTC(2026, 0, 1);
    const age = 10 * 24 * 60 * 60 * 1000;
    await store.addPeer({
      deviceId: "browser-alice",
      publicKey: "",
      label: "iPhone · Safari",
      pairedAt: 1,
      lastSeenAt: now - age,
      directToken: keys.directToken,
      sessionKeys: encodeSessionKeys(keys),
    });

    const ttls: (number | undefined)[] = [];
    const record = async (
      _port: number,
      _token: string,
      _direct: string,
      _grant: unknown,
      _notice: unknown,
      ttlMs?: number,
    ) => {
      ttls.push(ttlMs);
      return true;
    };

    const result = await start.restoreTrustedDevices(
      14100,
      "tok",
      record as unknown as Parameters<typeof start.restoreTrustedDevices>[2],
      now,
    );

    expect(result.restored).toBe(1);
    expect(ttls).toEqual([store.PEER_EXPIRY_MS - age]);
    // Whatever else changes, it must never be the relay's silent default.
    expect(ttls[0]).not.toBeUndefined();
  });

  it("does not admit keys for a device the relay refused", async () => {
    // Admitting the schedule while the relay has never heard of the token
    // produces a browser that decrypts fine and then fails to authenticate —
    // the same ordering trap the live pairing path documents.
    const keys = keysFor();
    await store.addPeer({
      deviceId: "browser-alice",
      publicKey: "",
      label: "iPhone · Safari",
      pairedAt: 1,
      lastSeenAt: Date.now(),
      directToken: keys.directToken,
      sessionKeys: encodeSessionKeys(keys),
    });

    const result = await start.restoreTrustedDevices(14100, "tok", refuses);

    expect(result.restored).toBe(0);
    expect(result.trusted).toEqual([]);
  });

  it("treats a corrupted key schedule as local-only, not as a crash", async () => {
    await store.addPeer({
      deviceId: "browser-bent",
      publicKey: "",
      label: "Hand-edited",
      pairedAt: 1,
      lastSeenAt: Date.now(),
      directToken: "b".repeat(64),
      sessionKeys: {
        c2s: "not-hex",
        s2c: "also-not-hex",
        confirm: "nope",
        directToken: "b".repeat(64),
      },
    });

    const result = await start.restoreTrustedDevices(14100, "tok", accepts);

    expect(result.restored).toBe(1);
    expect(result.needRekey).toBe(1);
    expect(result.trusted).toEqual([]);
  });

  it("restores several devices independently", async () => {
    const a = keysFor();
    const b = keysFor();
    for (const [id, keys] of [
      ["browser-a", a],
      ["browser-b", b],
    ] as const) {
      await store.addPeer({
        deviceId: id,
        publicKey: "",
        label: id,
        pairedAt: 1,
        lastSeenAt: Date.now(),
        directToken: keys.directToken,
        sessionKeys: encodeSessionKeys(keys),
      });
    }

    const result = await start.restoreTrustedDevices(14100, "tok", accepts);

    expect(result.restored).toBe(2);
    expect(result.trusted.map((p) => p.identity.deviceId)).toEqual([
      "browser-a",
      "browser-b",
    ]);
  });
});

/** A socket whose two ends the test drives by hand. */
function fakeSocket() {
  const sent: string[] = [];
  let onMessage: ((data: string) => void) | null = null;
  let onClose: (() => void) | null = null;
  const onOpen: (() => void)[] = [];

  const socket: LocalSocket & AgentSocket = {
    send: (data) => sent.push(data),
    close: () => onClose?.(),
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
    deliver: (msg: unknown) => onMessage?.(JSON.stringify(msg)),
    open: () => {
      for (const cb of onOpen.splice(0)) cb();
    },
  };
}

/**
 * The whole chain, which is the only level at which the original bug is
 * visible: config.json → restoreTrustedDevices → the agent's keyring → a frame
 * from a browser that paired before the restart.
 *
 * Each half of this passed on its own the entire time the bug was live. The
 * agent's keyring check was correct; the peer record was faithfully persisted.
 * What did not exist was the join between them.
 */
describe("a device that paired before the restart", () => {
  it("can open a stream against a freshly started agent", async () => {
    const keys = keysFor();
    await store.addPeer({
      deviceId: "browser-alice",
      publicKey: "",
      label: "iPhone · Safari",
      pairedAt: 1,
      lastSeenAt: Date.now(),
      directToken: keys.directToken,
      sessionKeys: encodeSessionKeys(keys),
    });

    // --- the restart happens here ---
    const { trusted } = await start.restoreTrustedDevices(
      14100,
      "tok",
      accepts,
    );

    const brokers: ReturnType<typeof fakeSocket>[] = [];
    const locals: ReturnType<typeof fakeSocket>[] = [];
    const returned: string[] = [];
    const agent = createTunnelAgent({
      apiBase: "http://broker.test",
      deviceKey: (await store.ensureDeviceKey()).key,
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
      onStreamBound: (peer) => {
        if (peer) returned.push(peer.label);
      },
      scheduleRetry: (_attempt, run) => run(),
    });
    for (const peer of trusted) agent.addSessionKeys(peer.keys, peer.identity);
    agent.start();

    brokers[0]!.deliver({
      type: "tunnel:challenge",
      challenge: bytesToHex(randomBytes(32)),
    });
    brokers[0]!.deliver({ type: "tunnel:ready", tunnelId: "tnl-abcdefgh" });
    brokers[0]!.deliver({ type: "stream:open", streamId: "str-1" });
    locals[0]!.open();

    // The browser still holds the keys it derived before the restart.
    const sealer = new FrameSealer(keys.c2s, "c2s");
    const line = JSON.stringify({ type: "auth", token: keys.directToken });
    brokers[0]!.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: bytesToBase64Url(await sealer.seal(utf8ToBytes(line))),
    });
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Before the fix: no key on the ring opened this, so the agent answered
    // `stream:close / no matching pairing` and the browser reconnected forever.
    expect(locals[0]!.sent).toContain(line);
    expect(
      brokers[0]!.sent.filter((s) => s.includes("stream:close")),
    ).toHaveLength(0);
    expect(returned).toEqual(["iPhone · Safari"]);
  });
});

describe("restoring a scoped share", () => {
  /**
   * Re-registering a share without its grant is a privilege escalation.
   *
   * The relay reads an omitted grant as the full grant — which is right for an
   * ordinary pairing and catastrophic for a `mtmux share`: a token issued for
   * one read-only session came back after a restart with the run of the
   * machine. The peer record now carries the grant id so the scope survives the
   * process boundary.
   */
  async function addSharedPeer(grantId: string, keys: SessionKeys) {
    await store.addPeer({
      deviceId: "browser-guest",
      publicKey: "",
      label: "Guest",
      pairedAt: 1,
      lastSeenAt: Date.now(),
      directToken: keys.directToken,
      sessionKeys: encodeSessionKeys(keys),
      grantId,
    });
  }

  it("hands the relay the grant it was originally issued under", async () => {
    const grants = await import("../grants-store.js");
    const keys = keysFor();
    const grant = {
      id: "grant-1",
      label: "work, read-only",
      tokenHash: grants.hashToken(keys.directToken),
      createdAt: Date.now(),
      expiresAt: null,
      revokedAt: null,
      tmuxServerPid: null,
      readOnly: true,
      files: "none" as const,
      scope: {
        kind: "sessions" as const,
        sessions: [{ id: "$0", name: "work" }],
      },
    };
    await grants.add(grant);
    await addSharedPeer(grant.id, keys);

    const seen: unknown[] = [];
    const record = async (
      _port: number,
      _token: string,
      _direct: string,
      passed: unknown,
    ) => {
      seen.push(passed);
      return true;
    };

    const result = await start.restoreTrustedDevices(
      14100,
      "tok",
      record as unknown as Parameters<typeof start.restoreTrustedDevices>[2],
    );

    expect(result.restored).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: "grant-1", readOnly: true });
  });

  it("refuses to restore a peer whose share is gone", async () => {
    // Restoring it unscoped is the escalation; restoring it at all is wrong,
    // because the share it belonged to has been revoked or has expired.
    const keys = keysFor();
    await addSharedPeer("grant-vanished", keys);

    const seen: unknown[] = [];
    const record = async (...args: unknown[]) => {
      seen.push(args);
      return true;
    };

    const result = await start.restoreTrustedDevices(
      14100,
      "tok",
      record as unknown as Parameters<typeof start.restoreTrustedDevices>[2],
    );

    expect(result.restored).toBe(0);
    expect(seen).toEqual([]);
  });

  it("still restores an ordinary pairing with no grant at all", async () => {
    const keys = keysFor();
    await store.addPeer({
      deviceId: "browser-alice",
      publicKey: "",
      label: "iPhone",
      pairedAt: 1,
      lastSeenAt: Date.now(),
      directToken: keys.directToken,
      sessionKeys: encodeSessionKeys(keys),
    });

    const seen: unknown[] = [];
    const record = async (
      _port: number,
      _token: string,
      _direct: string,
      passed: unknown,
    ) => {
      seen.push(passed);
      return true;
    };

    const result = await start.restoreTrustedDevices(
      14100,
      "tok",
      record as unknown as Parameters<typeof start.restoreTrustedDevices>[2],
    );

    expect(result.restored).toBe(1);
    // Undefined, which the relay reads as the full grant — unchanged, and what
    // every pairing before shares existed has always meant.
    expect(seen).toEqual([undefined]);
  });
});
