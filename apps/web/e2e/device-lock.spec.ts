import { expect, test } from "@playwright/test";

/**
 * The lock, in a real browser.
 *
 * The IDB unit tests prove the crypto and the storage. What only a browser can
 * show is the property the whole design rests on: **a reload is locked**, and
 * it is locked because the master key was a module variable, not because any
 * code remembered to clear it.
 */

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
    await expect(
      page.getByText("There is no way to reset this PIN"),
    ).toBeVisible();

    // The recovery copy has to be readable *before* the first keystroke, not
    // in a toast afterwards — that is the whole reason it is in the dialog.
    await page.getByLabel("Choose a PIN").fill("123456");
    await page.getByLabel("Confirm your PIN").fill("123456");

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
    await page.getByRole("button", { name: "Set a PIN" }).click();
    await page.getByLabel("Choose a PIN").fill("246810");
    await page.getByLabel("Confirm your PIN").fill("246810");
    await expect(page.getByRole("button", { name: "Lock now" })).toBeVisible({
      timeout: 15_000,
    });

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Erase this device" }).click();
    await page.waitForURL("**/login");

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

    for (const entry of stores) {
      if (entry.startsWith("descriptors")) continue;
      expect(entry, `${entry} still has rows`).toMatch(/:0$/);
    }
  });
});
