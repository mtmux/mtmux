import { expect, type Page } from "@playwright/test";

import { test } from "./fixtures";

/**
 * The on-screen keyboard and the cursor pad, against real tmux.
 *
 * `e2e/mobile-screen-keyboard.spec.ts` covers the board as chrome — its
 * layout, its latches, the footer rearranging around it — all of which is true
 * with the socket down. None of that is the claim that matters. The claim that
 * matters is that a tap on a keycap arrives at a pty as the right bytes, and
 * the only way to know is to ask tmux.
 *
 * ## How the bytes are read back
 *
 * `cat -v`, at a shell prompt, which does two useful things at once: it leaves
 * the tty in canonical mode, so the tty itself echoes what arrives with
 * control characters rendered as `^X` and ESC as `^[`, and `-v` makes `cat`
 * print the same when the line is submitted. So tapping ⇧Tab puts a literal
 * `^[[Z` on screen — which is CSI Z, the sequence that cycles Claude Code's
 * permission modes and that a phone has never been able to send.
 *
 * Reading the echo rather than a file is deliberate: it is end to end through
 * the same path a person's keystroke takes, and it fails loudly with the
 * wrong bytes printed in the failure message instead of a silent mismatch.
 */

const SESSION = "idle";

/** The shell's own echo of a sequence, with control characters spelled out. */
const CSI_Z = "^[[Z";

async function seedKeyboard(page: Page, opts: { pad?: boolean } = {}) {
  await page.addInitScript((pad: boolean) => {
    localStorage.setItem(
      "ccremote-settings",
      JSON.stringify({
        state: {
          screenKeyboardOpen: true,
          screenKeyboardLayer: "letters",
          cursorPadOpen: pad,
          // Off, so a run on a machine with a vibration motor does not buzz
          // for four hundred synthetic taps.
          hapticEnabled: false,
        },
        version: 2,
      }),
    );
  }, opts.pad ?? false);
}

const board = (page: Page) => page.locator("[data-screen-keyboard]");

/**
 * Wait until the pane stops changing.
 *
 * `terminal.type()` returns the moment its echo is *seen*, which is not the
 * moment the screen has finished moving: the prompt, the echo and whatever the
 * command prints arrive as separate frames. A baseline captured in the middle
 * of that is a baseline that changes on its own, which reads as "the pad sent
 * something" in a test whose whole claim is that it sent nothing.
 */
async function settle(
  page: Page,
  read: () => Promise<{ lines: string[] }>,
): Promise<string> {
  let previous = "";
  for (let i = 0; i < 20; i++) {
    const now = (await read()).lines.join("\n");
    if (i > 0 && now === previous) return now;
    previous = now;
    await page.waitForTimeout(250);
  }
  return previous;
}
const key = (page: Page, id: string) => page.locator(`[data-key="${id}"]`);

/** Tap a run of letter keys, in order. */
async function tapAll(page: Page, chars: string) {
  for (const char of chars) {
    await key(page, `c-${char}`).click();
  }
}

