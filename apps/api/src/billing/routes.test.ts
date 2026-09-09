import { describe, expect, it } from "vitest";

import { bearer, startHarness } from "../accounts/testing.js";
import { mirrorSubscription } from "./subscriptions.js";
import { planForProduct, productIdFor } from "./dodo.js";
import { buildAccountsConfig } from "../accounts/config.js";

describe("the billing read", () => {
  it("reports a free account with no usage", async () => {
    const h = await startHarness();
    try {
      const { token } = await h.signUp("free@example.com");
      const res = await h.request("/v1/billing", { headers: bearer(token) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        plan: "free",
        status: "none",
        cancelAtPeriodEnd: false,
        usage: { bytes: 0, seconds: 0, sessions: 0 },
        // False without Dodo keys, so the dashboard can hide an upgrade
        // button that could not possibly work.
        billingEnabled: false,
      });
    } finally {
      await h.close();
    }
  });

  it("reports a subscription and the month's usage", async () => {
    const h = await startHarness();
    try {
      const { token, id } = await h.signUp("pro@example.com");
      await mirrorSubscription(h.db, {
        userId: id,
        status: "active",
        plan: "pro",
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
      });
      await h.accounts.recordUsage(id, 4096, 120);

      const body = (await (
        await h.request("/v1/billing", { headers: bearer(token) })
      ).json()) as Record<string, unknown>;

      expect(body).toMatchObject({
        plan: "pro",
        status: "active",
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date("2026-09-01T00:00:00Z").getTime(),
        usage: { bytes: 4096, seconds: 120, sessions: 1 },
      });
    } finally {
      await h.close();
    }
  });

  it("says checkout is unavailable rather than pretending to sell", async () => {
    const h = await startHarness();
    try {
      const { token } = await h.signUp("nokeys@example.com");
      const res = await h.request("/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(token) },
        body: JSON.stringify({ plan: "pro" }),
      });
      // 503 rather than 4xx: nothing about the request was wrong.
      expect(res.status).toBe(503);
    } finally {
      await h.close();
    }
  });

  it("rejects a plan it does not sell", async () => {
    const h = await startHarness();
    try {
      const { token } = await h.signUp("weird@example.com");
      const res = await h.request("/v1/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(token) },
        body: JSON.stringify({ plan: "enterprise" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await h.close();
    }
  });
});

describe("the product catalogue", () => {
  const config = buildAccountsConfig({
    DODO_PRODUCT_PRO_MONTHLY: "pdt_monthly",
    DODO_PRODUCT_PRO_YEARLY: "pdt_yearly",
  });

  it("maps a plan and interval to a product", () => {
    expect(productIdFor(config, "pro", "monthly")).toBe("pdt_monthly");
    expect(productIdFor(config, "pro", "yearly")).toBe("pdt_yearly");
    expect(productIdFor(config, "free", "monthly")).toBeNull();
  });

  it("grants nothing for a product that was never wired up", () => {
    // A product created in the Dodo dashboard and forgotten about must not
    // silently confer Pro on whoever buys it.
    expect(planForProduct(config, "pdt_monthly")).toBe("pro");
    expect(planForProduct(config, "pdt_someone_elses")).toBeNull();
    expect(planForProduct(config, null)).toBeNull();
  });

  it("treats an unset product id as not for sale", () => {
    const bare = buildAccountsConfig({});
    expect(productIdFor(bare, "pro", "monthly")).toBeNull();
    expect(planForProduct(bare, "")).toBeNull();
  });
});

describe("choosing between test and live credentials", () => {
  // The whole point of the split: the key and both product ids move together,
  // so there is no configuration in which a live key charges against a test
  // product id or the reverse.
  const both = {
    DODO_PAYMENTS_TEST_API_KEY: "sk_test",
    DODO_PAYMENTS_LIVE_API_KEY: "sk_live",
    DODO_WEBHOOK_KEY_TEST: "whsec_test",
    DODO_WEBHOOK_KEY_LIVE: "whsec_live",
    DODO_PRODUCT_PRO_MONTHLY_TEST: "pdt_test_m",
    DODO_PRODUCT_PRO_MONTHLY_LIVE: "pdt_live_m",
    DODO_PRODUCT_PRO_YEARLY_TEST: "pdt_test_y",
    DODO_PRODUCT_PRO_YEARLY_LIVE: "pdt_live_y",
  };

  it("uses the test set by default", () => {
    const c = buildAccountsConfig(both);
    expect(c.dodoEnvironment).toBe("test_mode");
    expect(c.dodoApiKey).toBe("sk_test");
    expect(c.dodoWebhookKey).toBe("whsec_test");
    expect(productIdFor(c, "pro", "monthly")).toBe("pdt_test_m");
    expect(productIdFor(c, "pro", "yearly")).toBe("pdt_test_y");
    // …and a live product must not grant anything while in test mode.
    expect(planForProduct(c, "pdt_live_m")).toBeNull();
  });

  it("swaps the whole set on one variable", () => {
    const c = buildAccountsConfig({ ...both, DODO_ENVIRONMENT: "live_mode" });
    expect(c.dodoApiKey).toBe("sk_live");
    expect(c.dodoWebhookKey).toBe("whsec_live");
    expect(productIdFor(c, "pro", "monthly")).toBe("pdt_live_m");
    expect(planForProduct(c, "pdt_test_m")).toBeNull();
  });

  it("lets the unsuffixed variables win, so old deployments keep working", () => {
    const c = buildAccountsConfig({
      ...both,
      DODO_PAYMENTS_API_KEY: "sk_pinned",
      DODO_PRODUCT_PRO_MONTHLY: "pdt_pinned",
      DODO_ENVIRONMENT: "live_mode",
    });
    expect(c.dodoApiKey).toBe("sk_pinned");
    expect(productIdFor(c, "pro", "monthly")).toBe("pdt_pinned");
    // Unpinned values still follow the mode.
    expect(productIdFor(c, "pro", "yearly")).toBe("pdt_live_y");
  });

  it("enables billing once a mode-selected key and product exist", () => {
    expect(buildAccountsConfig({}).billingEnabled).toBe(false);
    expect(
      buildAccountsConfig({ DODO_PAYMENTS_TEST_API_KEY: "sk_test" })
        .billingEnabled,
    ).toBe(false);
    expect(buildAccountsConfig(both).billingEnabled).toBe(true);
  });
});
