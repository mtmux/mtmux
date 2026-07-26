import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChallenge, newChallenge, signChallenge } from "@repo/crypto";

/**
 * config-store reads MTMUX_CONFIG_DIR at import time, so each test gets a
 * throwaway directory and a fresh module instance. Nothing here can touch the
 * developer's real ~/.mtmux.
 */
let dir: string;
let store: typeof import("./config-store.js");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mtmux-cfg-"));
  process.env.MTMUX_CONFIG_DIR = dir;
  // The module reads MTMUX_CONFIG_DIR at import time, so the registry has to
  // be cleared for the new directory to take effect.
  vi.resetModules();
  store = await import("./config-store.js");
});

afterEach(async () => {
  delete process.env.MTMUX_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("token handling", () => {
  it("generates a 64-hex token on first load", async () => {
    const cfg = await store.load();
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same token on a second load", async () => {
    const first = await store.load();
    expect((await store.load()).token).toBe(first.token);
  });

  it("writes the config 0600 — it holds a token and a secret key", async () => {
    await store.load();
    const info = await stat(join(dir, "config.json"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("honours an explicitly set token", async () => {
    await store.set("my-token");
    expect((await store.load()).token).toBe("my-token");
  });
});

describe("device identity", () => {
  it("creates a key on first use and reuses it after", async () => {
    const first = await store.ensureDeviceKey();
    expect(first.key.deviceId).toMatch(/^[0-9a-f]{16}$/);
    const second = await store.ensureDeviceKey();
    expect(second.key.deviceId).toBe(first.key.deviceId);
  });

  it("round-trips a key that can still sign", async () => {
    await store.ensureDeviceKey();
    const { key } = await store.ensureDeviceKey();
    const challenge = newChallenge();
    expect(
      verifyChallenge(
        key.publicKey,
        challenge,
        signChallenge(key.secretKey, challenge),
      ),
    ).toBe(true);
  });

  it("replaces a corrupted key rather than failing every command", async () => {
    const { key } = await store.ensureDeviceKey();
    const cfg = await store.load();
    await store.save({
      ...cfg,
      deviceKey: { deviceId: "0".repeat(16), publicKey: "aa", secretKey: "bb" },
    });
    const recovered = await store.ensureDeviceKey();
    expect(recovered.key.deviceId).not.toBe("0".repeat(16));
    expect(recovered.key.deviceId).not.toBe(key.deviceId);
  });

  it("survives a token rotation — rotating must not un-pair devices", async () => {
    const { key } = await store.ensureDeviceKey();
    await store.addPeer({
      deviceId: "peer1",
      publicKey: "",
      label: "iPhone",
      pairedAt: 1,
      lastSeenAt: 1,
    });

    const before = (await store.load()).token;
    const after = (await store.regenerate()).token;
    expect(after).not.toBe(before);

    const cfg = await store.load();
    expect(cfg.deviceKey?.deviceId).toBe(key.deviceId);
    expect(cfg.peers).toHaveLength(1);
  });
});

describe("peers", () => {
  const peer = (deviceId: string, label = "device") => ({
    deviceId,
    publicKey: "",
    label,
    pairedAt: 1000,
    lastSeenAt: 1000,
  });

  it("starts empty", async () => {
    expect(await store.listPeers()).toEqual([]);
  });

  it("adds and lists peers", async () => {
    await store.addPeer(peer("a", "iPhone"));
    await store.addPeer(peer("b", "iPad"));
    expect((await store.listPeers()).map((p) => p.label)).toEqual([
      "iPhone",
      "iPad",
    ]);
  });

  it("replaces a peer rather than duplicating it on re-pair", async () => {
    await store.addPeer(peer("a", "iPhone"));
    await store.addPeer(peer("a", "iPhone 16"));
    const peers = await store.listPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]?.label).toBe("iPhone 16");
  });

  it("revokes a peer and reports whether it existed", async () => {
    await store.addPeer(peer("a"));
    expect(await store.removePeer("a")).toBe(true);
    expect(await store.listPeers()).toEqual([]);
    expect(await store.removePeer("a")).toBe(false);
  });

  it("records last-seen time", async () => {
    await store.addPeer(peer("a"));
    await store.touchPeer("a", 5000);
    expect((await store.listPeers())[0]?.lastSeenAt).toBe(5000);
  });

  it("ignores a touch for an unknown peer", async () => {
    await expect(store.touchPeer("nope", 5000)).resolves.toBeUndefined();
  });

  it("treats a peer idle for over 90 days as expired", () => {
    const now = 1_000_000_000_000;
    const fresh = { ...peer("a"), lastSeenAt: now - 1000 };
    const stale = { ...peer("b"), lastSeenAt: now - store.PEER_EXPIRY_MS - 1 };
    expect(store.isPeerExpired(fresh, now)).toBe(false);
    expect(store.isPeerExpired(stale, now)).toBe(true);
  });

  it("never writes the secret key in plain view of other users", async () => {
    await store.ensureDeviceKey();
    const info = await stat(join(dir, "config.json"));
    expect(info.mode & 0o077).toBe(0);
    // Sanity: it really is in there, so the permission check matters.
    const raw = await readFile(join(dir, "config.json"), "utf8");
    expect(raw).toContain("secretKey");
  });
});
