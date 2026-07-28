/**
 * What an account is allowed to do, and the counters that answer it.
 *
 * The limits themselves are not here — they are in `@repo/config/plans`, one
 * table, so that "is the tunnel free?" is a diff to a pricing file rather than
 * a hunt through the broker. This module only reads counters and compares them
 * to that table.
 *
 * Two rules shape everything below:
 *
 * - **Anonymous is always allowed.** A `null` user is a self-hosted or
 *   unauthenticated install, and those must work with no database at all. Every
 *   check short-circuits to `allowed` rather than failing closed, because
 *   failing closed here would mean an accounts outage takes pairing down with
 *   it — and pairing does not need accounts.
 * - **Usage is aggregate.** `tunnelUsage` is one row per user per day. No
 *   per-connection rows, no IPs, no mailbox ids, no peers. The most granular
 *   thing this system is willing to know is "this account moved 40 MB on
 *   Tuesday", and every query here is written to keep it that way.
 */
import { and, eq, like, sql } from "drizzle-orm";
import {
  subscriptions,
  serverDevices,
  servers,
  tunnelUsage,
  type Db,
} from "@repo/db";
import {
  DEFAULT_PLAN,
  exceeds,
  limitsFor,
  type PlanId,
} from "@repo/config/plans";

export type Decision = { allowed: boolean; reason?: string };

const ALLOWED: Decision = { allowed: true };

/** UTC `YYYY-MM-DD`. Text, so a day is comparable without date arithmetic. */
export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** UTC `YYYY-MM`, the prefix every day in a billing month shares. */
export function monthKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

export type MonthUsage = {
  month: string;
  bytes: number;
  seconds: number;
  sessions: number;
};

export type Entitlements = {
  planFor(userId: string): Promise<PlanId>;
  usageThisMonth(userId: string, now?: number): Promise<MonthUsage>;
  /** May this account open another tunnel? */
  checkTunnel(userId: string | null): Promise<Decision>;
  /** May this account register another server? */
  checkServerLimit(userId: string): Promise<Decision>;
  /** May this server trust another browser? */
  checkDevice(serverId: string, plan: PlanId): Promise<Decision>;
  /** May this account rename a server? */
  checkRename(plan: PlanId): Decision;
  /** How long one tunnel session may run, in minutes, or null for unbounded. */
  tunnelMinutesFor(plan: PlanId): number | null;
  recordUsage(userId: string, bytes: number, seconds: number): Promise<void>;
};

export function createEntitlements(db: Db): Entitlements {
  async function planFor(userId: string): Promise<PlanId> {
    const rows = await db
      .select({ plan: subscriptions.plan })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    const plan = rows[0]?.plan;
    return plan === "pro" ? "pro" : DEFAULT_PLAN;
  }

  async function usageThisMonth(
    userId: string,
    now = Date.now(),
  ): Promise<MonthUsage> {
    const month = monthKey(now);
    // A prefix match on the `YYYY-MM-DD` text column. The composite
    // (user_id, day) index makes this a range scan over ~31 rows, which is why
    // the day is stored as sortable text rather than a timestamp.
    const rows = await db
      .select({
        bytes: sql<number>`coalesce(sum(${tunnelUsage.bytes}), 0)`,
        seconds: sql<number>`coalesce(sum(${tunnelUsage.seconds}), 0)`,
        sessions: sql<number>`coalesce(sum(${tunnelUsage.sessions}), 0)`,
      })
      .from(tunnelUsage)
      .where(
        and(eq(tunnelUsage.userId, userId), like(tunnelUsage.day, `${month}%`)),
      );

    const row = rows[0];
    return {
      month,
      bytes: Number(row?.bytes ?? 0),
      seconds: Number(row?.seconds ?? 0),
      sessions: Number(row?.sessions ?? 0),
    };
  }

  async function checkTunnel(userId: string | null): Promise<Decision> {
    if (!userId) return ALLOWED;

    const plan = await planFor(userId);
    const limits = limitsFor(plan);
    if (limits.monthlyBytes === null) return ALLOWED;

    const used = await usageThisMonth(userId);
    if (!exceeds(used.bytes, limits.monthlyBytes)) return ALLOWED;

    return {
      allowed: false,
      reason:
        `This account has used its ${formatBytes(limits.monthlyBytes)} of ` +
        `relayed traffic for ${used.month}. Local and LAN sessions are ` +
        `unaffected — they never touch our infrastructure.`,
    };
  }

  async function checkServerLimit(userId: string): Promise<Decision> {
    const plan = await planFor(userId);
    const limit = limitsFor(plan).servers;
    if (limit === null) return ALLOWED;

    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(servers)
      .where(eq(servers.userId, userId));
    const used = Number(rows[0]?.count ?? 0);

    if (!exceeds(used, limit)) return ALLOWED;
    return {
      allowed: false,
      reason: `The ${plan} plan covers ${limit} server${limit === 1 ? "" : "s"}.`,
    };
  }

  async function checkDevice(
    serverId: string,
    plan: PlanId,
  ): Promise<Decision> {
    const limit = limitsFor(plan).devicesPerServer;
    if (limit === null) return ALLOWED;

    // Revoked devices are excluded rather than deleted — "this phone was
    // trusted until Tuesday" is a question people ask after losing a phone,
    // and a deleted row cannot answer it. They must not count against the cap.
    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(serverDevices)
      .where(
        and(
          eq(serverDevices.serverId, serverId),
          sql`${serverDevices.revokedAt} is null`,
        ),
      );
    const used = Number(rows[0]?.count ?? 0);

    if (!exceeds(used, limit)) return ALLOWED;
    return {
      allowed: false,
      reason: `The ${plan} plan trusts ${limit} browsers per server.`,
    };
  }

  function checkRename(plan: PlanId): Decision {
    if (limitsFor(plan).namedServers) return ALLOWED;
    return {
      allowed: false,
      reason: "Renaming a server is a Pro feature.",
    };
  }

  function tunnelMinutesFor(plan: PlanId): number | null {
    return limitsFor(plan).tunnelMinutes;
  }

  /**
   * Fold one session's traffic into today's row.
   *
   * A single upsert, so concurrent tunnels closing at the same moment add
   * rather than overwrite. `sessions` counts +1 per call, which makes the
   * average session size derivable without storing a row per session.
   */
  async function recordUsage(
    userId: string,
    bytes: number,
    seconds: number,
  ): Promise<void> {
    if (bytes <= 0 && seconds <= 0) return;

    const day = dayKey();
    await db
      .insert(tunnelUsage)
      .values({
        id: `use_${userId}_${day}`,
        userId,
        day,
        bytes: Math.max(0, Math.round(bytes)),
        seconds: Math.max(0, Math.round(seconds)),
        sessions: 1,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [tunnelUsage.userId, tunnelUsage.day],
        set: {
          bytes: sql`${tunnelUsage.bytes} + excluded.bytes`,
          seconds: sql`${tunnelUsage.seconds} + excluded.seconds`,
          sessions: sql`${tunnelUsage.sessions} + 1`,
          updatedAt: new Date(),
        },
      });
  }

  return {
    planFor,
    usageThisMonth,
    checkTunnel,
    checkServerLimit,
    checkDevice,
    checkRename,
    tunnelMinutesFor,
    recordUsage,
  };
}

/** For limit messages only — `5 GB`, not a precise byte count. */
function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Math.round(gib)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
