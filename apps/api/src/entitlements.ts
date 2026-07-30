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
  exceeds,
  limitsFor,
  TRIAL_MS,
  TRIAL_PLAN,
  type PlanId,
} from "@repo/config/plans";
import { resolvePlan, type PlanResolution } from "./billing/subscriptions.js";

export type Decision = {
  allowed: boolean;
  reason?: string;
  /**
   * Set when this very call started the account's free trial.
   *
   * The caller turns it into "Started your 7-day Pro trial — no card needed."
   * It is on the decision rather than a separate query because the trial
   * starts *because of* the check, and the two must not be able to disagree.
   */
  trialStarted?: boolean;
};

const ALLOWED: Decision = { allowed: true };
const TRIAL_STARTED: Decision = { allowed: true, trialStarted: true };

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
  /** The full answer behind `planFor`: plan, why, and the trial's state. */
  resolveFor(userId: string, now?: number): Promise<PlanResolution>;
  usageThisMonth(userId: string, now?: number): Promise<MonthUsage>;
  /** May this account open another tunnel? */
  checkTunnel(userId: string | null): Promise<Decision>;
  /** May this account register another server? */
  checkServerLimit(userId: string): Promise<Decision>;
  /** May this server trust another browser? */
  checkDevice(
    userId: string,
    serverId: string,
    plan: PlanId,
  ): Promise<Decision>;
  /** May this account rename a server? */
  checkRename(userId: string, plan: PlanId): Promise<Decision>;
  /**
   * Begin the free trial, once and only once per account.
   *
   * Returns false when the account has already had one. Callers do not need to
   * check first — the write itself is the check.
   */
  startTrial(userId: string, now?: number): Promise<boolean>;
  /** How long one tunnel session may run, in minutes, or null for unbounded. */
  tunnelMinutesFor(plan: PlanId): number | null;
  recordUsage(userId: string, bytes: number, seconds: number): Promise<void>;
};

export function createEntitlements(db: Db): Entitlements {
  async function resolveFor(
    userId: string,
    now = Date.now(),
  ): Promise<PlanResolution> {
    const rows = await db
      .select({
        plan: subscriptions.plan,
        trialStartedAt: subscriptions.trialStartedAt,
        trialEndsAt: subscriptions.trialEndsAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    return resolvePlan(rows[0] ?? null, now);
  }

  async function planFor(userId: string): Promise<PlanId> {
    return (await resolveFor(userId)).plan;
  }

  /**
   * Start the trial, idempotently, in one statement.
   *
   * `setWhere` is what makes a second call a no-op rather than a fresh seven
   * days: the update only fires when `trial_started_at` is still null. Doing
   * this as read-then-write would leave a race in which two concurrent
   * refusals each grant their own trial window.
   *
   * A user with no subscriptions row yet is the common case — nobody has a row
   * until they touch billing — hence insert-with-conflict rather than update.
   */
  async function startTrial(
    userId: string,
    now = Date.now(),
  ): Promise<boolean> {
    const startedAt = new Date(now);
    const endsAt = new Date(now + TRIAL_MS);

    const result = await db
      .insert(subscriptions)
      .values({
        id: `sub_${userId}`,
        userId,
        status: "none",
        plan: "free",
        trialStartedAt: startedAt,
        trialEndsAt: endsAt,
        createdAt: startedAt,
        updatedAt: startedAt,
      })
      .onConflictDoUpdate({
        target: subscriptions.userId,
        set: {
          trialStartedAt: startedAt,
          trialEndsAt: endsAt,
          updatedAt: startedAt,
        },
        setWhere: sql`${subscriptions.trialStartedAt} is null`,
      });

    return changedRows(result) > 0;
  }

  /**
   * Turn a refusal into the start of a trial, when that is honest.
   *
   * Three conditions, all required. The check must have refused — the trial is
   * never burned on someone's first server, because free allows one and the
   * check passes. The account must never have trialled, `trial_started_at`
   * being permanent. And the same check must *pass* under the trial plan, so a
   * refusal a trial cannot fix (the monthly byte cap when they are over even
   * Pro's) does not silently consume it.
   *
   * The extra read only happens on the refusal path, so the common allowed
   * case costs exactly what it did before.
   */
  async function withTrial(
    userId: string,
    plan: PlanId,
    evaluate: (plan: PlanId) => Decision | Promise<Decision>,
    now = Date.now(),
  ): Promise<Decision> {
    const decision = await evaluate(plan);
    if (decision.allowed) return decision;
    if (plan === TRIAL_PLAN) return decision;

    const resolution = await resolveFor(userId, now);
    if (resolution.trial.status !== "none") return decision;

    const underTrial = await evaluate(TRIAL_PLAN);
    if (!underTrial.allowed) return decision;

    // Lost the race to a concurrent request that started it first: that
    // request's trial is live, so re-evaluating under it is correct and this
    // caller simply does not get to claim the announcement.
    if (!(await startTrial(userId, now))) return ALLOWED;
    return TRIAL_STARTED;
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
    // Invariant #5, and the reason this line comes before any database work:
    // an anonymous tunnel is allowed without a single query. A self-hosted
    // install has no account, and must not pay a read to be told so.
    if (!userId) return ALLOWED;

    const plan = await planFor(userId);
    return withTrial(userId, plan, async (candidate) => {
      const limits = limitsFor(candidate);
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
    });
  }

  async function checkServerLimit(userId: string): Promise<Decision> {
    const plan = await planFor(userId);
    return withTrial(userId, plan, async (candidate) => {
      const limit = limitsFor(candidate).servers;
      if (limit === null) return ALLOWED;

      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(servers)
        .where(eq(servers.userId, userId));
      const used = Number(rows[0]?.count ?? 0);

      if (!exceeds(used, limit)) return ALLOWED;
      return {
        allowed: false,
        reason: `The ${candidate} plan covers ${limit} server${limit === 1 ? "" : "s"}.`,
      };
    });
  }

  async function checkDevice(
    userId: string,
    serverId: string,
    plan: PlanId,
  ): Promise<Decision> {
    return withTrial(userId, plan, async (candidate) => {
      const limit = limitsFor(candidate).devicesPerServer;
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
        reason: `The ${candidate} plan trusts ${limit} browsers per server.`,
      };
    });
  }

  async function checkRename(userId: string, plan: PlanId): Promise<Decision> {
    return withTrial(userId, plan, (candidate) => {
      if (limitsFor(candidate).namedServers) return ALLOWED;
      return {
        allowed: false,
        reason: "Renaming a server is a Pro feature.",
      };
    });
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
    resolveFor,
    usageThisMonth,
    checkTunnel,
    checkServerLimit,
    checkDevice,
    checkRename,
    startTrial,
    tunnelMinutesFor,
    recordUsage,
  };
}

/**
 * How many rows a Drizzle write touched.
 *
 * better-sqlite3 reports `changes`; the shared cross-dialect typing is looser
 * than that. Narrowed here rather than cast at the call site — and defaulting
 * to 0, so an unrecognised result reads as "did not start a trial" rather than
 * as a spurious announcement.
 */
function changedRows(result: unknown): number {
  const changes = (result as { changes?: number } | undefined)?.changes;
  return typeof changes === "number" ? changes : 0;
}

/** For limit messages only — `5 GB`, not a precise byte count. */
function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Math.round(gib)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
