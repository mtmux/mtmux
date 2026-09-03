import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { expectTapTarget } from "./tap-target";

/**
 * The dashboard's correctness regressions, each pinned to the bug it fixes.
 *
 * ## Why this file seeds IndexedDB
 *
 * The other two dashboard specs stub `/v1/servers` and stop there, which covers
 * a browser that holds no keys — the new-phone case. It cannot cover the case
 * where the interesting bugs lived: a *paired* machine with sessions on it,
 * which is where Share, Forget and the session rows are. Reaching that with a
 * real pairing would need a broker, a CLI and a tmux server; instead the three
 * IndexedDB records a pairing leaves behind are written directly.
 *
 * The census cache is seeded with a recent `observedAt` on purpose. `runCensus`
 * only spends metered tunnel bytes when the cache is stale or the user pressed
 * Refresh, so a fresh cache means the probe declines, no socket is opened, and
 * the rows paint from cache — which is exactly the deterministic, offline
 * fixture these assertions want.
 */

/** `deviceIdFor` from `@repo/crypto`: the first 8 bytes of SHA-256, in hex. */
function deviceIdForPublicKey(hex: string): string {
  return createHash("sha256")
    .update(Buffer.from(hex, "hex"))
    .digest("hex")
    .slice(0, 16);
}

const PAIRED_KEY = "11".repeat(32);
const UNPAIRED_KEY = "22".repeat(32);
const PAIRED_ID = deviceIdForPublicKey(PAIRED_KEY);

const SESSIONS = [
  { id: "$1", name: "deploy-prod", windows: 2, attached: false },
  { id: "$2", name: "client-acme", windows: 1, attached: true },
];

function serversBody(online: { paired: boolean; unpaired: boolean }) {
  return {
    servers: [
      {
        id: "srv-1",
        name: "gagan@thinkpad",
        slug: "thinkpad",
        publicKey: PAIRED_KEY,
        online: online.paired,
        lastSeenAt: Date.now(),
        platform: "linux",
        cliVersion: "0.6.0",
      },
      {
        id: "srv-2",
        name: "build-box",
        slug: "build-box",
        publicKey: UNPAIRED_KEY,
        online: online.unpaired,
        lastSeenAt: Date.now() - 3_600_000,
        platform: "darwin",
        cliVersion: "0.6.0",
      },
    ],
  };
}

async function stubSession(page: Page) {
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
}

/**
 * Answer `/v1/servers` from a mutable fixture, and count the calls.
 *
 * Both halves matter. The count is how "does this page ever re-read the
 * account" is asked at all, and the mutability is how "and does the UI notice"
 * is asked without a broker.
 */
function stubServers(page: Page) {
  const state = { paired: false, unpaired: false, calls: 0 };
  void page.route("**/v1/servers", (route) => {
    state.calls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(serversBody(state)),
    });
  });
  return state;
}

/** Wipe the origin, then write the three records a completed pairing leaves. */
async function seedPairing(page: Page, options?: { observedAgoMs?: number }) {
  await page.goto("/start");
  await page.evaluate(
    async ({ deviceId, sessions, observedAgoMs }) => {
      await new Promise<void>((resolve) => {
        const del = indexedDB.deleteDatabase("mtmux");
        del.onsuccess = () => resolve();
        del.onerror = () => resolve();
        del.onblocked = () => resolve();
      });
      localStorage.clear();
      sessionStorage.clear();

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        // Version 4 and the same five stores as `session-store.ts`, so the
        // app's own `openDb()` finds the schema it expects and never upgrades.
        const open = indexedDB.open("mtmux", 4);
        open.onupgradeneeded = () => {
          for (const name of [
            "session-keys",
            "descriptors",
            "lock",
            "census",
            "machines",
          ]) {
            if (!open.result.objectStoreNames.contains(name)) {
              open.result.createObjectStore(name);
            }
          }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });

      const put = (store: string, key: string, value: unknown) =>
        new Promise<void>((resolve, reject) => {
          const t = db.transaction(store, "readwrite");
          t.objectStore(store).put(value, key);
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        });

      // Unsealed, because this device has no lock enrolled — which is what
      // `saveSessionKeys` writes in that case too.
      await put("session-keys", deviceId, {
        c2s: new Uint8Array(32),
        s2c: new Uint8Array(32),
        confirm: new Uint8Array(32),
        directToken: "e2e-direct-token",
      });
      // No candidates: `raceCandidates([])` gives up immediately, so the probe
      // never dials anything and the row settles from cache.
      await put("descriptors", deviceId, {
        descriptor: {
          deviceId,
          tunnelId: "e2e-tunnel",
          candidates: [],
          hostname: "thinkpad",
        },
        pairedAt: Date.now(),
      });
      await put("census", deviceId, {
        sessions,
        capabilities: null,
        observedAt: Date.now() - observedAgoMs,
      });
      db.close();
    },
    {
      deviceId: PAIRED_ID,
      sessions: SESSIONS,
      observedAgoMs: options?.observedAgoMs ?? 1_000,
    },
  );
}

