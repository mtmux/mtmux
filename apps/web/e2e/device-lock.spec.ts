import { expect, test } from "@playwright/test";

/**
 * The lock, in a real browser.
 *
 * The IDB unit tests prove the crypto and the storage. What only a browser can
 * show is the property the whole design rests on: **a reload is locked**, and
 * it is locked because the master key was a module variable, not because any
 * code remembered to clear it.
 */

/**
 * Enrol a PIN and get back to the settings page.
 *
 * The dialog offers a passkey as a second factor once the PIN is set, and that
 * offer is modal — so every spec below has to answer it before it can touch
 * anything else. Declining is the right answer here: a virtual authenticator is
 * a separate concern with its own specs, and these tests are about the PIN.
 */
async function enrolPin(page: import("@playwright/test").Page, pin: string) {
  await page.getByRole("button", { name: "Set a PIN" }).click();
  await page.getByLabel("Choose a PIN").fill(pin);
  await page.getByLabel("Confirm your PIN").fill(pin);

  const declinePasskey = page.getByRole("button", { name: "Not now" });
  await declinePasskey.click({ timeout: 15_000 });

  await expect(page.getByRole("button", { name: "Lock now" })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("device lock", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    // A clean origin per spec — the lock is per-origin state.
    await page.evaluate(async () => {
      indexedDB.deleteDatabase("mtmux");
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test("a PIN survives a reload and nothing else does", async ({ page }) => {
    await page.goto("/settings");

    await page.getByRole("button", { name: "Set a PIN" }).click();
    // The recovery copy has to be readable *before* the first keystroke, not
    // in a toast afterwards — that is the whole reason it is in the dialog.
    await expect(
      page.getByText("There is no way to reset this PIN"),
    ).toBeVisible();
    await page.getByLabel("Choose a PIN").fill("123456");
    await page.getByLabel("Confirm your PIN").fill("123456");
    await page.getByRole("button", { name: "Not now" }).click({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Lock now" })).toBeVisible({
      timeout: 15_000,
    });

    await page.reload();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Locked" })).toBeVisible();

    await page.getByLabel("Enter your PIN").fill("000000");
    await expect(page.getByText("Wrong PIN")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Locked" })).toBeVisible();

    await page.getByLabel("Enter your PIN").fill("123456");
    await expect(page.getByRole("heading", { name: "Locked" })).toBeHidden();
  });

  test("erasing a locked device leaves no key material behind", async ({
    page,
  }) => {
    await page.goto("/settings");
    await enrolPin(page, "246810");

    // A typed confirmation, not `window.confirm`. This is the one
    // irreversible action in the app, and a native dialog is one stray Return
    // away from taken.
    await page.getByRole("button", { name: "Erase this device" }).click();
    await page.getByLabel("Type ERASE to confirm").fill("ERASE");
    await page
      .getByRole("button", { name: "Erase this device", exact: true })
      .last()
      .click();
    await page.waitForURL("**/start");

    const stores = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const request = indexedDB.open("mtmux");
          request.onsuccess = () => {
            const db = request.result;
            const names = Array.from(db.objectStoreNames);
            const transaction = db.transaction(names, "readonly");
            const counts = names.map(
              (name) =>
                new Promise<string>((done) => {
                  const count = transaction.objectStore(name).count();
                  count.onsuccess = () => done(`${name}:${count.result}`);
                }),
            );
            void Promise.all(counts).then(resolve);
          };
        }),
    );

    // No exception for `descriptors` any more: leaving them behind meant an
    // "erased" device still held every machine label, tunnel id and LAN
    // address it had ever paired with.
    for (const entry of stores) {
      expect(entry, `${entry} still has rows`).toMatch(/:0$/);
    }
  });

  /**
   * The security net for the hole this pass closed.
   *
   * `/settings` is a top-level route, so it sat outside the only LockGate in
   * the app. A locked device could walk straight to it and reach factor
   * removal, the erase-after-10 toggle and "Erase this device" without ever
   * passing the lock screen.
   */
  test("a locked device cannot reach settings", async ({ page }) => {
    await page.goto("/settings");
    await enrolPin(page, "135791");

    // A reload is locked, because the master key was a module variable.
    await page.reload();
    await page.goto("/settings");

    await expect(page.getByRole("heading", { name: "Locked" })).toBeVisible();
    // `exact`, because the lock screen has its own escape hatch labelled
    // "Erase this device and start over" — which is *supposed* to be here. The
    // one that must not be reachable is the settings control of the same name.
    await expect(
      page.getByRole("button", { name: "Erase this device", exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Erase this device and start over" }),
    ).toBeVisible();
    // Not one toggle: no idle timer, no lock-on-background, and crucially no
    // erase-after-10-wrong-PINs, which a locked device could otherwise switch
    // on and then deliberately trip.
    await expect(page.locator('button[role="switch"]')).toHaveCount(0);

    await page.getByLabel("Enter your PIN").fill("135791");
    await expect(page.getByRole("heading", { name: "Locked" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Lock now" })).toBeVisible();
    await expect(page.locator('button[role="switch"]').first()).toBeVisible();
  });

  /**
   * Closing the plaintext-keys hole strands anyone who forgets their PIN,
   * because the advice already on that screen — "run mtmux and pair again" —
   * now throws rather than writing keys in the clear.
   */
  test("the lock screen offers a way out", async ({ page }) => {
    await page.goto("/settings");
    await enrolPin(page, "864209");
    await page.reload();

    await expect(page.getByRole("heading", { name: "Locked" })).toBeVisible();
    await page
      .getByRole("button", { name: "Erase this device and start over" })
      .click();
    await page.getByLabel("Type ERASE to confirm").fill("ERASE");
    await page
      .getByRole("button", { name: "Erase this device", exact: true })
      .click();

    await page.waitForURL("**/start");
    // And the device really is open again, not merely redirected.
    await expect(
      page.getByRole("heading", { name: "Connect to your terminal" }),
    ).toBeVisible();
  });
});
