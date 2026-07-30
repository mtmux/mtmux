import { expect, test, type Page } from "@playwright/test";

/**
 * The design system, rendered.
 *
 * The numeric half of this is already covered, and better, by
 * `src/lib/theme-contrast.test.ts` — it parses the tokens and does the WCAG
 * maths in the fast suite, with a message naming the exact failing pair. What
 * only a browser can show is that the tokens *arrive*: that the class the theme
 * toggle sets actually flips them, that the fonts resolve to the faces the port
 * chose rather than a fallback, and that a page laid out at 390 px does not
 * scroll sideways.
 */

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

async function cold(page: Page) {
  await page.goto("/start");
  await page.evaluate(() => {
    indexedDB.deleteDatabase("mtmux");
    localStorage.clear();
    sessionStorage.clear();
  });
}

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.evaluate((s) => {
    localStorage.setItem("theme", s);
    document.documentElement.classList.toggle("dark", s === "dark");
  }, scheme);
}

function tokenValue(page: Page, name: string) {
  return page.evaluate(
    (n) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

test.describe("the token layer", () => {
  test.beforeEach(async ({ page }) => cold(page));

  test("dark is the default for someone with no preference", async ({
    page,
  }) => {
    // A terminal. The dark scheme is what the site shows and what a shell looks
    // like; light is fully supported and one tap away.
    await page.goto("/start");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.classList.contains("dark"),
        ),
      )
      .toBe(true);
  });

  test("the two schemes really are different values", async ({ page }) => {
    await page.goto("/start");

    await setScheme(page, "dark");
    const darkBg = await tokenValue(page, "--surface-base");
    const darkBrand = await tokenValue(page, "--brand");

    await setScheme(page, "light");
    const lightBg = await tokenValue(page, "--surface-base");
    const lightBrand = await tokenValue(page, "--brand");

    expect(darkBg).not.toBe(lightBg);
    // The hazard, asserted where it would actually bite: if these ever match,
    // light mode has adopted the site's L=0.86 green as text and is 1.39:1.
    expect(darkBrand).not.toBe(lightBrand);
  });

  test("the shadcn aliases resolve to the ported tokens", async ({ page }) => {
    await page.goto("/start");
    // Aliased rather than given values of their own, so the two systems cannot
    // drift into two palettes that nearly match.
    expect(await tokenValue(page, "--background")).toBe(
      await tokenValue(page, "--surface-base"),
    );
    expect(await tokenValue(page, "--primary")).toBe(
      await tokenValue(page, "--brand"),
    );
    expect(await tokenValue(page, "--border")).toBe(
      await tokenValue(page, "--line"),
    );
  });

  test("the ported faces are the ones actually used", async ({ page }) => {
    await page.goto("/start");
    const body = await page.evaluate(
      () => getComputedStyle(document.body).fontFamily,
    );
    // next/font emits a hashed family name — `__IBM_Plex_Sans_a1b2c3` — so the
    // separator is an underscore in dev and a space in nothing. Match both.
    expect(body).toMatch(/Plex[_ ]Sans/i);

    const code = page.locator("code").first();
    if (await code.count()) {
      const mono = await code.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(mono).toMatch(/Plex[_ ]Mono/i);
    }
  });

  test("the app's own z-scale survived the port", async ({ page }) => {
    await page.goto("/start");
    // The site has no equivalent, and dropping it is how the FAB ends up
    // painting over the command bar's send button again.
    expect(await tokenValue(page, "--z-modal")).toBe("50");
    expect(await tokenValue(page, "--z-fab")).toBe("30");
  });
});

test.describe("reduced motion", () => {
  test("is honoured, which it was not before", async ({ page }) => {
    await cold(page);
    // `emulateMedia` rather than `test.use({ reducedMotion })`: the fixture is
    // applied at context creation and this project overrides `use` wholesale,
    // so setting it here is the version-independent way to be sure the query
    // actually matches — which the guard below then proves.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/start");

    // The app had no `prefers-reduced-motion` block at all, on a surface with a
    // blinking cursor, a spinning reconnect indicator and a pulsing status dot.
    const observed = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "animate-pulse";
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const result = {
        matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
        // Parsed, not compared as a string: the browser serialises the 0.01ms
        // override as "1e-05s", which no sensible regex catches by accident.
        animationSeconds: Number.parseFloat(style.animationDuration),
      };
      probe.remove();
      return result;
    });

    // Guard the guard: if the emulation is not in effect the assertion below
    // would pass for the wrong reason on a page with no animation at all.
    expect(observed.matches).toBe(true);
    expect(observed.animationSeconds).toBeLessThan(0.001);
  });
});

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.name} (${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const scheme of ["light", "dark"] as const) {
      test(`/start does not scroll sideways in ${scheme}`, async ({ page }) => {
        await cold(page);
        await setScheme(page, scheme);
        await page.goto("/start");

        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        // A page body that scrolls horizontally is a layout bug on a phone and
        // an embarrassment on a desktop.
        expect(overflow).toBeLessThanOrEqual(1);
      });
    }
  });
}
