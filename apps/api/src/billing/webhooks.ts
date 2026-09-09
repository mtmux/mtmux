/**
 * Dodo webhooks: the only thing that moves an account onto a paid plan.
 *
 * Two properties matter more than the handlers themselves.
 *
 * **Idempotency.** Dodo retries a delivery up to eight times on any non-2xx,
 * and will occasionally re-deliver one we already acknowledged slowly. Most
 * repeats are harmless — writing "active" twice is writing "active" — but a
 * replayed `subscription.cancelled` arriving after a re-subscribe would
 * downgrade a paying customer. So every delivery is claimed by its
 * `webhook-id` before it is processed, and a second delivery of the same id is
 * acknowledged without being run.
 *
 * **Signature verification.** Handled by the plugin, which rejects anything
 * whose `webhook-signature` does not match an HMAC of
 * `${id}.${timestamp}.${body}` under the base64-decoded webhook key. That
 * check is what makes this endpoint safe to leave unauthenticated, so the
 * dedupe in front of it must never answer 200 to a delivery it has not
 * verified — see `claimDelivery`, which is only ever consulted, never trusted
 * to authorise.
 */
import type { WebhookHandlerConfig } from "@dodopayments/core/webhook";
import { eq } from "drizzle-orm";
import { webhookEvents, type Db } from "@repo/db";
import { createLogger } from "@repo/logger";

import type { AccountsConfig } from "../accounts/config.js";
import { planForProduct } from "./dodo.js";
import {
  linkCustomer,
  mirrorSubscription,
  planForStatus,
  resolveUserId,
} from "./subscriptions.js";

const logger = createLogger("api:billing");

export type ClaimResult = "claimed" | "duplicate";

/**
 * Claim a delivery id, or report that it was already claimed.
 *
 * `ON CONFLICT DO NOTHING` plus a row count, so the claim is atomic against a
 * concurrent retry rather than a read-then-write race. Claiming *before*
 * processing is deliberate: the alternative — record on success — leaves a
 * window where a slow handler is running while its retry starts a second copy,
 * which is exactly the concurrent cancellation this is meant to prevent. The
 * cost is that a delivery whose handler throws must release its claim, which
 * `release` below does.
 */
export async function claimDelivery(
  db: Db,
  id: string,
  type: string,
): Promise<ClaimResult> {
  const result = await db
    .insert(webhookEvents)
    .values({ id, type, receivedAt: new Date() })
    .onConflictDoNothing({ target: webhookEvents.id });

  const changes = (result as { changes?: number } | undefined)?.changes;
  return changes === 0 ? "duplicate" : "claimed";
}

export async function releaseDelivery(db: Db, id: string): Promise<void> {
  await db.delete(webhookEvents).where(eq(webhookEvents.id, id));
}

/**
 * The handler table handed to `@dodopayments/better-auth`'s `webhooks()`.
 *
 * Every handler is one local upsert, which is why they run inline rather than
 * being queued: the 15-second acknowledgement budget is three orders of
 * magnitude more than a SQLite write needs, and processing in the background
 * would trade a problem we do not have for the loss of the retry that a
 * non-2xx buys us.
 */
export function createWebhookHandlers(
  db: Db,
  config: AccountsConfig,
): WebhookHandlerConfig {
  /** Fold one subscription payload into the mirror. */
  async function apply(data: {
    subscription_id: string;
    product_id: string;
    status: string;
    cancel_at_next_billing_date?: boolean;
    next_billing_date?: Date | string | null;
    metadata?: Record<string, unknown> | null;
    customer: { customer_id: string; email?: string };
  }): Promise<void> {
    const userId = await resolveUserId(db, {
      metadata: data.metadata ?? null,
      customerId: data.customer.customer_id,
      email: data.customer.email ?? null,
    });

    if (!userId) {
      // Not ours. Acknowledged so Dodo stops retrying — a subscription for a
      // customer with no local account is a test event or another product on
      // the same business, and neither is a failure.
      logger.warn(
        { status: data.status },
        "Subscription webhook for an unknown customer; ignoring",
      );
      return;
    }

    const productPlan = planForProduct(config, data.product_id);
    const plan = planForStatus(data.status, productPlan);

    await linkCustomer(db, userId, data.customer.customer_id);
    await mirrorSubscription(db, {
      userId,
      status: data.status,
      plan,
      dodoCustomerId: data.customer.customer_id,
      dodoSubscriptionId: data.subscription_id,
      productId: data.product_id,
      currentPeriodEnd: data.next_billing_date
        ? new Date(data.next_billing_date)
        : null,
      cancelAtPeriodEnd: data.cancel_at_next_billing_date ?? false,
    });

    logger.info({ status: data.status, plan }, "Subscription mirrored");
  }

  return {
    webhookKey: config.dodoWebhookKey,

    onSubscriptionActive: async (payload) => apply(payload.data),
    onSubscriptionRenewed: async (payload) => apply(payload.data),
    // A failed renewal. The mirror records `on_hold`, and `planForStatus`
    // deliberately keeps the plan while Dodo's dunning runs.
    onSubscriptionOnHold: async (payload) => apply(payload.data),
    onSubscriptionCancelled: async (payload) => apply(payload.data),
    onSubscriptionExpired: async (payload) => apply(payload.data),
    onSubscriptionFailed: async (payload) => apply(payload.data),
    onSubscriptionPlanChanged: async (payload) => apply(payload.data),
    /**
     * Everything else that changes a live subscription — and in practice, the
     * one that matters most: **scheduling a cancellation.**
     *
     * Cancelling at the end of a period is not a `subscription.cancelled`
     * event; the subscription stays `active` and only
     * `cancel_at_next_billing_date` flips. Without this handler that flag never
     * reaches the mirror, so someone who cancels is shown "Renews on …" right
     * up until the day it silently stops — the panel's "Ending" badge and its
     * "Pro access continues until …" line were unreachable.
     */
    onSubscriptionUpdated: async (payload) => apply(payload.data),

    // Payments are logged but do not move entitlement on their own: the
    // subscription events are authoritative about what someone may do, and a
    // payment that succeeds without its subscription going active is a state
    // this service should not try to interpret.
    onPaymentSucceeded: async (payload) => {
      logger.info(
        { subscription: payload.data.subscription_id ?? null },
        "Payment succeeded",
      );
    },
    onPaymentFailed: async (payload) => {
      logger.warn(
        { subscription: payload.data.subscription_id ?? null },
        "Payment failed",
      );
    },
  };
}