test.describe(
  "the on-screen keyboard, against tmux",
  { tag: "@terminal" },
  () => {
    test.beforeEach(({ isMobile }) => {
      test.skip(
        !isMobile,
        "the on-screen keyboard belongs to the touch layout, which a desktop viewport does not get",
      );
    });

    /*
     * The plainest claim there is: a letter tapped on our board reaches the
     * shell as that letter, and Enter runs the line. If this fails, nothing else
     * in the feature is worth looking at.
     */
    test("types a command, and the shell runs it", async ({ lab, page }) => {
      await seedKeyboard(page);
      const terminal = await lab.open(SESSION);
      await expect(board(page)).toBeVisible();

      await tapAll(page, "echo");
      await key(page, "space").click();
      await tapAll(page, "kbhello");
      await key(page, "enter").click();

      await terminal.waitFor(
        (snap) => snap.lines.filter((l) => l.includes("kbhello")).length >= 2,
        "the shell never echoed and ran what the board typed",
      );
    });

    /*
     * The headline.
     *
     * `KeyboardToolbar`'s own source carries the admission this fixes: its
     * sticky Ctrl "covers the keys in this row and the key sheet, only. Anything
     * typed on the soft keyboard goes straight to xterm's `onData` and never
     * passes through here, so tapping Ctrl and then typing `c` on the phone
     * keyboard sends a literal `c`."
     *
     * Every key on our board passes through `encodeKey`, so it does not have
     * that problem — and the way to prove it is to interrupt something. If the
     * latch sent a literal `c`, `sleep` would still be holding the terminal and
     * the `echo` after it would never run.
     */
    test("a latched Ctrl and a letter is a control code, not a letter", async ({
      lab,
      page,
    }) => {
      await seedKeyboard(page);
      const terminal = await lab.open(SESSION);

      await terminal.type("sleep 60\n");

      await key(page, "ctrl").click();
      await expect(key(page, "ctrl")).toHaveAttribute("data-latch", "once");
      await key(page, "c-c").click();
      // Spent by the keystroke, whether or not it found a use — which is the bug
      // the shipped toolbar's sticky latch has.
      await expect(key(page, "ctrl")).toHaveAttribute("data-latch", "off");

      await terminal.type("echo kb-interrupted\n");
      await terminal.waitFor(
        (snap) => snap.lines.some((l) => l.trim() === "kb-interrupted"),
        "Ctrl+C never reached the pty — sleep was still holding the terminal",
      );
    });

    /*
     * The same control code, without touching a modifier at all.
     *
     * Holding a letter to get its control code is the best thing about the
     * board, and it is the affordance most likely to be broken by a change to
     * the press handling — the timers are shared between the long press and the
     * key repeat, and getting that wrong sends `c` *and* `^C`, or neither.
     */
    test("holding a letter sends its control code", async ({ lab, page }) => {
      await seedKeyboard(page);
      const terminal = await lab.open(SESSION);

      await terminal.type("sleep 60\n");

      // `delay` is the gap between press and release, so this is a 700ms hold —
      // comfortably past the 400ms the alternate fires at.
      await key(page, "c-c").click({ delay: 700 });

      await terminal.type("echo kb-held\n");
      await terminal.waitFor(
        (snap) => snap.lines.some((l) => l.trim() === "kb-held"),
        "holding `c` did not send ^C",
      );
    });

    /*
     * A tap must not also fire the alternate. The inverse of the test above, and
     * the failure it guards against is the one a user would notice first: a
     * stray `^C` in front of every letter they type.
     */
    test("tapping that same letter sends the letter", async ({ lab, page }) => {
      await seedKeyboard(page);
      const terminal = await lab.open(SESSION);

      await key(page, "c-e").click();
      await key(page, "c-c").click();
      await key(page, "c-h").click();
      await key(page, "c-o").click();
      await key(page, "space").click();
      await tapAll(page, "quick");
      await key(page, "enter").click();

      await terminal.waitFor(
        (snap) => snap.lines.some((l) => l.trim() === "quick"),
        "a quick tap on a letter with a hold alternate did not send the letter",
      );
    });

    /*
     * The escape sequences, read back byte for byte.
     *
     * Three keys in one line, because what is being tested is the encoder and
     * the encoder is one function: if CSI Z comes through correctly then the
     * whole `named`/`literal` path does.
     */
    test("sends the agent board's escape sequences exactly", async ({
      lab,
      page,
    }) => {
      await seedKeyboard(page);
      const terminal = await lab.open(SESSION);

      // Canonical mode, so the tty echoes control characters as `^X`.
      await terminal.type("cat -v\n");
      await page.locator('[data-layer-tab="agent"]').click();

      await key(page, "shift-tab").click();
      /*
       * `^A`, and not `^R`, which is the point of this comment.
       *
       * The first draft read the sequence back through `ctrl-r` and the byte
       * vanished — because 0x12 is termios' `VREPRINT`, so the tty consumed it
       * and redrew the line instead of echoing it. `^A` has no special meaning
       * to a tty; it is a readline binding, which is a layer further in. The
       * same is true of `^U`, `^W` and `^C`, so none of those can be read back
       * this way either.
       */
      await key(page, "ctrl-a").click();
      await key(page, "agent-up").click();

      const expected = `${CSI_Z}^A^[[A`;
      const snap = await terminal.waitFor(
        (s) => s.lines.some((l) => l.includes(expected)),
        `the board's escape sequences did not arrive as ${CSI_Z} ^A ESC[A`,
      );
      expect(snap.lines.join("\n")).toContain(expected);

      // Leave the session as it was found: `cat` is still running.
      await key(page, "ctrl-c").click();
    });

    /*
     * Opening the board must shrink the terminal, not cover it.
     *
     * This is the one thing the app's own keyboard can get right that the
     * platform's cannot be made to: its height is known, so the footer grows,
     * `AppShell` shrinks the terminal, and the resize travels to tmux as a
     * SIGWINCH. A keyboard drawn *over* the output would leave tmux believing
     * the old size and the bottom rows — the prompt, and what you just typed —
     * underneath it.
     */
    test("shrinks tmux rather than covering it", async ({ lab, page }) => {
      await seedKeyboard(page);
      const terminal = await lab.open(SESSION);

      const [, rowsWithBoard] = terminal.tmuxSize();

      await page.locator("[data-keyboard-hide]").click();
      await expect(board(page)).toHaveCount(0);

      // The fit ladder debounces, and the round trip to tmux is a resize
      // request, so this is a poll rather than a read.
      await expect
        .poll(() => terminal.tmuxSize()[1], {
          message: "tmux never grew back after the keyboard was put away",
          timeout: 15_000,
        })
        .toBeGreaterThan(rowsWithBoard);
    });

    /*
     * Two keyboards at once is not a cosmetic clash: the platform's covers the
     * lower half of the viewport, `AppShell` sizes itself to the visual
     * viewport, and the footer ours lives in is what gets squeezed out.
     * `inputmode="none"` is what keeps xterm's textarea focused — so the cursor
     * still blinks and tmux still believes the pane is focused — while telling
     * the platform not to raise anything for it.
     */
    test("keeps the platform keyboard down while it is up", async ({
      lab,
      page,
    }) => {
      await seedKeyboard(page);
      const terminal = await lab.open(SESSION);
      await terminal.focus();

      // `.first()`: xterm keeps one textarea per instance, and a session switch
      // can leave the outgoing one in the DOM for a frame.
      const helper = terminal.root
        .locator("textarea.xterm-helper-textarea")
        .first();
      await expect(helper).toHaveAttribute("inputmode", "none");

      await page.locator("[data-keyboard-hide]").click();
      await expect(board(page)).toHaveCount(0);
      // Handed back, rather than left suppressed — the platform keyboard is the
      // only way to dictate, and the composer still wants it.
      await expect(helper).toHaveAttribute("inputmode", "text");
    });
  },
);

