import { describe, it, expect } from "vitest";
import {
  aim,
  deadzoneFor,
  DEADZONE_RATIO,
  isCentreTap,
  knobOffset,
  MIN_DEADZONE_PX,
  REPEAT_FAST_MS,
  REPEAT_SLOW_MS,
  TAP_MS,
} from "./cursor-pad";

const RADIUS = 60;

describe("deadzoneFor", () => {
  it("scales with the pad, so a tablet and a phone behave alike", () => {
    expect(deadzoneFor(RADIUS)).toBe(RADIUS * DEADZONE_RATIO);
  });

  it("never shrinks below the floor, however small the pad is drawn", () => {
    expect(deadzoneFor(10)).toBe(MIN_DEADZONE_PX);
  });
});

describe("aim", () => {
  it("points nowhere inside the deadzone, so a resting thumb does nothing", () => {
    expect(aim({ dx: 0, dy: 0 }, RADIUS).direction).toBeNull();
    expect(aim({ dx: 10, dy: 10 }, RADIUS).direction).toBeNull();
  });

  it("names the four directions, with the screen's y pointing down", () => {
    expect(aim({ dx: 0, dy: -50 }, RADIUS).direction).toBe("up");
    expect(aim({ dx: 0, dy: 50 }, RADIUS).direction).toBe("down");
    expect(aim({ dx: -50, dy: 0 }, RADIUS).direction).toBe("left");
    expect(aim({ dx: 50, dy: 0 }, RADIUS).direction).toBe("right");
  });

  /*
   * A terminal has four arrow keys and no diagonal. A push at 45° has to pick
   * one — picking both is how a list selection lands a row away from where the
   * thumb was aiming.
   */
  it("resolves a diagonal to the dominant axis", () => {
    expect(aim({ dx: 50, dy: 20 }, RADIUS).direction).toBe("right");
    expect(aim({ dx: 20, dy: 50 }, RADIUS).direction).toBe("down");
  });

  it("gives an exact 45° to the vertical, because these lists are vertical", () => {
    expect(aim({ dx: 40, dy: 40 }, RADIUS).direction).toBe("down");
    expect(aim({ dx: -40, dy: -40 }, RADIUS).direction).toBe("up");
  });

  it("repeats slowest at the edge of the deadzone and fastest at the rim", () => {
    const dead = deadzoneFor(RADIUS);
    const nudge = aim({ dx: 0, dy: -(dead + 0.5) }, RADIUS);
    const shove = aim({ dx: 0, dy: -RADIUS }, RADIUS);
    expect(nudge.intervalMs).toBeGreaterThan(shove.intervalMs);
    expect(nudge.intervalMs).toBeLessThanOrEqual(REPEAT_SLOW_MS);
    expect(shove.intervalMs).toBe(REPEAT_FAST_MS);
  });

  it("ramps from the deadzone, not from the centre", () => {
    // The first pixel past the deadzone must be the slowest rate. Measuring
    // the ramp from the centre instead would start it a third of the way up.
    const dead = deadzoneFor(RADIUS);
    expect(aim({ dx: 0, dy: -(dead + 0.01) }, RADIUS).magnitude).toBeCloseTo(
      0,
      2,
    );
  });

  it("clamps the magnitude at the rim rather than past it", () => {
    expect(aim({ dx: 0, dy: -500 }, RADIUS).magnitude).toBe(1);
    expect(aim({ dx: 0, dy: -500 }, RADIUS).intervalMs).toBe(REPEAT_FAST_MS);
  });
});

describe("knobOffset", () => {
  it("follows the thumb while it is over the pad", () => {
    expect(knobOffset({ dx: 10, dy: -20 }, RADIUS)).toEqual({
      dx: 10,
      dy: -20,
    });
  });

  it("stops at the rim, so the knob reads as a stick and not a dragged object", () => {
    const out = knobOffset({ dx: 300, dy: 0 }, RADIUS);
    expect(Math.hypot(out.dx, out.dy)).toBeCloseTo(RADIUS, 5);
  });

  it("survives a vector of exactly zero", () => {
    expect(knobOffset({ dx: 0, dy: 0 }, RADIUS)).toEqual({ dx: 0, dy: 0 });
  });
});

describe("isCentreTap", () => {
  it("is a tap when it stayed in the middle and was let go quickly", () => {
    expect(isCentreTap({ dx: 2, dy: 2 }, RADIUS, 120)).toBe(true);
  });

  it("is not a tap once it has been pushed", () => {
    expect(isCentreTap({ dx: 40, dy: 0 }, RADIUS, 120)).toBe(false);
  });

  it("is not a tap once it has been held", () => {
    // Otherwise resting a thumb on the pad and lifting it would submit.
    expect(isCentreTap({ dx: 0, dy: 0 }, RADIUS, TAP_MS + 1)).toBe(false);
  });
});
