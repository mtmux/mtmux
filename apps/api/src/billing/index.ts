/**
 * Billing: checkout, the customer portal, and the plan/usage read.
 *
 * The checkout is created with the Dodo SDK directly rather than through the
 * better-auth plugin's `/dodopayments/checkout` endpoint, for one concrete
 * reason: that endpoint requires a complete billing address in the request
 * body. `mtmux upgrade` runs in a terminal on a server and has no business
 * asking anyone for their street — Dodo's own hosted checkout collects it,
 * along with the tax treatment that depends on it. The plugin is still
 * mounted, because it owns the verified webhook endpoint.
 */
import {
  dodopayments,
  checkout,
  portal,
  webhooks,
} from "@dodopayments/better-auth";
import { z } from "zod";
import { createLogger } from "@repo/logger";
import { PRICING, type PlanId } from "@repo/config/plans";
import type { Db } from "@repo/db";

import type { AccountsConfig } from "../accounts/config.js";
import type { Entitlements } from "../entitlements.js";
import { createDodoClient, productIdFor, type DodoClient } from "./dodo.js";
import { readSubscription } from "./subscriptions.js";
import { createWebhookHandlers } from "./webhooks.js";

const logger = createLogger("api:billing");

export { claimDelivery, releaseDelivery } from "./webhooks.js";

export const CheckoutRequest = z.object({
  plan: z.literal("pro").default("pro"),
  interval: z.enum(["monthly", "yearly"]).default("monthly"),
});

export type CheckoutOutcome =
  | { kind: "ok"; url: string }
  | { kind: "unavailable"; reason: string };

export type Billing = {
  /** The better-auth plugin, or null when no payment provider is configured. */
  plugin: ReturnType<typeof dodopayments> | null;
  checkout(
    user: {
      id: string;
      email: string;
      name: string;
      customerId: string | null;
    },
    request: z.infer<typeof CheckoutRequest>,
  ): Promise<CheckoutOutcome>;
  portal(customerId: string | null): Promise<CheckoutOutcome>;
  summary(userId: string): Promise<Record<string, unknown>>;
};

export function createBilling(
  db: Db,
  config: AccountsConfig,
  entitlements: Entitlements,
): Billing {
  const client = createDodoClient(config);

  return {
    plugin: client ? buildPlugin(client, db, config) : null,

    async checkout(user, request) {
      if (!client || !config.billingEnabled) {
        return { kind: "unavailable", reason: "Billing is not configured." };
      }

      const productId = productIdFor(config, request.plan, request.interval);
      if (!productId) {
        return {
          kind: "unavailable",
          reason: `The ${request.interval} plan is not available.`,
        };
      }

      const session = await client.checkoutSessions.create({
        product_cart: [{ product_id: productId, quantity: 1 }],
        // Attaching an existing customer keeps one person's payments on one
        // Dodo customer across upgrades, which is what makes the portal show
        // them their whole history.
        customer: user.customerId
          ? { customer_id: user.customerId }
          : { email: user.email, name: user.name },
        // The webhook's most reliable route back to an account. Customer id
        // and email are fallbacks; this is set on every checkout we create.
        metadata: { userId: user.id },
        return_url: `${config.upgradeUrl}?checkout=complete`,
      });

      const url = session.checkout_url;
      if (!url) {
        logger.error("Dodo returned a checkout session with no URL");
        return { kind: "unavailable", reason: "Checkout is unavailable." };
      }
      return { kind: "ok", url };
    },

    async portal(customerId) {
      if (!client) {
        return { kind: "unavailable", reason: "Billing is not configured." };
      }
      if (!customerId) {
        // Nothing to manage. Sending them to checkout instead of an empty
        // portal is the useful answer, and the caller renders it as such.
        return {
          kind: "unavailable",
          reason: "This account has no billing history yet.",
        };
      }

      const session = await client.customers.customerPortal.create(customerId, {
        return_url: config.upgradeUrl,
      });
      return { kind: "ok", url: session.link };
    },

    async summary(userId) {
      const subscription = await readSubscription(db, userId);
      const usage = await entitlements.usageThisMonth(userId);
      return {
        plan: subscription.plan satisfies PlanId,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        usage,
        pricing: PRICING,
        // False for self-hosted and for any deployment without Dodo keys, so
        // the dashboard can hide an upgrade button that could not work.
        billingEnabled: config.billingEnabled,
      };
    },
  };
}

/**
 * The Dodo plugin, mounted for its side effects rather than its endpoints.
 *
 * What it is actually here for is `POST /api/auth/dodopayments/webhooks` —
 * the verified webhook endpoint — and, when explicitly enabled, creating a
 * Dodo customer at sign-up. Its checkout and portal endpoints are mounted but
 * unused; `/v1/billing/*` above is what the CLI and dashboard call.
 */
function buildPlugin(
  client: DodoClient,
  db: Db,
  config: AccountsConfig,
): ReturnType<typeof dodopayments> {
  return dodopayments({
    client,
    // See `dodoCreateCustomerOnSignUp` in accounts/config.ts: the plugin's
    // sign-up hook turns a Dodo outage into a registration outage, so this is
    // opt-in rather than the plugin's suggested default.
    createCustomerOnSignUp: config.dodoCreateCustomerOnSignUp,
    use: [
      checkout({ successUrl: `${config.upgradeUrl}?checkout=complete` }),
      portal(),
      webhooks(createWebhookHandlers(db, config)),
    ],
  });
}

export { createDodoClient, productIdFor, planForProduct } from "./dodo.js";
export type { DodoClient } from "./dodo.js";
