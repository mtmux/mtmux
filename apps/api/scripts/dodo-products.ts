#!/usr/bin/env node
/**
 * Provision the Dodo Payments catalogue — products, and optionally the webhook
 * endpoint — for one mode at a time.
 *
 *   pnpm dodo:products -- --mode test
 *   pnpm dodo:products -- --mode test --apply
 *   pnpm dodo:products -- --mode live --apply --webhook https://api.mtmux.com/api/auth/dodopayments/webhooks
 *
 * It lives under `apps/api` rather than the repo's `scripts/` for one boring
 * reason: it imports `@repo/config/plans`, which is raw TypeScript, so it needs
 * both that workspace dependency and a TypeScript loader — and `apps/api` is
 * where both already are.
 *
 * Three properties this script is built around, each of which cost something
 * to learn:
 *
 * 1. **`--mode` is required and never defaulted.** The Dodo SDK's own default
 *    environment is `live_mode`. A script that guesses is a script that can
 *    create a real product, or charge a real card, because someone forgot a
 *    flag.
 * 2. **`--apply` is required to write.** The default is a dry run that prints
 *    the plan. A duplicate live product is a support problem, not a typo.
 * 3. **It is idempotent.** Existing products are matched by name and skipped,
 *    so re-running after a partial failure completes the job rather than
 *    doubling it.
 *
 * Prices come from `@repo/config/plans` so the catalogue cannot drift from
 * what the app charges for — invariant 7, plan limits live in exactly one
 * file, applied to the price table that sits beside them.
 *
 * The script never writes `.env`. It prints `KEY=value` lines to paste, because
 * rewriting a file full of secrets from a script is a worse failure mode than
 * a copy and paste.
 */
import DodoPayments from "dodopayments";
import type { WebhookEventType } from "dodopayments/resources/webhook-events";

import { PRICING } from "@repo/config/plans";

/** Dodo's `TimeInterval` is capitalised — `'Day' | 'Week' | 'Month' | 'Year'`. */
const MONTH = "Month" as const;
const YEAR = "Year" as const;

/**
 * The catalogue, derived rather than declared.
 *
 * `envKey` is the *suffixless* name; the mode appends `_TEST` or `_LIVE`, which
 * is the pairing `apps/api/src/accounts/config.ts` reads back.
 */
const CATALOGUE = [
  {
    envKey: "DODO_PRODUCT_PRO_MONTHLY",
    name: "mtmux Pro (monthly)",
    description:
      "mtmux Pro — unlimited machines, named machines, 200 GB of relayed traffic a month.",
    usd: PRICING.pro.monthlyUsd,
    interval: MONTH,
  },
  {
    envKey: "DODO_PRODUCT_PRO_YEARLY",
    name: "mtmux Pro (yearly)",
    description:
      "mtmux Pro, billed yearly — unlimited machines, named machines, 200 GB of relayed traffic a month.",
    usd: PRICING.pro.yearlyUsd,
    interval: YEAR,
  },
];

/**
 * The events the broker's webhook handlers actually act on.
 *
 * Kept in step with the `onSubscription*` / `onPayment*` handlers in
 * `src/billing/webhooks.ts`. Filtering rather than subscribing to everything is
 * deliberate: an unfiltered endpoint receives payout, dispute and credit events
 * this service has no handler for, and every one of them is a delivery that
 * gets stored, retried and logged for nothing.
 *
 * ⚠︎ Dodo rejects the whole `create` call with a 422 if any name is unknown —
 * there is no partial acceptance. `subscription.paused` in particular does *not*
 * exist; the pause state arrives as `subscription.on_hold`.
 */
