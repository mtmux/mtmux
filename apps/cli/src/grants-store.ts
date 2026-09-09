import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { GrantFile, GrantRecord, isGrantActive } from "@repo/protocol";

/**
 * Where `mtmux share` keeps its grants.
 *
 * **A separate file from `config.json`, on purpose.** Grants churn — one is
 * written on every share and rewritten on every revoke — while `config.json`
 * holds this machine's auth token and its Ed25519 secret key, which are
 * written once and are unrecoverable if lost. A truncated write during a
 * `share revoke` must not be able to cost someone their device identity.
 *
 * **Local-only, permanently.** These never go to the broker. A grant maps a
 * session name to a browser, and that mapping is exactly what invariant #2
 * exists to keep the broker from being able to learn. There is no version of
 * "just store them server-side for the dashboard's convenience" that is
 * compatible with the product's central claim.
 */
const DIR = process.env.MTMUX_CONFIG_DIR ?? join(homedir(), ".mtmux");
const FILE = join(DIR, "grants.json");

const EMPTY: GrantFile = { version: 1, grants: [] };

/** SHA-256 hex. The token itself is never persisted — only this. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `grn_` + 16 base32 characters, from 10 random bytes. */
export function newGrantId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = randomBytes(10);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % 32];
  // 10 bytes → 10 characters at one per byte would waste entropy, so pad from
  // a second draw rather than pretending 10 characters is 16.
  for (const byte of randomBytes(6)) out += alphabet[byte % 32];
  return `grn_${out}`;
}

export async function load(): Promise<GrantFile> {
  try {
    const raw = await readFile(FILE, "utf8");
    const parsed = GrantFile.safeParse(JSON.parse(raw));
    // A file we cannot read is treated as no grants rather than as a fatal
    // error: the alternative is a CLI that will not start because of a
    // hand-edit, and every grant it describes has already expired or not.
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * Write the file atomically, 0600.
 *
 * Temp-file-then-rename because a half-written `grants.json` is a file whose
 * every grant vanishes — and `rename` within a directory is atomic on every
 * platform this runs on.
 */
async function save(file: GrantFile): Promise<void> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, FILE);
}

export async function list(): Promise<GrantRecord[]> {
  return (await load()).grants;
}

/** Grants that can still be used right now. */
export async function active(now = Date.now()): Promise<GrantRecord[]> {
  return (await list()).filter((g) => isGrantActive(g, now));
}

export async function add(grant: GrantRecord): Promise<void> {
  const file = await load();
  await save({
    version: 1,
    grants: [...file.grants.filter((g) => g.id !== grant.id), grant],
  });
}

/**
 * Mark a grant revoked, keeping the row.
 *
 * Deleted rows cannot answer "who did I share this with, and when did I stop?"
 * — the same reasoning as revoked devices in the broker's registry. Pruning
 * happens on age, below, not on revocation.
 */
export async function revoke(
  grantId: string,
  now = Date.now(),
): Promise<boolean> {
  const file = await load();
  const target = file.grants.find((g) => g.id === grantId);
  if (!target || target.revokedAt !== null) return false;

  await save({
    version: 1,
    grants: file.grants.map((g) =>
      g.id === grantId ? { ...g, revokedAt: now } : g,
    ),
  });
  return true;
}

/** Drop grants that expired or were revoked more than `maxAgeMs` ago. */
export async function prune(
  maxAgeMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
): Promise<number> {
  const file = await load();
  const keep = file.grants.filter((g) => {
    if (isGrantActive(g, now)) return true;
    const ended = g.revokedAt ?? g.expiresAt ?? g.createdAt;
    return now - ended < maxAgeMs;
  });
  if (keep.length === file.grants.length) return 0;
  await save({ version: 1, grants: keep });
  return file.grants.length - keep.length;
}

/** The grant a token belongs to, by digest. Null when there is no live one. */
export async function findByToken(
  token: string,
  now = Date.now(),
): Promise<GrantRecord | null> {
  const hash = hashToken(token);
  const found = (await list()).find((g) => g.tokenHash === hash);
  return found && isGrantActive(found, now) ? found : null;
}

/** Test seam and `--config-dir` support. */
export function grantsFilePath(): string {
  return FILE;
}
