#!/usr/bin/env tsx
/**
 * Deliver one correctly-signed `subscription.active` to a *running* broker, and
 * report whether it landed.
 *
 *   pnpm --filter @app/api dodo:webhook-smoke -- --user <userId>
 *   pnpm --filter @app/api dodo:webhook-smoke -- --user <userId> --url https://api.mtmux.com
 *
 * Why this exists as a script rather than only as the vitest suite in
 * `src/billing/webhooks.test.ts`: that suite proves the *handler* is correct
 * against an in-process harness. It cannot prove that the deployed process
 * mounted the plugin, that `DODO_WEBHOOK_KEY` matches the endpoint Dodo will
 * actually post to, or that a reverse proxy forwards the `webhook-*` headers.
 * Those are exactly the three things that were broken in production, and each
 * of them fails silently — Dodo retries, the customer waits, nothing logs.
 *
 * The signing is deliberately identical to the test fixture: strip `whsec_`,
 * **base64-decode the remainder**, HMAC-SHA256 over `id.timestamp.body`. Signing
 * with the printable `whsec_…` string instead is the failure mode to expect,
 * and it produces a 401 with no other clue.
 *
 * This writes a real subscription row for a real user. It is a test-mode tool;
 * it refuses to run against a live-mode key.
 */
import crypto from "node:crypto";

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    [
      "usage: pnpm --filter @app/api dodo:webhook-smoke -- --user <userId> [--url <origin>] [--product <pdt_…>]",
      "",
      "  --user <id>      Required. The account the subscription is granted to.",
      "  --url <origin>   Broker origin. Default http://127.0.0.1:24400.",
      "  --product <id>   Product to claim. Defaults to DODO_PRODUCT_PRO_MONTHLY_TEST.",
    ].join("\n"),
  );
  process.exit(message ? 2 : 0);
}

const args = { user: "", url: "http://127.0.0.1:24400", product: "" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") continue;
  else if (a === "--help" || a === "-h") usage();
  else if (a === "--user") args.user = argv[++i] ?? "";
  else if (a === "--url") args.url = (argv[++i] ?? "").replace(/\/$/, "");
  else if (a === "--product") args.product = argv[++i] ?? "";
  else usage(`unknown argument: ${a}`);
}
if (!args.user) usage("--user is required");

if (process.env.DODO_ENVIRONMENT === "live_mode") {
  console.error(
    "refusing to run: DODO_ENVIRONMENT is live_mode. This script fabricates a\n" +
      "subscription and must never be pointed at a live deployment.",
  );
  process.exit(1);
}

const secret =
  process.env.DODO_WEBHOOK_KEY_TEST || process.env.DODO_WEBHOOK_KEY || "";
if (!secret) {
  console.error("error: DODO_WEBHOOK_KEY_TEST is not set.");
  process.exit(1);
}
const product =
  args.product || process.env.DODO_PRODUCT_PRO_MONTHLY_TEST || "";
if (!product) {
  console.error("error: no product id — pass --product or set DODO_PRODUCT_PRO_MONTHLY_TEST.");
  process.exit(1);
}

/** `whsec_<base64>` → the raw key bytes. Signing the printable form never matches. */
const keyBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");

const id = `evt_smoke_${crypto.randomBytes(6).toString("hex")}`;
const now = new Date();
const event = {
  business_id: "biz_smoke",
  type: "subscription.active",
  timestamp: now.toISOString(),
  data: {
    payload_type: "Subscription",
    addons: [],
    billing: { city: "London", country: "GB", state: "London", street: "1 Way", zipcode: "E1" },
    brand_id: "brd_smoke",
    cancel_at_next_billing_date: false,
    created_at: now.toISOString(),
    credit_entitlement_cart: [],
    currency: "USD",
    customer: {
      customer_id: `cus_smoke_${args.user.slice(0, 8)}`,
      email: "smoke@example.com",
      name: "Smoke Test",
    },
    // The handler's most reliable route back to an account, and the one every
    // checkout we create sets.
    metadata: { userId: args.user },
    meter_credit_entitlement_cart: [],
    meters: [],
    next_billing_date: new Date(now.getTime() + 30 * 864e5).toISOString(),
    on_demand: false,
    payment_frequency_count: 1,
    payment_frequency_interval: "Month",
    previous_billing_date: now.toISOString(),
    product_id: product,
    quantity: 1,
    recurring_pre_tax_amount: 1000,
    status: "active",
    subscription_id: `sub_smoke_${crypto.randomBytes(4).toString("hex")}`,
    subscription_period_count: 1,
    subscription_period_interval: "Month",
    tax_inclusive: false,
    trial_period_days: 0,
  },
};

const body = JSON.stringify(event);
const timestamp = Math.floor(now.getTime() / 1000);
const mac = crypto
  .createHmac("sha256", keyBytes)
  .update(`${id}.${timestamp}.${body}`)
  .digest("base64");

const target = `${args.url}/api/auth/dodopayments/webhooks`;
console.log(`POST ${target}`);
console.log(`  event    ${id}`);
console.log(`  product  ${product}`);
console.log(`  user     ${args.user}\n`);

const res = await fetch(target, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${mac}`,
  },
  body,
});

const text = await res.text();
console.log(`→ ${res.status} ${res.statusText}`);
if (text) console.log(text.slice(0, 400));

if (res.status === 200) {
  console.log(
    "\nok. Now confirm the rows landed:\n" +
      "  sqlite3 <DATABASE_URL> 'select id, type from webhook_events order by rowid desc limit 3;'\n" +
      `  sqlite3 <DATABASE_URL> "select plan, status from subscriptions where user_id='${args.user}';"`,
  );
} else if (res.status === 401 || res.status === 400) {
  console.error(
    "\nSignature rejected. The two causes, in order of likelihood:\n" +
      "  1. DODO_WEBHOOK_KEY on the running process is not this endpoint's secret.\n" +
      "     `--env-file-if-exists` is read at process *start*, so an edited .env\n" +
      "     needs a restart, not a reload of an already-running worker.\n" +
      "  2. The key was HMAC'd as the literal `whsec_…` string rather than\n" +
      "     base64-decoded first.",
  );
  process.exit(1);
} else if (res.status === 404) {
  console.error(
    "\n404 — the better-auth Dodo plugin is not mounted, which means the process\n" +
      "resolved no API key. Check `GET /v1/billing` reports billingEnabled: true.",
  );
  process.exit(1);
} else {
  process.exit(1);
}
