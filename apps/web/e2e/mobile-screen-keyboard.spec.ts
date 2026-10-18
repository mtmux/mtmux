import { test, expect, type Page } from "@playwright/test";

import { MIN_TAP_PX } from "./tap-target";

/**
 * The app's own keyboard and the cursor pad, as chrome.
 *
 * Everything asserted here is true with the socket down, which is why it is
 * here rather than in the lab: the board's layout, its latches, the labels
 * that change when a modifier is armed, and the footer rearranging itself
 * around it are all local. What the keys actually *send* needs real tmux, and
 * that is `e2e/lab/screen-keyboard.spec.ts`.
 *
 * Same seeding as the other mobile specs: a token gets the terminal shell on
 * screen, the socket then fails against a relay that is not running, and the
 * difference between what needs it and what does not is part of what is under
 * test.
 */

const TOKEN = process.env.E2E_RELAY_TOKEN ?? "dev-token";

async function openTerminal(page: Page) {
  await page.addInitScript((token: string) => {
    localStorage.setItem("mtmux-token", token);
    localStorage.setItem("mtmux-last-session", "work");
  }, TOKEN);
  await page.goto("/");
}

async function showKeyboard(page: Page) {
  const toggle = page.getByRole("button", {
    name: "Show the on-screen keyboard",
  });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const board = page.locator("[data-screen-keyboard]");
  await expect(board).toBeVisible();
  return board;
}

