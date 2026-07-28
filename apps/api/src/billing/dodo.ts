/**
 * The Dodo Payments client and the product catalogue.
 *
 * Two things are deliberately not in this file: prices and limits. Prices live
 * with Dodo, because a number duplicated here would go stale silently the first
 * time someone edits a product in the dashboard; limits live in
 * `@repo/config/plans`, because entitlement is a product decision and not a
 * billing one. What is here is only the mapping from "the plan someone asked
 * for" to "the product id to charge them for".
 */
import DodoPayments from "dodopayments";
import type { PlanId } from "@repo/config/plans";

import type { AccountsConfig } from "../accounts/config.js";

export type BillingInterval = "monthly" | "yearly";

export type DodoClient = DodoPayments;

/**
 * Build the SDK client, or null when billing is not configured.
 *
 * Null is a first-class outcome: a self-hosted broker, and every test, runs
 * with no payment provider at all. Callers branch on it rather than getting a
 * client that throws on first use.
 */
export function createDodoClient(config: AccountsConfig): DodoClient | null {
  if (!config.dodoApiKey) return null;

  return new DodoPayments({
    bearerToken: config.dodoApiKey,
    // ⚠︎ The SDK's own default is `live_mode`. Passing this explicitly is the
    // difference between a test checkout and a real charge, so it is never
    // left to the default.
    environment: config.dodoEnvironment,
  });
}

/**
 * Product id for a plan and billing interval, or null if it is not for sale.
 *
 * `free` has no product by construction — there is nothing to charge for — and
 * the yearly product is optional, so a deployment that only sells monthly is a
 * supported configuration rather than a misconfiguration.
 */
export function productIdFor(
  config: AccountsConfig,
  plan: PlanId,
  interval: BillingInterval,
): string | null {
  if (plan !== "pro") return null;
  const id =
    interval === "yearly"
      ? config.dodoProductProYearly
      : config.dodoProductProMonthly;
  return id === "" ? null : id;
}

/**
 * Which plan a Dodo product grants.
 *
 * Webhooks name a product, not a plan, so this is the reverse lookup that turns
 * "they paid for pdt_0Nk…" into "they are on pro". An unknown product means a
 * product created in the dashboard that nobody wired up here; it grants
 * nothing, which is the safe direction — the alternative is that any product
 * in the account silently grants Pro.
 */
export function planForProduct(
  config: AccountsConfig,
  productId: string | null | undefined,
): PlanId | null {
  if (!productId) return null;
  if (
    productId === config.dodoProductProMonthly ||
    productId === config.dodoProductProYearly
  ) {
    return "pro";
  }
  return null;
}