async function openDashboard(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByText("gagan@thinkpad").first()).toBeVisible({
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// B1.1 — the machine list goes stale and nothing ever re-reads it
// ---------------------------------------------------------------------------

test.describe(
  "a machine that comes online after the page did",
  { tag: "@phone" },
  () => {
    test("Refresh re-reads the account, so Pair stops being disabled", async ({
      page,
    }) => {
      /*
       * The bug: `GET /v1/servers` was fetched once on mount and never again, so
       * `online` froze at whatever it was when the tab opened. "Pair this device"
       * is disabled on an offline machine — correctly, since the request travels
       * over the machine's own tunnel — so someone who opened the dashboard and
       * *then* ran `mtmux` on their laptop was locked out of onboarding with no
       * recovery but a hard reload. Refresh did not help: it re-ran the census
       * from a mount-time snapshot of the same frozen list.
       */
      await stubSession(page);
      const servers = stubServers(page);
      await seedPairing(page);
      await openDashboard(page);

      const pair = page.getByRole("button", { name: "Pair this device" });
      await expect(pair).toBeDisabled();
      const before = servers.calls;

      // The machine starts up.
      servers.unpaired = true;

      await page.getByRole("button", { name: "Refresh" }).click();

      await expect(pair).toBeEnabled();
      expect(
        servers.calls,
        "Refresh must re-read /v1/servers before it re-probes",
      ).toBeGreaterThan(before);
    });

    test("coming back to the tab re-reads it too", async ({ page }) => {
      // The other half of the same fix: a tab left open on the dashboard polls
      // while it is visible, and re-reads immediately on focus. Without this,
      // "press Refresh" is a recovery the user has to know about.
      await stubSession(page);
      const servers = stubServers(page);
      await seedPairing(page);
      await openDashboard(page);

      const pair = page.getByRole("button", { name: "Pair this device" });
      await expect(pair).toBeDisabled();
      const before = servers.calls;

      servers.unpaired = true;

      // The wake is debounced to 5s so an alt-tab-heavy session is not a request
      // per switch, so wait past it before asking for one.
      await page.waitForTimeout(5_500);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));

      await expect(pair).toBeEnabled();
      expect(servers.calls).toBeGreaterThan(before);
    });

    test("no census runs on the timer", async ({ page }) => {
      /*
       * The constraint that makes the poll affordable.
       *
       * `runCensus` opens one socket per machine and spends metered relay bytes;
       * `GET /v1/servers` is one cheap request. Only the second may be on a
       * timer. The census re-runs when `online` flips, which is free for a
       * machine whose cache is fresh — and never otherwise.
       *
       * Asserted through the status line, because "Checking your machines…" is
       * the observable that appears the moment a census starts. Sampled rather
       * than waited on: a census that started and finished between two polls
       * would otherwise slip through.
       */
      await stubSession(page);
      const servers = stubServers(page);
      await seedPairing(page);
      await openDashboard(page);

      await expect(page.getByText(/session[s]? across/)).toBeVisible({
        timeout: 15_000,
      });
      const before = servers.calls;

      await page.evaluate(() => {
        const w = window as unknown as { __censusSeen?: boolean };
        w.__censusSeen = false;
        setInterval(() => {
          if (document.body.innerText.includes("Checking your machines")) {
            w.__censusSeen = true;
          }
        }, 50);
      });

      // Two wakes, either side of the 5s debounce.
      await page.waitForTimeout(5_500);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(5_500);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));

      expect(
        servers.calls,
        "the machine list should have been re-read while we waited",
      ).toBeGreaterThan(before);
      expect(
        await page.evaluate(
          () => (window as unknown as { __censusSeen?: boolean }).__censusSeen,
        ),
        "a census ran on the timer — it opens a socket per machine",
      ).toBe(false);
    });

    test("a failed background refresh keeps the list it already had", async ({
      page,
    }) => {
      // The other half of "background": a poll that fails must not replace a
      // working dashboard with an error card, because the previous answer is
      // still the best information anyone has.
      await stubSession(page);
      const servers = stubServers(page);
      await seedPairing(page);
      await openDashboard(page);

      await page.unroute("**/v1/servers");
      await page.route("**/v1/servers", (route) =>
        route.fulfill({ status: 500, body: "nope" }),
      );

      await page.waitForTimeout(5_500);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));

      // Still there, and said to be possibly out of date rather than replaced.
      await expect(page.getByText("gagan@thinkpad").first()).toBeVisible();
      await expect(page.getByText("build-box").first()).toBeVisible();
      await expect(page.getByText(/may be out of date/)).toBeVisible();
      await expect(page.getByText("Couldn't load your machines")).toHaveCount(
        0,
      );
      expect(servers.calls).toBeGreaterThan(0);
    });
  },
);

