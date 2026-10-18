/**
 * The joystick, as arithmetic.
 *
 * ## The problem a thumb stick solves
 *
 * Agent CLIs ask questions as lists — "1. Yes  2. Yes, and don't ask again
 * 3. No" — and the way through one is arrows and Enter. On a phone that meant
 * hunting ↑ and ↓ in a toolbar strip that scrolls horizontally, tapping each
 * one once per row, with the answer you want three rows down. Picking an option
 * took five accurate taps on 44px targets in a strip whose position changes
 * depending on which keys you have pinned.
 *
 * A stick replaces all of it with one gesture: push, and the cursor moves for
 * as long as you hold it, faster the further you push. Let go and it stops.
 * Press the middle without pushing and that is Enter — the thing you were
 * navigating *towards*.
 *
 * ## Why four directions and not eight
 *
 * Because a terminal has four arrow keys. There is no diagonal to send, so a
 * diagonal push has to resolve to one axis or fire two keys, and firing two is
 * how a list selection ends up one row from where the thumb was aiming. The
 * dominant axis wins, and vertical wins a tie: the lists this exists for are
 * vertical.
 *
 * Pure, and separate from the component, for the same reason
 * `keyboard-viewport.ts` is: every rule here is a unit test, and none of them
 * is reachable by driving a real finger across a headless browser.
 */

export type PadVector = { dx: number; dy: number };

export type PadDirection = "up" | "down" | "left" | "right";

/**
 * How much of the pad's radius is dead.
 *
 * 0.3 is not a round number picked for looks. A thumb resting on a 60px-radius
 * pad wanders 8–12px without the user believing they have moved it, and a pad
 * that starts repeating under a resting thumb is a pad that scrolls a menu past
 * the option you wanted while you decide. 18px of deadzone is past that drift
 * and still well inside a deliberate push.
 */
export const DEADZONE_RATIO = 0.3;

/** The deadzone never shrinks below this, however small the pad is drawn. */
export const MIN_DEADZONE_PX = 10;

/** The pause before a held direction starts repeating, as on every keyboard. */
export const REPEAT_DELAY_MS = 260;

/** The repeat interval at the edge of the deadzone — one nudge at a time. */
export const REPEAT_SLOW_MS = 220;

/** The repeat interval at full deflection. 55ms is ~18 rows a second. */
export const REPEAT_FAST_MS = 55;

/**
 * How long a press may last and still count as a tap rather than a hold.
 *
 * Only the *centre* press is a tap — a push is a direction from the moment it
 * leaves the deadzone, however briefly it is held. 350ms is the usual ceiling
 * and leaves room for a deliberate, slow press on a cold phone.
 */
export const TAP_MS = 350;

export function deadzoneFor(radius: number): number {
  return Math.max(MIN_DEADZONE_PX, radius * DEADZONE_RATIO);
}

export type PadAim = {
  /** Null inside the deadzone — the thumb is down but aiming at nothing. */
  direction: PadDirection | null;
  /** 0 at the edge of the deadzone, 1 at the rim. Drives the repeat rate. */
  magnitude: number;
  /** How long to wait between repeats while held here. */
  intervalMs: number;
};

/**
 * Where the thumb is pointing, and how fast that should repeat.
 *
 * `radius` is the pad's own radius in CSS pixels, so the deadzone and the ramp
 * scale with however large the pad is drawn — a tablet's and a phone's behave
 * identically in proportion rather than identically in pixels.
 */
export function aim(v: PadVector, radius: number): PadAim {
  const dead = deadzoneFor(radius);
  const distance = Math.hypot(v.dx, v.dy);

  if (distance <= dead) {
    return { direction: null, magnitude: 0, intervalMs: REPEAT_SLOW_MS };
  }

  // Dominant axis, ties to vertical. `>` rather than `>=` is what does it.
  const direction: PadDirection =
    Math.abs(v.dx) > Math.abs(v.dy)
      ? v.dx > 0
        ? "right"
        : "left"
      : v.dy > 0
        ? "down"
        : "up";

  // The ramp runs from the deadzone to the rim, not from the centre, so the
  // first pixel past the deadzone is the slowest repeat rather than a third of
  // the way up the curve already.
  const span = Math.max(1, radius - dead);
  const magnitude = Math.min(1, (distance - dead) / span);
  const intervalMs = Math.round(
    REPEAT_SLOW_MS + (REPEAT_FAST_MS - REPEAT_SLOW_MS) * magnitude,
  );

  return { direction, magnitude, intervalMs };
}

/**
 * Where to draw the knob: the thumb's offset, clamped to the rim.
 *
 * Clamped rather than free, because a knob that follows a finger off the edge
 * of the pad stops reading as a stick and starts reading as a dragged object —
 * and the finger is frequently well outside the pad, since a push that wants
 * the fastest repeat rate ends at the rim and keeps going.
 */
export function knobOffset(v: PadVector, radius: number): PadVector {
  const distance = Math.hypot(v.dx, v.dy);
  if (distance <= radius || distance === 0) return v;
  const scale = radius / distance;
  return { dx: v.dx * scale, dy: v.dy * scale };
}

/** A press that never left the deadzone and was let go quickly: a tap. */
export function isCentreTap(
  travel: PadVector,
  radius: number,
  elapsedMs: number,
): boolean {
  return (
    Math.hypot(travel.dx, travel.dy) <= deadzoneFor(radius) &&
    elapsedMs < TAP_MS
  );
}
