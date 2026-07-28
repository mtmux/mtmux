import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  generateDeviceKey,
  encodeDeviceKey,
  decodeDeviceKey,
  type DeviceKeyPair,
  type StoredDeviceKey,
} from "@repo/crypto";

// Overridable so tests never touch the developer's real config, and so a user
// can keep their token somewhere other than $HOME.
const DIR = process.env.MTMUX_CONFIG_DIR ?? join(homedir(), ".mtmux");
const FILE = join(DIR, "config.json");

// This CLI shipped as `tmuxremote` before it was renamed to `mtmux`. Adopt the
// old token rather than silently issuing a new one — otherwise upgrading
// invalidates every bookmarked login URL the user has.
const LEGACY_FILE = join(homedir(), ".tmuxremote", "config.json");

/** A browser (or another CLI) this machine has paired with. */
export type PeerRecord = {
  deviceId: string;
  /** Ed25519 public key, hex. Used to verify reconnect challenges. */
  publicKey: string;
  /** Human label for `mtmux devices`, e.g. "iPhone · Safari". */
  label: string;
  pairedAt: number;
  lastSeenAt: number;
  /**
   * The direct-path token derived with this peer, so restarting the server does
   * not force it to pair again.
   *
   * This is a deliberate weakening of an earlier property — relay session
   * tokens lived only in memory, so a restart revoked every device. That reads
   * well but is the wrong trade for a tool that runs on a server: it made every
   * deploy, crash or reboot cost a walk to another device. "Paired" should mean
   * what it means for a phone or a Bluetooth keyboard — trusted until revoked.
   *
   * The bound is still real: entries expire after `PEER_EXPIRY_MS`,
   * `mtmux devices revoke` deletes them, and the file is 0600 alongside the
   * machine's own auth token and Ed25519 secret, so this adds no secret to a
   * file that was not already the crown jewels.
   */
  directToken?: string;
};

/**
 * A signed-in account.
 *
 * Scoped to `apiBase` on purpose: a token minted by api.mtmux.com means nothing
 * to a self-hosted broker, and silently sending it there would be both useless
 * and a credential leak to a third party. Switching brokers therefore means
 * signing in again, which is the honest behaviour.
 */
export type Account = {
  token: string;
  userId: string;
  email: string;
  apiBase: string;
  /** The registry row this machine claimed, once it has registered. */
  serverId?: string;
};

export type Config = {
  token: string;
  /** This machine's device identity, created on first pair. */
  deviceKey?: StoredDeviceKey;
  peers?: PeerRecord[];
  account?: Account;
  /** What this machine calls itself in the dashboard. Defaults to hostname. */
  serverName?: string;
};

async function write(cfg: Config): Promise<Config> {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(cfg, null, 2));
  // The file holds the auth token and an Ed25519 secret key.
  await chmod(FILE, 0o600);
  return cfg;
}

export async function load(): Promise<Config> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Config;
  } catch {
    // Fall through to the legacy location, then to a fresh token.
  }
  try {
    const legacy = JSON.parse(await readFile(LEGACY_FILE, "utf8")) as Config;
    if (legacy?.token) return set(legacy.token);
  } catch {
    // No legacy config either.
  }
  return regenerate();
}

export async function regenerate(): Promise<Config> {
  // Deliberately preserves the device key and peers: rotating the auth token
  // should not un-pair every device the user owns.
  let existing: Partial<Config> = {};
  try {
    existing = JSON.parse(await readFile(FILE, "utf8")) as Config;
  } catch {
    // First run.
  }
  return write({
    ...existing,
    token: randomBytes(32).toString("hex"),
  });
}

export async function set(token: string): Promise<Config> {
  let existing: Partial<Config> = {};
  try {
    existing = JSON.parse(await readFile(FILE, "utf8")) as Config;
  } catch {
    // First run.
  }
  return write({ ...existing, token });
}

export async function save(cfg: Config): Promise<Config> {
  return write(cfg);
}

/**
 * This machine's long-lived identity, generated on first use.
 *
 * Once a browser has paired, reconnecting is a signed challenge against this
 * key rather than another six-digit code — so the code is needed exactly once,
 * ever.
 */
export async function ensureDeviceKey(): Promise<{
  config: Config;
  key: DeviceKeyPair;
}> {
  const config = await load();
  if (config.deviceKey) {
    try {
      return { config, key: decodeDeviceKey(config.deviceKey) };
    } catch {
      // A corrupted or hand-edited key is replaced rather than trusted; the
      // alternative is a device that cannot prove its identity and cannot be
      // revoked either.
    }
  }
  const key = generateDeviceKey();
  const updated = await write({ ...config, deviceKey: encodeDeviceKey(key) });
  return { config: updated, key };
}

/** The signed-in account, but only if it belongs to the broker being used. */
export async function getAccount(apiBase: string): Promise<Account | null> {
  const account = (await load()).account;
  if (!account) return null;
  return account.apiBase === apiBase ? account : null;
}

export async function setAccount(account: Account): Promise<Config> {
  return write({ ...(await load()), account });
}

export async function clearAccount(): Promise<Config> {
  const { account: _discarded, ...rest } = await load();
  return write(rest as Config);
}

export async function setServerName(name: string): Promise<Config> {
  return write({ ...(await load()), serverName: name });
}

export async function listPeers(): Promise<PeerRecord[]> {
  return (await load()).peers ?? [];
}

export async function addPeer(peer: PeerRecord): Promise<Config> {
  const config = await load();
  const peers = (config.peers ?? []).filter(
    (p) => p.deviceId !== peer.deviceId,
  );
  peers.push(peer);
  return write({ ...config, peers });
}

/** Returns false when no such peer was paired. */
export async function removePeer(deviceId: string): Promise<boolean> {
  const config = await load();
  const peers = config.peers ?? [];
  const remaining = peers.filter((p) => p.deviceId !== deviceId);
  if (remaining.length === peers.length) return false;
  await write({ ...config, peers: remaining });
  return true;
}

export async function touchPeer(
  deviceId: string,
  at = Date.now(),
): Promise<void> {
  const config = await load();
  const peers = config.peers ?? [];
  const peer = peers.find((p) => p.deviceId === deviceId);
  if (!peer) return;
  peer.lastSeenAt = at;
  await write({ ...config, peers });
}

/** Device keys idle for this long are treated as stale by `mtmux devices`. */
export const PEER_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

export function isPeerExpired(peer: PeerRecord, now = Date.now()): boolean {
  return now - peer.lastSeenAt > PEER_EXPIRY_MS;
}
