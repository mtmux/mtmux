import crypto from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Tunnel ids that survive a broker restart.
 *
 * The browser seals the tunnel id into its connection descriptor at pairing
 * time, and there is no channel to tell it a new one — the mailbox is destroyed
 * the moment pairing succeeds. `tunnel.ts` already knew this and kept a
 * `deviceId → id` reservation so a reconnecting agent got its id back. The
 * reservation lived in a `Map`, and its own comment named "a broker restart" as
 * a case it covered. It did not: the map died with the process, so every deploy
 * minted fresh ids and silently stranded every device that had ever paired.
 * They retried a url that no longer resolved, forever, all at once.
 *
 * So the id is derived rather than remembered:
 *
 *     tnl-<base64url(HMAC-SHA256(secret, deviceId:epoch))[0..21]>
 *
 * Same device, same secret, same id — with no state to lose, no table of who
 * exists, and nothing new for a breach or a subpoena to yield. That last part
 * is why this is a derivation and not a row in SQLite: a persisted
 * `deviceId → tunnelId` table would be exactly the durable record of which
 * machines exist that the broker is built not to have.
 *
 * ## What stability costs
 *
 * A tunnel id used to rotate when a device stayed away past the reservation
 * window; now it never rotates. The bound that makes that acceptable is
 * unchanged and is not the id: `WS /v1/tunnel/:id` is deliberately
 * unauthenticated, and what protects the session is the agent's trial
 * decryption — it refuses any stream whose first frame no pairing key can open.
 * Knowing an id buys an attacker the ability to make an agent open a loopback
 * socket and then drop it, which is what `maxStreams` caps. `tunnel.ts` already
 * made ids stable across agent reconnects on that reasoning; this extends the
 * same trade across broker restarts, in exchange for sessions that stop dying
 * every time we deploy.
 *
 * Revocation still rotates an id, through the epoch — see `tunnel.ts`.
 */

const KEY_BYTES = 32;
/** 16 bytes of the HMAC, base64url — the same width the random ids had. */
const ID_CHARS = 22;

export type TunnelIdSecret = Buffer;

/**
 * Resolve the secret, in order of preference:
 *
 * 1. `API_TUNNEL_ID_SECRET`, for a deployment that would rather manage it (and
 *    the only way to make two broker processes agree).
 * 2. A 0600 file under the broker's state directory, generated on first boot.
 * 3. A process-random secret, when neither is available.
 *
 * The third case is a real fallback — a read-only filesystem, a container with
 * no writable home — and it is the *old* behaviour: ids change on restart and
 * paired browsers have to pair again. It is logged loudly rather than hidden,
 * because "everyone was signed out" deserves a line in the log that explains
 * itself.
 */
export function resolveTunnelIdSecret(options?: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  onWarn?: (message: string) => void;
}): { secret: TunnelIdSecret; source: "env" | "file" | "ephemeral" } {
  const env = options?.env ?? process.env;

  const fromEnv = env.API_TUNNEL_ID_SECRET?.trim();
  if (fromEnv) {
    // Hashed rather than used raw, so any length of passphrase is a valid key
    // and a short one is not silently a weak one.
    return {
      secret: crypto.createHash("sha256").update(fromEnv, "utf8").digest(),
      source: "env",
    };
  }

  const dir = options?.stateDir ?? defaultStateDir(env);
  const file = join(dir, "tunnel-id.key");

  try {
    const existing = readFileSync(file);
    if (existing.length >= KEY_BYTES)
      return { secret: existing, source: "file" };
  } catch {
    // Not written yet, or unreadable. Both fall through to writing one.
  }

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const secret = crypto.randomBytes(KEY_BYTES);
    // `wx` so two workers racing on first boot cannot each write a different
    // key and then disagree about every tunnel id.
    writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
    return { secret, source: "file" };
  } catch {
    // Lost the race, most likely. Read what the winner wrote.
    try {
      const existing = readFileSync(file);
      if (existing.length >= KEY_BYTES) {
        return { secret: existing, source: "file" };
      }
    } catch {
      // Genuinely cannot persist a secret here.
    }
  }

  options?.onWarn?.(
    "Tunnel ids cannot be persisted (no writable state directory). They will " +
      "change on restart, and every paired browser will have to pair again. " +
      "Set API_TUNNEL_ID_SECRET to fix this.",
  );
  return { secret: crypto.randomBytes(KEY_BYTES), source: "ephemeral" };
}

function defaultStateDir(env: NodeJS.ProcessEnv): string {
  return env.API_STATE_DIR?.trim() || join(homedir(), ".mtmux-broker");
}

/**
 * The id a device gets, every time, for as long as the secret lives.
 *
 * `epoch` is how an id is deliberately rotated: bump it and the same device
 * derives a different id, which is what revocation needs and nothing else uses.
 */
export function deriveTunnelId(
  secret: TunnelIdSecret,
  deviceId: string,
  epoch = 0,
): string {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`${deviceId}:${epoch}`, "utf8")
    .digest();
  return `tnl-${mac.toString("base64url").slice(0, ID_CHARS)}`;
}
