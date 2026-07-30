/**
 * The local mirror of Dodo's subscription state.
 *
 * Dodo is the source of truth for money. This table is a cache of the one
 * question the broker asks constantly — "what plan is this account on?" — so
 * that opening a tunnel is a single indexed read rather than an HTTPS round
 * trip to a payment provider. Webhooks keep it fresh; if it is ever wrong, it
 * can be rebuilt from Dodo, and Dodo wins.
 */
import { eq } from "drizzle-orm";
import { subscriptions, user, type Db } from "@repo/db";
import { DEFAULT_PLAN, TRIAL_PLAN, type PlanId } from "@repo/config/plans";

/** Dodo's own status vocabulary, stored verbatim for support questions. */
export type SubscriptionStatus =
  | "pending"
  | "active"
  | "on_hold"
  | "cancelled"
  | "failed"
  | "expired";

/**
 * Which plan a subscription in this state grants.
 *
 * `on_hold` is the interesting one: it means a renewal payment failed, and
 * Dodo is retrying. Downgrading on the first failed charge would lock someone
 * out of their own servers because a card expired, which is a support ticket
 * and a cancellation rather than a recovered payment. So on-hold keeps the
 * plan and lets Dodo's dunning run; if it never recovers the subscription
 * moves to `cancelled` or `expired` and this returns free on its own.
 *
 * A pending subscription grants nothing — the checkout has not been paid.
 */
export function planForStatus(
  status: SubscriptionStatus | string,
  productPlan: PlanId | null,
): PlanId {
  if (productPlan === null) return DEFAULT_PLAN;
  switch (status) {
    case "active":
    case "on_hold":
      return productPlan;
    default:
      return DEFAULT_PLAN;
  }
}

export type TrialStatus = "none" | "active" | "expired";

export type TrialState = {
  status: TrialStatus;
  startedAt: number | null;
  endsAt: number | null;
  /** Whole days remaining, rounded up. Zero unless the trial is active. */
  daysLeft: number;
};

export type PlanResolution = {
  plan: PlanId;
  /** Why they have that plan. The UI says "trial" differently from "paid". */
  source: "free" | "trial" | "paid";
  trial: TrialState;
};

/** The subset of a subscriptions row this resolution actually reads. */
export type ResolvableSubscription = {
  plan?: string | null;
  trialStartedAt?: Date | number | null;
  trialEndsAt?: Date | number | null;
} | null;