// ---------------------------------------------------------------------------
// B1.2 — the share command
// ---------------------------------------------------------------------------

test.describe("the share dialog", { tag: "@phone" }, () => {
  test.beforeEach(async ({ page }) => {
    await stubSession(page);
    stubServers(page);
    await seedPairing(page);
    await openDashboard(page);
  });

  test("carries the session it was opened from", async ({ page }) => {
    /*
     * The bug: the dialog is permanently mounted with `open` as a prop, so
     * `useState(session)` captured the value `session` had on the first render
     * — `""` — and never took another. Every share anyone built from this page
     * copied `mtmux share ` to the clipboard, with a trailing space and no
     * session name.
     */
    await page
      .getByRole("button", { name: "Share deploy-prod on gagan@thinkpad" })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("tmux session")).toHaveValue("deploy-prod");
    await expect(
      dialog.getByRole("button", { name: /^Copy "mtmux share deploy-prod/ }),
    ).toBeVisible();
  });

  test("takes the next session's name, not the first one's", async ({
    page,
  }) => {
    await page
      .getByRole("button", { name: "Share deploy-prod on gagan@thinkpad" })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page
      .getByRole("button", { name: "Share client-acme on gagan@thinkpad" })
      .click();
    await expect(
      page.getByRole("dialog").getByLabel("tmux session"),
    ).toHaveValue("client-acme");
  });

  test("does not carry the last share's scope into the next one", async ({
    page,
  }) => {
    // `readOnly`, `files` and `expires` leaked across opens too, so a
    // read-write share configured once silently became the default for every
    // later one — including for a different machine.
    await page
      .getByRole("button", { name: "Share deploy-prod on gagan@thinkpad" })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "Read + write files" }).click();
    await expect(
      dialog.getByRole("button", { name: /--files rw/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page
      .getByRole("button", { name: "Share client-acme on gagan@thinkpad" })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("radio", { name: "No files" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("the segmented controls are one tab stop with arrow keys", async ({
    page,
  }) => {
    // They were three `aria-pressed` buttons: three tab stops, three toggles
    // announced with nothing tying them together, and arrow keys doing nothing.
    await page
      .getByRole("button", { name: "Share deploy-prod on gagan@thinkpad" })
      .click();
    const dialog = page.getByRole("dialog");
    const files = dialog.getByRole("radiogroup").first();
    await expect(files.getByRole("radio")).toHaveCount(3);

    await files.getByRole("radio", { name: "No files" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      files.getByRole("radio", { name: "Read files" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("End");
    await expect(
      files.getByRole("radio", { name: "Read + write files" }),
    ).toHaveAttribute("aria-checked", "true");
  });
});

// ---------------------------------------------------------------------------
// B1.3 — forgetting a machine's keys
// ---------------------------------------------------------------------------

test.describe("forgetting a machine on this device", { tag: "@phone" }, () => {
  test.beforeEach(async ({ page }) => {
    await stubSession(page);
    stubServers(page);
    await seedPairing(page);
    await openDashboard(page);
  });

  test("asks first, and takes no for an answer", async ({ page }) => {
    /*
     * The bug: this card destroyed the device's keys for a machine on a single
     * menu tap, while two other surfaces asked first. There is no server-side
     * copy of those keys — getting them back means physical access to the
     * machine, which is the one thing someone on a phone does not have.
     */
    await page
      .getByRole("button", { name: "More actions for gagan@thinkpad" })
      .click();
    await page.getByRole("menuitem", { name: /Forget on this device/ }).click();

    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(
      confirm.getByText(/Forget gagan@thinkpad on this device\?/),
    ).toBeVisible();

    await confirm.getByRole("button", { name: "Keep it" }).click();
    await expect(confirm).toHaveCount(0);

    // Still paired: the sessions are still listed.
    await expect(page.getByText("deploy-prod")).toBeVisible();
  });

  test("both views agree about the machine once it is confirmed", async ({
    page,
  }) => {
    // The card's own handler never called `refreshPaired()`, so `pairedKeys`
    // went on claiming this browser held keys it had just deleted.
    await page
      .getByRole("button", { name: "More actions for gagan@thinkpad" })
      .click();
    await page.getByRole("menuitem", { name: /Forget on this device/ }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Forget it" })
      .click();

    // The card flips to the invitation, with no reload.
    await expect(page.getByText("deploy-prod")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Pair this device" }),
    ).toHaveCount(2);
  });
});

// ---------------------------------------------------------------------------
// B1.4 / B3 — the disclosure region, tap targets and the header at 390px
// ---------------------------------------------------------------------------

test.describe("the dashboard on a phone", { tag: "@phone" }, () => {
  test.beforeEach(async ({ page }) => {
    await stubSession(page);
    stubServers(page);
    await seedPairing(page);
  });

  test("aria-controls names a region that exists, collapsed or not", async ({
    page,
  }) => {
    // It used to name the `<ul>` of sessions, which only existed while the
    // group was expanded *and* non-empty — so on a collapsed or empty machine
    // the disclosure pointed at an id that was not in the document.
    await openDashboard(page);
    // By name, not by `{ expanded: true }`. A state-matched locator stops
    // matching the moment the state it matched on changes, so the assertion
    // after the click would fail on "element not found" whatever the markup
    // did.
    const toggle = page.getByRole("button", {
      name: "gagan@thinkpad",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const id = await toggle.getAttribute("aria-controls");
    expect(id).toBeTruthy();
    await expect(page.locator(`#${id}`)).toHaveCount(1);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Still in the document, just hidden. This is the assertion that fails
    // against the old markup.
    await expect(page.locator(`#${id}`)).toHaveCount(1);
    await expect(page.locator(`#${id}`)).toBeHidden();
  });

  test("every primary control clears 44px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);

    await expectTapTarget(
      page.getByRole("button", { name: "Pair this device" }).first(),
      "Pair this device",
    );
    await expectTapTarget(
      page.getByRole("button", { name: "Open" }).first(),
      "Open",
    );
    await expectTapTarget(
      page.getByRole("button", { name: "Refresh" }),
      "Refresh",
    );
    await expectTapTarget(
      page.getByRole("button", { name: "Retry" }).first(),
      "Retry",
    );
  });

  test("the empty state carries the install commands, at 44px", async ({
    page,
  }) => {
    /*
     * Two regressions in one.
     *
     * `InstallMachine` used to live in the *management* list's empty state,
     * inside a section that was collapsed by default — so a brand-new account
     * opened the dashboard to a paragraph saying machines appear once you pair
     * one, and no instructions anywhere on the page for how. And its copy
     * button was 36px, on the very first control a new user is asked to press.
     */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.unroute("**/v1/servers");
    await page.route("**/v1/servers", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ servers: [] }),
      }),
    );
    await page.evaluate(() => {
      indexedDB.deleteDatabase("mtmux");
    });

    await page.goto("/dashboard");
    /*
     * The checklist, not "No machines here yet".
     *
     * `dashboard-body.tsx` passes an empty `emptyState` while the onboarding
     * checklist is up, deliberately — otherwise the page says "No machines here
     * yet" directly above a list of steps whose second one is how to fix that.
     * This assertion was written before the checklist existed and had been
     * asserting the absence of the thing it was really testing for: that a
     * brand-new account is shown how to install, and can copy it with a thumb.
     */
    await expect(page.getByText("Put a machine on your account")).toBeVisible({
      timeout: 15_000,
    });

    const copy = page.getByRole("button", { name: /^Copy "npm install -g / });
    await expect(copy).toBeVisible();
    await expectTapTarget(copy, "Copy install command");
    await expect(
      page.getByRole("button", { name: /^Copy "mtmux login"/ }),
    ).toBeVisible();
  });

  test("the account header fits a 390px screen", async ({ page }) => {
    // It carried a wordmark, three `px-3` links, an email and sign-out, and
    // pushed sign-out off the right edge — the one control you need when a
    // toast is telling you something went wrong with the account you are in.
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);

    const signOut = page.getByRole("button", { name: "Sign out" });
    await expect(signOut).toBeVisible();
    const box = (await signOut.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, "the page scrolls sideways at 390px").toBeLessThanOrEqual(
      0,
    );
  });

  test("a toast clears the sticky header", async ({ page }) => {
    // Toasts are top-center over a `sticky top-0` bar, so they landed squarely
    // on top of sign-out.
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);

    await page
      .getByRole("button", { name: "More actions for gagan@thinkpad" })
      .click();
    await page.getByRole("menuitem", { name: /Forget on this device/ }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Forget it" })
      .click();

    const toast = page.locator("[data-sonner-toast]").first();
    await expect(toast).toBeVisible();
    // Polled rather than measured once: sonner slides the toast in from above
    // the viewport, so a single `boundingBox()` catches it mid-animation at a
    // negative `y` that says nothing about where it lands.
    await expect
      .poll(async () => (await toast.boundingBox())?.y ?? -1, {
        message: "the toast settles over the sticky header",
        timeout: 5_000,
      })
      .toBeGreaterThanOrEqual(56);
  });
});