const WEBHOOK_EVENTS: WebhookEventType[] = [
  "subscription.active",
  "subscription.renewed",
  "subscription.on_hold",
  "subscription.cancelled",
  "subscription.expired",
  "subscription.failed",
  "subscription.plan_changed",
  // A *scheduled* cancellation is not a `subscription.cancelled` — the
  // subscription stays active and only `cancel_at_next_billing_date` flips.
  // Omitting this was found by testing: cancelling left the dashboard saying
  // "Renews on …" forever.
  //
  // Dodo also emits `subscription.cancellation_scheduled`, but it is absent
  // from the SDK's `WebhookEventType` union *and* has no handler in
  // `@dodopayments/core`, so subscribing to it would deliver an event nothing
  // dispatches. `subscription.updated` carries the same flag and is handled.
  "subscription.updated",
  "payment.succeeded",
  "payment.failed",
];

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    [
      "usage: pnpm dodo:products -- --mode <test|live> [--apply] [--webhook <url>]",
      "",
      "  --mode test|live   Required. Never defaulted — the SDK's own default is live.",
      "  --apply            Actually create. Without it this is a dry run.",
      "  --webhook <url>    Also ensure a webhook endpoint exists at <url>.",
      "",
      "Reads DODO_PAYMENTS_TEST_API_KEY or DODO_PAYMENTS_LIVE_API_KEY from the",
      "environment. Prints the product ids to paste into .env; never writes it.",
    ].join("\n"),
  );
  process.exit(message ? 2 : 0);
}

type Args = { mode: "test" | "live"; apply: boolean; webhook: string | null };

