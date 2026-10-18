import type { Mods } from "@/lib/key-codes";

/**
 * Three states, not two, and the third one is the whole usability of the board.
 *
 * A modifier that only toggles forces a choice between two bad behaviours. If
 * it clears after one key, `Ctrl+X Ctrl+S` in an editor is six taps with a
 * modifier re-armed in the middle. If it latches until tapped again, every
 * user who taps Ctrl once and then types a word sends six control codes into
 * their shell and has to work out what happened.
 *
 * So: tap once to arm it for the next key, tap again to lock it until it is
 * tapped a third time. This is what every phone keyboard does with Shift, and
 * the reason it is worth copying is that nobody has to be told about it.
 */
export type LatchState = "off" | "once" | "locked";

export type Latches = Record<keyof Mods, LatchState>;

export const NO_LATCHES: Latches = { ctrl: "off", alt: "off", shift: "off" };

export function cycleLatch(state: LatchState): LatchState {
  return state === "off" ? "once" : state === "once" ? "locked" : "off";
}

/** What is held right now, as the encoder wants it. */
export function modsFrom(latches: Latches): Mods {
  return {
    ctrl: latches.ctrl !== "off",
    alt: latches.alt !== "off",
    shift: latches.shift !== "off",
  };
}

/**
 * What survives a keystroke.
 *
 * `once` is spent, `locked` is not, and — this is the part the toolbar's
 * sticky modifiers got wrong — a `once` is spent whether or not the key it
 * applied to could use it. Clearing the latch only inside the branch that
 * consumed it is how a chip stays lit forever after an arrow key.
 */
export function afterKey(latches: Latches): Latches {
  return {
    ctrl: latches.ctrl === "once" ? "off" : latches.ctrl,
    alt: latches.alt === "once" ? "off" : latches.alt,
    shift: latches.shift === "once" ? "off" : latches.shift,
  };
}

/** Whether anything at all is held, for the "modifiers armed" indicator. */
export function anyHeld(latches: Latches): boolean {
  return Object.values(latches).some((state) => state !== "off");
}
