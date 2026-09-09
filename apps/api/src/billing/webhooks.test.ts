import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { subscriptions } from "@repo/db";

import { startHarness, type Harness } from "../accounts/testing.js";
import { planForStatus } from "./subscriptions.js";

const WEBHOOK_PATH = "/api/auth/dodopayments/webhooks";
const PRODUCT = "pdt_test_pro_monthly";

/** A key in Dodo's own format: `whsec_` plus base64. */
const SECRET_BYTES = crypto.randomBytes(24);
const WEBHOOK_KEY = `whsec_${SECRET_BYTES.toString("base64")}`;

const ENV = {
  DODO_PAYMENTS_API_KEY: "test_key_never_dialled",
  DODO_WEBHOOK_KEY: WEBHOOK_KEY,
  DODO_PRODUCT_PRO_MONTHLY: PRODUCT,
};

/**
 * Sign a body exactly as Dodo does.
 *
 * The `whsec_` prefix is stripped and the remainder base64-*decoded* to get
 * the HMAC key — signing with the printable string instead is the mistake this
 * fixture exists to rule out. The signed message is `id.timestamp.body`, and
 * the header carries space-separated `v1,<sig>` pairs.
 */
function sign(id: string, body: string, at = Date.now()) {
  const timestamp = Math.floor(at / 1000);
  const mac = crypto
    .createHmac("sha256", SECRET_BYTES)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${mac}`,
    "Content-Type": "application/json",
  };
}

function subscriptionEvent(
  type: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    business_id: "biz_test",
    type,
    timestamp: new Date().toISOString(),
    data: {
      payload_type: "Subscription",
      addons: [],
      billing: {
        city: "London",
        country: "GB",
        state: "London",
        street: "1 Way",
        zipcode: "E1",
      },
      brand_id: "brd_test",
      cancel_at_next_billing_date: false,
      created_at: "2026-07-01T00:00:00Z",
      credit_entitlement_cart: [],
      currency: "USD",
      customer: {
        customer_id: "cus_test",
        email: "payer@example.com",
        name: "Payer",
      },
      metadata: {},
      meter_credit_entitlement_cart: [],
      meters: [],
      next_billing_date: "2026-08-01T00:00:00Z",
      on_demand: false,
      payment_frequency_count: 1,
      payment_frequency_interval: "Month",
      previous_billing_date: "2026-07-01T00:00:00Z",
      product_id: PRODUCT,
      quantity: 1,
      recurring_pre_tax_amount: 1000,
      status,
      subscription_id: "sub_test",
      subscription_period_count: 1,
      subscription_period_interval: "Month",
      tax_inclusive: false,
      trial_period_days: 0,
      ...overrides,
    },
  };
}

async function deliver(
  h: Harness,
  event: unknown,
  id: string,
  headerOverrides: Record<string, string> = {},
) {
  const body = JSON.stringify(event);
  return h.request(WEBHOOK_PATH, {
    method: "POST",
    headers: { ...sign(id, body), ...headerOverrides },
    body,
  });
}

async function planOf(h: Harness, userId: string) {
  const rows = await h.db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
  return rows[0];
}

describe("dodo webhooks", () => {
  it("puts the account on Pro and mirrors the subscription", async () => {
    const h = await startHarness(ENV);
    try {
      const { id: userId } = await h.signUp("payer@example.com");
      const event = subscriptionEvent("subscription.active", "active");
      event.data.metadata = { userId };

      const res = await deliver(h, event, "evt_1");
      expect(res.status).toBe(200);

      const row = await planOf(h, userId);
      expect(row).toMatchObject({
        plan: "pro",
        status: "active",
        dodoSubscriptionId: "sub_test",
        dodoCustomerId: "cus_test",
        productId: PRODUCT,
      });

      // And it is visible where it matters — the entitlement check itself.
      expect(await h.accounts.checkTunnel(userId)).toEqual({ allowed: true });
    } finally {
      await h.close();
    }
  });

  /**
   * The failure that actually matters.
   *
   * Dodo retries up to eight times, so a cancellation delivered slowly can be
   * replayed after the customer has already re-subscribed. Processing it twice
   * would downgrade someone who is paying.
   */
  it("ignores a replayed delivery", async () => {
    const h = await startHarness(ENV);
    try {
      const { id: userId } = await h.signUp("replay@example.com");

      const cancelled = subscriptionEvent(
        "subscription.cancelled",
        "cancelled",
      );
      cancelled.data.metadata = { userId };
      expect((await deliver(h, cancelled, "evt_cancel")).status).toBe(200);
      expect((await planOf(h, userId))?.plan).toBe("free");

      // They come back.
      const resubscribed = subscriptionEvent("subscription.active", "active");
      resubscribed.data.metadata = { userId };
      await deliver(h, resubscribed, "evt_active");
      expect((await planOf(h, userId))?.plan).toBe("pro");

      // Dodo retries the cancellation. Same id, so it must not be applied.
      const replay = await deliver(h, cancelled, "evt_cancel");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ duplicate: true });
      expect((await planOf(h, userId))?.plan).toBe("pro");
    } finally {
      await h.close();
    }
  });

  it("rejects a forged signature and does not burn the delivery id", async () => {
    const h = await startHarness(ENV);
    try {
      const { id: userId } = await h.signUp("forged@example.com");
      const event = subscriptionEvent("subscription.active", "active");
      event.data.metadata = { userId };

      const forged = await deliver(h, event, "evt_forged", {
        "webhook-signature": "v1,ZGVmaW5pdGVseSBub3QgYSBzaWduYXR1cmU=",
      });
      expect(forged.status).toBe(400);
      expect(await planOf(h, userId)).toBeUndefined();

      // The claim taken before verification has to be released, or Dodo's
      // retry of a delivery that failed for an unrelated reason would be
      // silently dropped as a duplicate.
      const genuine = await deliver(h, event, "evt_forged");
      expect(genuine.status).toBe(200);
      expect((await planOf(h, userId))?.plan).toBe("pro");
    } finally {
      await h.close();
    }
  });

  /**
   * Cancelling at the end of a period, which is not a cancellation event.
   *
   * Dodo leaves the subscription `active` and flips
   * `cancel_at_next_billing_date`; the delivery is `subscription.updated`.
   * Before this was handled, the flag never reached the mirror, so someone who
   * cancelled kept being told "Renews on …" until the day it stopped — and the
   * panel's "Ending" badge was unreachable code.
   */
  it("mirrors a cancellation scheduled for the end of the period", async () => {
    const h = await startHarness(ENV);
    try {
      const { id: userId } = await h.signUp("scheduled@example.com");

      const active = subscriptionEvent("subscription.active", "active");
      active.data.metadata = { userId };
      expect((await deliver(h, active, "evt_a")).status).toBe(200);
      expect((await planOf(h, userId))?.cancelAtPeriodEnd).toBe(false);

      const scheduled = subscriptionEvent("subscription.updated", "active", {
        cancel_at_next_billing_date: true,
      });
      scheduled.data.metadata = { userId };
      expect((await deliver(h, scheduled, "evt_b")).status).toBe(200);

      const row = await planOf(h, userId);
      // Still Pro — they paid for the rest of the period — but now visibly
      // ending, which is the whole difference the UI renders.
      expect(row).toMatchObject({
        plan: "pro",
        status: "active",
        cancelAtPeriodEnd: true,
      });
    } finally {
      await h.close();
    }
  });

  it("rejects a delivery with no webhook-id", async () => {
    const h = await startHarness(ENV);
    try {
      const body = JSON.stringify(
        subscriptionEvent("subscription.active", "active"),
      );
      const res = await h.request(WEBHOOK_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it("acknowledges an event for a customer it has never heard of", async () => {
    const h = await startHarness(ENV);
    try {
      // No local account, no metadata. Retrying this forever helps nobody.
      const res = await deliver(
        h,
        subscriptionEvent("subscription.active", "active"),
        "evt_stranger",
      );
      expect(res.status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe("status to plan", () => {
  it("grants the product's plan while active", () => {
    expect(planForStatus("active", "pro")).toBe("pro");
  });

  it("keeps the plan on hold, because a failed card is not a cancellation", () => {
    expect(planForStatus("on_hold", "pro")).toBe("pro");
  });

  it("grants nothing for a pending, cancelled, failed or expired subscription", () => {
    for (const status of ["pending", "cancelled", "failed", "expired"]) {
      expect(planForStatus(status, "pro")).toBe("free");
    }
  });

  it("grants nothing for a product nobody wired up", () => {
    expect(planForStatus("active", null)).toBe("free");
  });
});
