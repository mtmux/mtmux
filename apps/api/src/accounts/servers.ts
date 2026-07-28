/**
 * The server registry.
 *
 * A row here is what turns "one machine, one code" into "all my machines, one
 * dashboard". It is deliberately thin: enough to find and name a machine, and
 * nothing that would let anyone reach into it. Reaching in still requires the
 * sealed pairing, whose keys this database never sees.
 *
 * The identity of a row is the machine's Ed25519 public key, never its name.
 * That single choice is what makes a rename not create a duplicate and a
 * reinstall that kept `~/.mtmux` reattach to the same row instead of burning
 * another slot against the plan's server limit.
 */
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { servers, type Db } from "@repo/db";

export type ServerView = {
  id: string;
  name: string;
  slug: string;
  /**
   * The machine's Ed25519 identity, hex.
   *
   * Returned so the dashboard can work out, locally, whether *this* browser
   * already holds a pairing for the machine: the device id it files keys under
   * is a fingerprint of this key. The account knows a machine exists; only the
   * browser knows whether it can open one, and this is what lets the two be
   * intersected without the server learning which browsers hold which keys.
   */
  publicKey: string;
  online: boolean;
  lastSeenAt: number | null;
  platform: string | null;
  cliVersion: string | null;
};

export type RegisterInput = {
  name: string;
  publicKey: string;
  hostname?: string;
  platform?: string;
  cliVersion?: string;
};

export type RegisterOutcome =
  | { kind: "ok"; serverId: string; created: boolean }
  | { kind: "limited"; reason: string }
  | { kind: "conflict"; reason: string };

export type ServerRegistry = {
  list(userId: string, now?: number): Promise<ServerView[]>;
  register(
    userId: string,
    input: RegisterInput,
    canAddServer: () => Promise<{ allowed: boolean; reason?: string }>,
  ): Promise<RegisterOutcome>;
  /**
   * Which account a machine belongs to, by its Ed25519 key.
   *
   * The tunnel path knows a machine only by the key it signed its registration
   * with, so this is the one bridge from "a tunnel" to "an account" — and thus
   * to a plan. Null for a machine nobody has registered, which is the normal
   * state for anonymous and self-hosted use.
   */
  ownerOf(
    publicKey: string,
  ): Promise<{ userId: string; serverId: string } | null>;
  heartbeat(userId: string, serverId: string, now?: number): Promise<boolean>;
  rename(userId: string, serverId: string, name: string): Promise<boolean>;
  remove(userId: string, serverId: string): Promise<boolean>;
};

