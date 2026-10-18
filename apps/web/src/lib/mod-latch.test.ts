import { describe, it, expect } from "vitest";
import {
  afterKey,
  anyHeld,
  cycleLatch,
  modsFrom,
  NO_LATCHES,
  type Latches,
} from "./mod-latch";

describe("cycleLatch", () => {
  it("goes off → once → locked → off, like every Shift key ever shipped", () => {
    expect(cycleLatch("off")).toBe("once");
    expect(cycleLatch("once")).toBe("locked");
    expect(cycleLatch("locked")).toBe("off");
  });
});

describe("modsFrom", () => {
  it("treats once and locked alike, because both mean held", () => {
    expect(modsFrom({ ctrl: "once", alt: "locked", shift: "off" })).toEqual({
      ctrl: true,
      alt: true,
      shift: false,
    });
  });
});

describe("afterKey", () => {
  it("spends a one-shot and keeps a lock", () => {
    expect(afterKey({ ctrl: "once", alt: "locked", shift: "off" })).toEqual({
      ctrl: "off",
      alt: "locked",
      shift: "off",
    });
  });

  /*
   * The bug this exists to prevent is in the shipped toolbar, documented in
   * its own comment: its sticky latch cleared only inside the branch that
   * consumed it, so an arrow key — which has no Ctrl form — left the chip lit
   * indefinitely. A one-shot is spent by *a keystroke*, not by a keystroke
   * that happened to find a use for it.
   */
  it("spends a one-shot even on a key that could not use it", () => {
    const after = afterKey({ ctrl: "once", alt: "off", shift: "off" });
    expect(after.ctrl).toBe("off");
  });

  it("leaves nothing to do when nothing is held", () => {
    expect(afterKey(NO_LATCHES)).toEqual(NO_LATCHES);
  });
});

describe("anyHeld", () => {
  it("is false only when all three are off", () => {
    expect(anyHeld(NO_LATCHES)).toBe(false);
    const one: Latches = { ...NO_LATCHES, shift: "once" };
    expect(anyHeld(one)).toBe(true);
  });
});