test.describe("the cursor pad, against tmux", { tag: "@terminal" }, () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, "the cursor pad belongs to the touch layout");
  });

  /**
   * Push for an arrow, press the middle for Enter.
   *
   * Driven through the mouse rather than `playGesture`'s synthetic touches
   * because the pad is built on pointer events with pointer capture, and
   * Playwright's mouse produces exactly those — including the capture, which
   * is what keeps a thumb steering after it leaves the rim.
   */
  test("pushes an arrow key, and takes the middle as Enter", async ({
    lab,
    page,
  }) => {
    await seedKeyboard(page, { pad: true });
    const terminal = await lab.open(SESSION);

    await terminal.type("cat -v\n");

    const surface = page.locator("[data-pad-surface]");
    await expect(surface).toBeVisible();
    const box = (await surface.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // A push, held just long enough to fire once and let go before the repeat
    // delay — so this is one arrow key, not four.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - box.height / 2, { steps: 4 });
    await expect(page.locator("[data-pad-hint=up]")).toHaveClass(
      /text-primary/,
    );
    await page.mouse.up();

    await terminal.waitFor(
      (snap) => snap.lines.some((l) => l.includes("^[[A")),
      "pushing the pad up did not send an up arrow",
    );

    // A press in the middle that goes nowhere is Enter, which submits the
    // line `cat -v` has been collecting.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();

    await terminal.waitFor(
      (snap) => snap.lines.filter((l) => l.includes("^[[A")).length >= 2,
      "pressing the middle of the pad did not send Enter",
    );

    await terminal.focus();
    await page.keyboard.press("Control+c");
  });

  /*
   * Resting a thumb on a joystick must do nothing at all. A pad that moves the
   * cursor under a resting thumb scrolls a menu past the option you were
   * about to pick, which is worse than not having a pad.
   */
  test("does nothing for a thumb resting in the middle", async ({
    lab,
    page,
  }) => {
    await seedKeyboard(page, { pad: true });
    const terminal = await lab.open(SESSION);

    await terminal.type("cat -v\n");
    const before = await settle(page, () => terminal.snapshot());

    const surface = page.locator("[data-pad-surface]");
    const box = (await surface.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Inside the deadzone, held well past the tap window — so it is neither a
    // direction nor an Enter.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 6, cy + 4, { steps: 3 });
    await page.waitForTimeout(600);
    await page.mouse.up();

    await page.waitForTimeout(400);
    expect(
      (await terminal.snapshot()).lines.join("\n"),
      "a thumb resting inside the deadzone moved the cursor",
    ).toBe(before);

    await terminal.focus();
    await page.keyboard.press("Control+c");
  });
});
