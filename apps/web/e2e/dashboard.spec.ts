import { expect, test, type Page } from "@playwright/test";

/**
 * The dashboard's structure.
 *
 * Every machine used to be rendered twice: `AllSessions` listed them all, and
 * `ServerList` listed them again under "Your machines", so two machines made
 * four cards. The unpaired card's CTA was an `<a href="#your-machines">` — it
 * scrolled you to the *duplicate*, to press a *second* button that did the
 * actual thing. Two taps and a scroll for one action, and no focus moved with
 * the anchor.
 *
 * Same stubbed `/v1/servers` fixture as `dashboard-unpaired.spec.ts`, because
 * what is under test is what the browser does with the answer.
 */

const SERVERS = [
  {
    id: "srv-1",
    name: "gagan@thinkpad",
    slug: "thinkpad",
    publicKey: "11".repeat(32),
    online: true,
    lastSeenAt: Date.now(),
    platform: "linux",
    // Below MIN_PAIR_CLI_VERSION: `mtmux pair` here cannot read the code this
    // app now shows, and `mtmux approve` does not exist.
    cliVersion: "0.4.0",
  },
  {
    id: "srv-2",
    name: "build-box",
    slug: "build-box",
    publicKey: "22".repeat(32),
    online: true,
    lastSeenAt: Date.now(),
    platform: "darwin",
    cliVersion: "0.6.0",
  },
];

async function stubAccount(page: Page) {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: { id: "sess-1", userId: "user-1" },
        user: { id: "user-1", email: "dp@example.com", name: "DP" },
      }),
    }),
  );
  await page.route("**/v1/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ servers: SERVERS }),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await stubAccount(page);
  await page.goto("/start");
  await page.evaluate(() => {
    indexedDB.deleteDatabase("mtmux");
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("/dashboard");
  await expect(page.getByText("gagan@thinkpad").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("shows each machine exactly once", async ({ page }) => {
  for (const server of SERVERS) {
    await expect(page.getByText(server.name, { exact: true })).toHaveCount(1);
  }
});

test("the pair button count matches the machine count", async ({ page }) => {
  // It used to be double, one per duplicated card.
  await expect(
    page.getByRole("button", { name: "Pair this device" }),
  ).toHaveCount(SERVERS.length);
});

test("the unpaired card opens the dialog without navigating", async ({
  page,
}) => {
  const before = page.url();
  await page.getByRole("button", { name: "Pair this device" }).first().click();

  await expect(page.getByRole("dialog")).toBeVisible();
  // Not a scroll to a second card, and not a route change.
  expect(page.url()).toBe(before);
});

test("management is a separate, collapsed section", async ({ page }) => {
  // "Your machines" survives as rename/remove/share, and is no longer the only
  // route to pairing — so it does not need to be open by default.
  const toggle = page.getByRole("button", { name: /Manage machines/i });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("list", { name: "Machines on this account" }),
  ).toBeVisible();
});

test("tells only the out-of-date machine to update", async ({ page }) => {
  // `cliVersion` was rendered and otherwise inert. It now gates the one thing
  // that actually depends on it: 0.4.0 cannot pair from here, 0.6.0 can.
  await expect(page.getByText(/on mtmux v0\.4\.0/)).toBeVisible();
  await expect(page.getByText(/on mtmux v0\.6\.0/)).toHaveCount(0);
});

test("each session list has an accessible name", async ({ page }) => {
  // Two session lists on one page with no names is two "list" landmarks a
  // screen reader cannot tell apart.
  const lists = page.getByRole("list");
  const count = await lists.count();
  expect(count).toBeGreaterThan(0);
  await expect(
    page.getByRole("list", { name: "Machines and their sessions" }),
  ).toBeVisible();
});