const NO_TRIAL: TrialState = {
  status: "none",
  startedAt: null,
  endsAt: null,
  daysLeft: 0,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What plan a row grants right now, and why.
 *
 * Pure, and deliberately so: it is the single place the trial can grant Pro,
 * it takes `now` as an argument, and it touches no database — which makes the
 * whole of trial expiry a table-driven unit test rather than a fixture.
 *
 * **Expiry needs no cron and no sweeper.** Because this resolves at read time,
 * a trial stops granting Pro the microsecond it ends, everywhere, with no job
 * to fall behind and no window in which a lapsed account still has Pro. A
 * proposed background expiry job for this is a design smell, not an
 * optimisation.
 *
 * Order is paid, then active trial, then free. Paid wins outright so that
 * someone who upgrades mid-trial is billed as a customer and reads as one,
 * rather than seeing "3 days left" next to a charge they have already paid.
 */
export function resolvePlan(
  row: ResolvableSubscription,
  now = Date.now(),
): PlanResolution {
  const paid = row?.plan === "pro";
  const startedAt = toMillis(row?.trialStartedAt);
  const endsAt = toMillis(row?.trialEndsAt);

  // `trialStartedAt` is the permanent "already used it" flag, so a trial with
  // no end date is treated as spent rather than as an unbounded one.
  const trial: TrialState =
    startedAt === null
      ? NO_TRIAL
      : {
          status: endsAt !== null && now < endsAt ? "active" : "expired",
          startedAt,
          endsAt,
          daysLeft:
            endsAt !== null && now < endsAt
              ? Math.ceil((endsAt - now) / DAY_MS)
              : 0,
        };

  if (paid) return { plan: "pro", source: "paid", trial };
  if (trial.status === "active") {
    return { plan: TRIAL_PLAN, source: "trial", trial };
  }
  return { plan: DEFAULT_PLAN, source: "free", trial };
}

function toMillis(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : value;
}

export type SubscriptionState = {
  status: string;
  /**
   * The *resolved* plan — what this account may actually do right now.
   *
   * Not `row.plan`. That column records what Dodo last told us was paid for,
   * and an account on a trial has `plan: "free"` in it while being entitled to
   * Pro. Reading the column directly was a live bug: `/v1/billing` reported
   * "free" while every entitlement check said "pro".
   */
  plan: PlanId;
  planSource: PlanResolution["source"];
  trial: TrialState;
  dodoCustomerId: string | null;
  dodoSubscriptionId: string | null;
  productId: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
};

export const FREE_STATE: SubscriptionState = {
  status: "none",
  plan: DEFAULT_PLAN,
  planSource: "free",
  trial: NO_TRIAL,
  dodoCustomerId: null,
  dodoSubscriptionId: null,
  productId: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

export async function readSubscription(
  db: Db,
  userId: string,
  now = Date.now(),
): Promise<SubscriptionState> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return FREE_STATE;

  const resolved = resolvePlan(row, now);
  return {
    status: row.status,
    plan: resolved.plan,
    planSource: resolved.source,
    trial: resolved.trial,
    dodoCustomerId: row.dodoCustomerId,
    dodoSubscriptionId: row.dodoSubscriptionId,
    productId: row.productId,
    currentPeriodEnd: row.currentPeriodEnd
      ? row.currentPeriodEnd.getTime()
      : null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}

export type MirrorInput = {
  userId: string;
  status: string;
  plan: PlanId;
  dodoCustomerId?: string | null;
  dodoSubscriptionId?: string | null;
  productId?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
};

/**
 * Write the mirror. One row per user, upserted on `user_id`.
 *
 * One row rather than a history: this table answers "what may they do right
 * now", and Dodo keeps the ledger. A second concurrent subscription for the
 * same account is not a state this product can reach — the checkout is gated
 * on the current plan — so the unique index is the right shape and would
 * surface it loudly if that ever changed.
 */
export async function mirrorSubscription(
  db: Db,
  input: MirrorInput,
): Promise<void> {
  const now = new Date();
  await db
    .insert(subscriptions)
    .values({
      id: `sub_${input.userId}`,
      userId: input.userId,
      status: input.status,
      plan: input.plan,
      dodoCustomerId: input.dodoCustomerId ?? null,
      dodoSubscriptionId: input.dodoSubscriptionId ?? null,
      productId: input.productId ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: {
        status: input.status,
        plan: input.plan,
        dodoCustomerId: input.dodoCustomerId ?? null,
        dodoSubscriptionId: input.dodoSubscriptionId ?? null,
        productId: input.productId ?? null,
        currentPeriodEnd: input.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
        updatedAt: now,
      },
    });
}

/**
 * Work out which account a webhook is about.
 *
 * Three routes, most reliable first. `metadata.userId` is set on every
 * checkout this service creates, so it is the normal path. The customer id is
 * the fallback for a subscription created elsewhere — the Dodo dashboard, a
 * support action — and email is the last resort, used only when the customer
 * id has not been linked yet.
 *
 * Returning null is fine and expected: a webhook for a customer with no local
 * account (a test event, another product on the same Dodo business) should be
 * acknowledged and ignored, not retried forever.
 */
export async function resolveUserId(
  db: Db,
  hints: {
    metadata?: Record<string, unknown> | null;
    customerId?: string | null;
    email?: string | null;
  },
): Promise<string | null> {
  const fromMetadata = hints.metadata?.userId;
  if (typeof fromMetadata === "string" && fromMetadata !== "") {
    return fromMetadata;
  }

  if (hints.customerId) {
    const rows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.dodoCustomerId, hints.customerId))
      .limit(1);
    if (rows[0]) return rows[0].id;

    const mirrored = await db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(eq(subscriptions.dodoCustomerId, hints.customerId))
      .limit(1);
    if (mirrored[0]) return mirrored[0].userId;
  }

  if (hints.email) {
    const rows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, hints.email))
      .limit(1);
    if (rows[0]) return rows[0].id;
  }

  return null;
}

/** Remember the Dodo customer id on the user, so later webhooks resolve. */
export async function linkCustomer(
  db: Db,
  userId: string,
  customerId: string,
): Promise<void> {
  await db
    .update(user)
    .set({ dodoCustomerId: customerId })
    .where(eq(user.id, userId));
}
