import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { deriveTunnelId, resolveTunnelIdSecret } from "./tunnel-id.js";
import { createTunnelRegistry } from "./tunnel.js";

/**
 * The regression this file exists for.
 *
 * A `pnpm deploy:hosted` reloaded the broker, the in-memory id reservation went
 * with the process, every agent re-registered under a fresh id, and every
 * paired browser was left dialling a url that no longer resolved — all at once,
 * with no route back but re-pairing. The reservation's own comment claimed to
 * cover "a broker restart". It did not, and nothing tested that it did.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mtmux-broker-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sink = () => () => {};
const quotas = { maxBytes: 1024, maxMinutes: 720, maxStreams: 16 };

describe("tunnel ids across a restart", () => {
  it("gives a device the same id after the broker process dies", () => {
    const { secret } = resolveTunnelIdSecret({ env: {}, stateDir: dir });

    // Two registries with no shared memory: this is a restart.
    const before = createTunnelRegistry(quotas, { idSecret: secret });
    const first = before.register("device-a", "pub", sink());

    const after = createTunnelRegistry(quotas, { idSecret: secret });
    const second = after.register("device-a", "pub", sink());

    expect(second.id).toBe(first.id);
  });

  it("still gives different devices different ids", () => {
    const { secret } = resolveTunnelIdSecret({ env: {}, stateDir: dir });
    const registry = createTunnelRegistry(quotas, { idSecret: secret });
    expect(registry.register("device-a", "pub", sink()).id).not.toBe(
      registry.register("device-b", "pub", sink()).id,
    );
  });

  it("keeps the id across a reconnect, as it always did", () => {
    const registry = createTunnelRegistry(quotas, {
      idSecret: crypto.randomBytes(32),
    });
    const first = registry.register("device-a", "pub", sink());
    const again = registry.register("device-a", "pub", sink());
    expect(again.id).toBe(first.id);
  });

  it("rotates the id on revocation, and only on revocation", () => {
    const registry = createTunnelRegistry(quotas, {
      idSecret: crypto.randomBytes(32),
    });
    const first = registry.register("device-a", "pub", sink());

    registry.close(first.id, "agent-gone");
    expect(registry.register("device-a", "pub", sink()).id).toBe(first.id);

    const current = registry.register("device-a", "pub", sink());
    registry.close(current.id, "revoked");
    expect(registry.register("device-a", "pub", sink()).id).not.toBe(first.id);
  });

  it("cannot be derived without the secret", () => {
    const a = deriveTunnelId(crypto.randomBytes(32), "device-a");
    const b = deriveTunnelId(crypto.randomBytes(32), "device-a");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^tnl-[\w-]{22}$/);
  });
});

describe("resolveTunnelIdSecret", () => {
  it("writes the key 0600 on first boot and reuses it after", async () => {
    const first = resolveTunnelIdSecret({ env: {}, stateDir: dir });
    expect(first.source).toBe("file");

    const info = await stat(join(dir, "tunnel-id.key"));
    expect(info.mode & 0o077).toBe(0);

    const second = resolveTunnelIdSecret({ env: {}, stateDir: dir });
    expect(second.source).toBe("file");
    expect(second.secret.equals(first.secret)).toBe(true);
  });

  it("prefers the environment, so several processes can agree", () => {
    const env = { API_TUNNEL_ID_SECRET: "shared-passphrase" };
    const a = resolveTunnelIdSecret({ env, stateDir: dir });
    const b = resolveTunnelIdSecret({ env, stateDir: join(dir, "elsewhere") });
    expect(a.source).toBe("env");
    expect(a.secret.equals(b.secret)).toBe(true);
  });

  it("reads 64 hex chars as the key itself, not as a passphrase", () => {
    // The migration path for a live broker: `xxd -p tunnel-id.key` in the env
    // has to derive the ids the file was already deriving, or moving the secret
    // into config would disconnect every paired device a second time.
    const fromFile = resolveTunnelIdSecret({ env: {}, stateDir: dir });
    const asEnv = resolveTunnelIdSecret({
      env: { API_TUNNEL_ID_SECRET: fromFile.secret.toString("hex") },
      stateDir: join(dir, "unused"),
    });
    expect(asEnv.source).toBe("env");
    expect(deriveTunnelId(asEnv.secret, "device-a")).toBe(
      deriveTunnelId(fromFile.secret, "device-a"),
    );
  });

  it("hashes anything that is not raw key material", () => {
    const a = resolveTunnelIdSecret({
      env: { API_TUNNEL_ID_SECRET: "short" },
      stateDir: dir,
    });
    expect(a.secret).toHaveLength(32);
  });

  it("does not write a key file when the environment supplies one", async () => {
    resolveTunnelIdSecret({
      env: { API_TUNNEL_ID_SECRET: "shared" },
      stateDir: dir,
    });
    await expect(readFile(join(dir, "tunnel-id.key"))).rejects.toThrow();
  });

  it("warns rather than throws when it cannot persist anything", () => {
    const warnings: string[] = [];
    // A path under a file, so both mkdir and write fail.
    const impossible = join(dir, "tunnel-id.key", "nested");
    resolveTunnelIdSecret({ env: {}, stateDir: dir });
    const result = resolveTunnelIdSecret({
      env: {},
      stateDir: impossible,
      onWarn: (m) => warnings.push(m),
    });
    expect(result.source).toBe("ephemeral");
    expect(result.secret).toHaveLength(32);
    expect(warnings[0]).toContain("pair again");
  });
});