export function createServerRegistry(
  db: Db,
  onlineWindowSeconds: number,
): ServerRegistry {
  const onlineWindowMs = onlineWindowSeconds * 1000;

  async function list(userId: string, now = Date.now()): Promise<ServerView[]> {
    const rows = await db
      .select()
      .from(servers)
      .where(eq(servers.userId, userId));

    return rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        publicKey: row.publicKey,
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.getTime() : null,
        // "Online" is a heartbeat that has not gone stale, not an open socket.
        // The broker cannot know whether a CLI is reachable — the CLI dials
        // out — so recency is the only honest signal available.
        online: row.lastSeenAt
          ? now - row.lastSeenAt.getTime() < onlineWindowMs
          : false,
        platform: row.platform,
        cliVersion: row.cliVersion,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function register(
    userId: string,
    input: RegisterInput,
    canAddServer: () => Promise<{ allowed: boolean; reason?: string }>,
  ): Promise<RegisterOutcome> {
    const existing = await db
      .select()
      .from(servers)
      .where(eq(servers.publicKey, input.publicKey))
      .limit(1);
    const row = existing[0];

    if (row && row.userId !== userId) {
      // Public keys are globally unique because "which machine am I talking
      // to" has to have one answer. Silently moving the row to whoever last
      // quoted the key would make the registry claimable by anyone who has
      // seen a public key — which is, by definition, public.
      return {
        kind: "conflict",
        reason:
          "This machine is already registered to another account. Remove it " +
          "there first, or delete ~/.mtmux to give it a new identity.",
      };
    }

    if (row) {
      // A returning machine. Its details may have changed — an OS upgrade, a
      // CLI update — but its slot against the plan limit has not.
      await db
        .update(servers)
        .set({
          hostname: input.hostname ?? row.hostname,
          platform: input.platform ?? row.platform,
          cliVersion: input.cliVersion ?? row.cliVersion,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(servers.id, row.id));
      return { kind: "ok", serverId: row.id, created: false };
    }

    const decision = await canAddServer();
    if (!decision.allowed) {
      return { kind: "limited", reason: decision.reason ?? "Plan limit." };
    }

    const id = `srv_${crypto.randomBytes(12).toString("base64url")}`;
    const slug = await uniqueSlug(userId, input.name);
    await db.insert(servers).values({
      id,
      userId,
      name: input.name,
      slug,
      publicKey: input.publicKey,
      hostname: input.hostname ?? null,
      platform: input.platform ?? null,
      cliVersion: input.cliVersion ?? null,
      lastSeenAt: new Date(),
    });
    return { kind: "ok", serverId: id, created: true };
  }

  async function ownerOf(
    publicKey: string,
  ): Promise<{ userId: string; serverId: string } | null> {
    const [row] = await db
      .select({ userId: servers.userId, id: servers.id })
      .from(servers)
      .where(eq(servers.publicKey, publicKey))
      .limit(1);
    return row ? { userId: row.userId, serverId: row.id } : null;
  }

  async function heartbeat(
    userId: string,
    serverId: string,
    now = Date.now(),
  ): Promise<boolean> {
    // Scoped by user as well as id so a leaked server id cannot be used to
    // keep someone else's machine looking alive.
    const result = await db
      .update(servers)
      .set({ lastSeenAt: new Date(now) })
      .where(and(eq(servers.id, serverId), eq(servers.userId, userId)));
    return changed(result);
  }

  async function rename(
    userId: string,
    serverId: string,
    name: string,
  ): Promise<boolean> {
    const slug = await uniqueSlug(userId, name, serverId);
    const result = await db
      .update(servers)
      .set({ name, slug, updatedAt: new Date() })
      .where(and(eq(servers.id, serverId), eq(servers.userId, userId)));
    return changed(result);
  }

  async function remove(userId: string, serverId: string): Promise<boolean> {
    const result = await db
      .delete(servers)
      .where(and(eq(servers.id, serverId), eq(servers.userId, userId)));
    return changed(result);
  }

  /**
   * A URL-safe name, made unique within the account by suffixing.
   *
   * Uniqueness is enforced by an index too; this exists so that two machines
   * both called "macbook" produce `macbook` and `macbook-2` rather than an
   * insert failure the user has to interpret.
   */
  async function uniqueSlug(
    userId: string,
    name: string,
    exceptId?: string,
  ): Promise<string> {
    const base = slugify(name);
    const taken = new Set(
      (
        await db
          .select({ id: servers.id, slug: servers.slug })
          .from(servers)
          .where(eq(servers.userId, userId))
      )
        .filter((row) => row.id !== exceptId)
        .map((row) => row.slug),
    );

    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${crypto.randomBytes(3).toString("hex")}`;
  }

  return { list, register, ownerOf, heartbeat, rename, remove };
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    // Decomposition alone leaves the accent behind as its own code point,
    // which would then be replaced by a separator — "Zoë" becoming "zo-e"
    // rather than "zoe". Dropping the combining marks is what makes NFKD
    // useful here at all.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // A name of nothing but punctuation would otherwise produce an empty slug,
  // and an empty path segment is not addressable.
  return slug || "server";
}

/**
 * Whether a Drizzle write touched a row.
 *
 * better-sqlite3 reports `changes`; the typing is looser than that because the
 * same call shape is shared across dialects, so this narrows it in one place
 * rather than casting at four call sites.
 */
function changed(result: unknown): boolean {
  const changes = (result as { changes?: number } | undefined)?.changes;
  return typeof changes === "number" ? changes > 0 : true;
}
