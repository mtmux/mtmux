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