function parseArgs(argv: string[]): Args {
  const out = {
    mode: null as "test" | "live" | null,
    apply: false,
    webhook: null as string | null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm run x -- --flag` forwards the separator verbatim on some pnpm
    // versions, so it is swallowed here rather than reported as unknown.
    if (arg === "--") continue;
    else if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--mode") out.mode = argv[++i] as "test" | "live";
    else if (arg === "--webhook") out.webhook = argv[++i] ?? null;
    else usage(`unknown argument: ${arg}`);
  }
  if (out.mode !== "test" && out.mode !== "live") {
    usage("--mode must be exactly 'test' or 'live'");
  }
  return out as Args;
}

/** `10` → `1000`. Dodo takes minor units; a float here would charge 10 cents. */
function minorUnits(usd: number): number {
  return Math.round(usd * 100);
}

function recurringPrice(usd: number, interval: typeof MONTH | typeof YEAR) {
  return {
    type: "recurring_price" as const,
    currency: "USD" as const,
    discount: 0,
    price: minorUnits(usd),
    purchasing_power_parity: true,
    payment_frequency_count: 1,
    payment_frequency_interval: interval,
    subscription_period_count: 1,
    subscription_period_interval: interval,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const environment = args.mode === "live" ? "live_mode" : "test_mode";
  const suffix = args.mode === "live" ? "LIVE" : "TEST";

  const bearerToken =
    args.mode === "live"
      ? process.env.DODO_PAYMENTS_LIVE_API_KEY
      : process.env.DODO_PAYMENTS_TEST_API_KEY;

  if (!bearerToken) {
    console.error(
      `error: DODO_PAYMENTS_${suffix}_API_KEY is not set.\n` +
        "It is read from the repo-root .env; run this via `pnpm dodo:products`.",
    );
    process.exit(1);
  }

  // Never left to the SDK default, which is live.
  const client = new DodoPayments({ bearerToken, environment });

  console.log(`mode:  ${environment}${args.apply ? "" : "  (DRY RUN)"}`);
  console.log(`price: $${PRICING.pro.monthlyUsd}/mo, $${PRICING.pro.yearlyUsd}/yr\n`);

  // One list call, reused for every match. `recurring: true` narrows it to the
  // subscription products; a one-time product with the same name is not a
  // collision we care about.
  const existing: Array<{ product_id: string; name?: string | null }> = [];
  for await (const product of client.products.list({ recurring: true })) {
    existing.push(product);
  }
  console.log(`found ${existing.length} existing recurring product(s)\n`);

  const resolved: Array<[string, string]> = [];
  for (const item of CATALOGUE) {
    const match = existing.find((p) => p.name === item.name);
    if (match) {
      console.log(`= ${item.name}\n  exists: ${match.product_id}`);
      resolved.push([`${item.envKey}_${suffix}`, match.product_id]);
      continue;
    }

    if (!args.apply) {
      console.log(
        `+ ${item.name}\n  would create: $${item.usd} / ${item.interval.toLowerCase()}, tax_category=saas`,
      );
      resolved.push([`${item.envKey}_${suffix}`, "<created on --apply>"]);
      continue;
    }

    const created = await client.products.create({
      name: item.name,
      description: item.description,
      tax_category: "saas",
      price: recurringPrice(item.usd, item.interval),
    });
    console.log(`+ ${item.name}\n  created: ${created.product_id}`);
    resolved.push([`${item.envKey}_${suffix}`, created.product_id]);
  }

  if (args.webhook) {
    console.log("");
    await ensureWebhook(client, args.webhook, args.apply, suffix, resolved);
  }

  console.log("\n--- paste into .env ---");
  for (const [key, value] of resolved) console.log(`${key}=${value}`);
  console.log("-----------------------");
  if (!args.apply) {
    console.log("\nDry run. Nothing was created. Re-run with --apply.");
  }
}

/**
 * Ensure a webhook endpoint exists at `url`, and surface its signing secret.
 *
 * The secret is only readable through `retrieveSecret`, and it is what
 * `DODO_WEBHOOK_KEY` must be set to. Getting this wrong produces a signature
 * mismatch on every delivery and no other symptom, so the script prints it
 * rather than leaving it to a dashboard visit.
 */
async function ensureWebhook(
  client: DodoPayments,
  url: string,
  apply: boolean,
  suffix: string,
  resolved: Array<[string, string]>,
) {
  const endpoints: Array<{
    id: string;
    url: string;
    filter_types?: string[] | null;
  }> = [];
  for await (const hook of client.webhooks.list()) endpoints.push(hook);

  const match = endpoints.find((h) => h.url === url);
  if (match) {
    console.log(`= webhook ${url}\n  exists: ${match.id}`);
    // Reconcile the filter, rather than assuming an existing endpoint is
    // correct. An endpoint created before an event was added to the handler
    // set silently never delivers it, and the only symptom is a state that
    // never updates — which is exactly how the scheduled-cancellation gap was
    // found. Idempotent means "converges on the right thing", not "skips".
    const current = new Set(match.filter_types ?? []);
    const missing = WEBHOOK_EVENTS.filter((e) => !current.has(e));
    if (missing.length > 0) {
      if (apply) {
        await client.webhooks.update(match.id, {
          filter_types: WEBHOOK_EVENTS,
        });
        console.log(`  updated filter, added: ${missing.join(", ")}`);
      } else {
        console.log(`  would add to filter: ${missing.join(", ")}`);
      }
    }
    const secret = await client.webhooks.retrieveSecret(match.id);
    resolved.push([`DODO_WEBHOOK_KEY_${suffix}`, secret.secret]);
    return;
  }

  if (!apply) {
    console.log(`+ webhook ${url}\n  would create, filtered to ${WEBHOOK_EVENTS.length} event types`);
    resolved.push([`DODO_WEBHOOK_KEY_${suffix}`, "<created on --apply>"]);
    return;
  }

  const created = await client.webhooks.create({
    url,
    description: "mtmux broker — subscription mirroring",
    filter_types: WEBHOOK_EVENTS,
  });
  console.log(`+ webhook ${url}\n  created: ${created.id}`);
  const secret = await client.webhooks.retrieveSecret(created.id);
  resolved.push([`DODO_WEBHOOK_KEY_${suffix}`, secret.secret]);
}

main().catch((error) => {
  console.error(`\nfailed: ${error?.message ?? error}`);
  if (error?.status) console.error(`status: ${error.status}`);
  process.exit(1);
});
