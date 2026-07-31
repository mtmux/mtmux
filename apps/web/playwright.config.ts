import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests, which this repo has never had.
 *
 * The unit suite covers the parts that can be reasoned about in isolation —
 * the attach state machine, the fan-out, the envelope. What it cannot reach is
 * the half of this product that only exists in a browser: a passkey ceremony, a
 * PIN survived across a reload, an OAuth redirect landing back on the right
 * page. Those are what live here.
 *
 * Deliberately **not** covered, because it cannot be: conditional-UI autofill.
 * The browser's own autofill dropdown is not scriptable — not by Playwright and
 * not by CDP — so `signIn.passkey({ autoFill: true })` goes on the manual
 * checklist in `e2e/MANUAL.md` alongside iOS Safari as a PWA, Android Chrome,
 * and macOS Safari.
 *
 * Run with `pnpm --filter @app/web e2e`. Browsers are not installed by
 * `pnpm install` — run `pnpm --filter @app/web exec playwright install chromium`
 * once.
 */

const PORT = Number(process.env.E2E_PORT ?? 14100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // One worker: every spec drives the same IndexedDB origin, and a device lock
  // is per-origin state. Parallel workers would fight over it.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      // Chromium only. The virtual authenticator these specs need is a CDP
      // feature, and CDP is Chromium's.
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile-.*\.spec\.ts/,
    },
    {
      /*
       * The phone specs.
       *
       * `Pixel 7` rather than any of the iPhone descriptors: those default to
       * WebKit, and this suite is Chromium-only for the reason above. What is
       * being asserted here — that the command bar is one line and stays one
       * line, that its font is at least 16px, that the composer fits inside the
       * visual viewport — is engine-independent enough for that to be a fair
       * trade. Real iOS behaviour stays on the manual checklist.
       */
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      testMatch: /mobile-.*\.spec\.ts/,
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm dev`,
        cwd: "../..",
        url: `${baseURL}/login`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