test.describe("the on-screen keyboard", { tag: "@phone-only" }, () => {
  /*
   * The toggle is pinned outside the scrolling strip, and that is the whole
   * reason it is reachable: a control that opens the only keyboard able to
   * send Ctrl must not be something you have to discover a sideways swipe to
   * find.
   */
  test("opens from a pinned button, and closes from its own", async ({
    page,
  }) => {
    await openTerminal(page);

    const toggle = page.getByRole("button", {
      name: "Show the on-screen keyboard",
    });
    const box = (await toggle.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_PX);
    expect(box.x, "the keyboard toggle has scrolled off the edge").toBeLessThan(
      MIN_TAP_PX * 2,
    );

    const board = await showKeyboard(page);
    await expect(toggle).toHaveCount(0);

    await page.locator("[data-keyboard-hide]").click();
    await expect(board).toHaveCount(0);
    await expect(toggle).toBeVisible();
  });

  /*
   * Two text-entry surfaces an inch apart, one of which raises a *second*
   * keyboard over the first, is the state this hides. The command bar's job —
   * compose a line, send it — is the platform keyboard's workaround, and the
   * board types straight into the pty.
   */
  test("takes the command bar's place rather than stacking on it", async ({
    page,
  }) => {
    await openTerminal(page);
    const bar = page.getByLabel("Command", { exact: true });
    await expect(bar).toBeVisible();

    await showKeyboard(page);
    await expect(bar).toHaveCount(0);

    await page.locator("[data-keyboard-hide]").click();
    await expect(bar).toBeVisible();
  });

  test("holds three boards, and remembers which one across a reload", async ({
    page,
  }) => {
    await openTerminal(page);
    await showKeyboard(page);

    // The letters board is the default, and `q` is where QWERTY starts.
    await expect(page.locator('[data-key="c-q"]')).toBeVisible();

    await page.locator('[data-layer-tab="agent"]').click();
    await expect(page.locator('[data-key="esc-esc"]')).toBeVisible();
    await expect(page.locator('[data-key="c-q"]')).toHaveCount(0);

    // Persisted, because somebody driving an agent CLI lives on one board and
    // should not have to pick it again after every reload.
    await page.reload();
    await expect(page.locator('[data-key="esc-esc"]')).toBeVisible();

    await page.locator('[data-layer-tab="symbols"]').click();
    await expect(page.locator('[data-key="c-|"]')).toBeVisible();
  });

  /*
   * Three states, not two. A modifier that only toggles forces a choice
   * between clearing after one key — six taps for `Ctrl+X Ctrl+S` — and
   * latching forever, which turns a typed word into six control codes.
   */
  test("arms a modifier once, then locks it, then lets it go", async ({
    page,
  }) => {
    await openTerminal(page);
    await showKeyboard(page);

    const ctrl = page.locator('[data-key="ctrl"]');
    await expect(ctrl).toHaveAttribute("data-latch", "off");

    await ctrl.click();
    await expect(ctrl).toHaveAttribute("data-latch", "once");
    await expect(ctrl).toHaveAttribute("aria-pressed", "true");
    // The confirmation lands on the key that is about to send it, not on a
    // chip somewhere else: `q` now reads `^Q`.
    await expect(page.locator('[data-key="c-q"] [data-cap-label]')).toHaveText(
      "^Q",
    );

    await ctrl.click();
    await expect(ctrl).toHaveAttribute("data-latch", "locked");

    await ctrl.click();
    await expect(ctrl).toHaveAttribute("data-latch", "off");
    await expect(page.locator('[data-key="c-q"] [data-cap-label]')).toHaveText(
      "q",
    );
  });

  test("flips the letters to capitals under Shift", async ({ page }) => {
    await openTerminal(page);
    await showKeyboard(page);

    await page.locator('[data-key="shift"]').click();
    await expect(page.locator('[data-key="c-a"] [data-cap-label]')).toHaveText(
      "A",
    );
  });

  /*
   * A keycap under the tap-target floor is the one regression in a keyboard
   * that nobody sees in a diff and everybody feels on a phone — and the rows
   * are flex, so one cap too many silently shrinks the entire row.
   */
  test("keeps every key on the board big enough to hit", async ({ page }) => {
    await openTerminal(page);
    await showKeyboard(page);

    for (const tab of ["letters", "symbols", "agent"]) {
      await page.locator(`[data-layer-tab="${tab}"]`).click();
      const keys = page.locator("[data-screen-keyboard] [data-key]");
      const count = await keys.count();
      expect(count, `the ${tab} board is empty`).toBeGreaterThan(20);
      for (let i = 0; i < count; i++) {
        const box = (await keys.nth(i).boundingBox())!;
        const id = await keys.nth(i).getAttribute("data-key");
        expect(
          box.height,
          `${tab}/${id} is ${box.height}px tall`,
        ).toBeGreaterThanOrEqual(MIN_TAP_PX - 1);
        expect(
          box.width,
          `${tab}/${id} is ${box.width}px wide`,
        ).toBeGreaterThan(20);
      }
    }
  });

  /*
   * The whole board must fit above the fold with the terminal still visible.
   * A keyboard that covers what it is typing into is not an improvement on the
   * one the phone shipped with.
   */
  test("leaves the terminal on screen above it", async ({ page }) => {
    await openTerminal(page);
    const board = await showKeyboard(page);

    const viewport = page.viewportSize()!;
    const box = (await board.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    // Under half the screen, keyboard and toolbar together.
    expect(box.height).toBeLessThan(viewport.height * 0.45);
    expect(box.y).toBeGreaterThan(viewport.height * 0.35);
  });
});

test.describe("the cursor pad", { tag: "@phone-only" }, () => {
  test("opens from the keyboard, and floats rather than taking a row", async ({
    page,
  }) => {
    await openTerminal(page);
    const board = await showKeyboard(page);
    const boardBefore = (await board.boundingBox())!;

    await page.locator("[data-pad-toggle]").click();
    const pad = page.locator("[data-cursor-pad]");
    await expect(pad).toBeVisible();

    // Floating costs the keyboard nothing: the board is the same height and in
    // the same place it was before the pad appeared.
    const boardAfter = (await board.boundingBox())!;
    expect(boardAfter.height).toBe(boardBefore.height);
    expect(boardAfter.y).toBe(boardBefore.y);

    // And it sits above the footer, over the terminal.
    const padBox = (await pad.boundingBox())!;
    expect(padBox.y + padBox.height).toBeLessThanOrEqual(boardAfter.y + 1);
  });

  test("moves to the other hand, and stays there", async ({ page }) => {
    await openTerminal(page);
    await showKeyboard(page);
    await page.locator("[data-pad-toggle]").click();

    const pad = page.locator("[data-cursor-pad]");
    await expect(pad).toHaveAttribute("data-side", "right");
    const right = (await pad.boundingBox())!;

    await page.locator("[data-pad-flip]").click();
    await expect(pad).toHaveAttribute("data-side", "left");
    const left = (await pad.boundingBox())!;
    expect(left.x).toBeLessThan(right.x);

    // Which hand is holding the phone does not change between reloads.
    await page.reload();
    await expect(page.locator("[data-cursor-pad]")).toHaveAttribute(
      "data-side",
      "left",
    );
  });

  test("says what it is, and closes from its own button", async ({ page }) => {
    await openTerminal(page);
    await showKeyboard(page);
    await page.locator("[data-pad-toggle]").click();

    // A round control with no labels does not say what it does. The four
    // arrows and the Enter in the middle are the labels.
    await expect(page.locator("[data-pad-hint=up]")).toBeVisible();
    await expect(page.locator("[data-pad-hint=down]")).toBeVisible();
    await expect(page.locator("[data-pad-knob]")).toHaveText("⏎");
    await expect(
      page.getByRole("application", { name: /Cursor pad/ }),
    ).toBeVisible();

    await page.locator("[data-pad-close]").click();
    await expect(page.locator("[data-cursor-pad]")).toHaveCount(0);
  });
});
