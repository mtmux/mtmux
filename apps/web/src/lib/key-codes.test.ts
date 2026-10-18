import { describe, it, expect } from "vitest";
import {
  ctrlByte,
  describeBytes,
  encodeChar,
  encodeKey,
  modParam,
  NO_MODS,
  type Mods,
} from "./key-codes";

const mods = (partial: Partial<Mods> = {}): Mods => ({
  ...NO_MODS,
  ...partial,
});

/**
 * The encoder is the one thing in the on-screen keyboard that can be wrong in
 * a way nobody notices until it matters. A cap that looks right and sends the
 * wrong byte does not throw, does not log, and does not fail to render — it
 * silently interrupts a build instead of clearing a line.
 */
describe("modParam", () => {
  it("is xterm's, which means 1 for nothing held", () => {
    expect(modParam(NO_MODS)).toBe(1);
  });

  it.each([
    [{ shift: true }, 2],
    [{ alt: true }, 3],
    [{ shift: true, alt: true }, 4],
    [{ ctrl: true }, 5],
    [{ shift: true, ctrl: true }, 6],
    [{ alt: true, ctrl: true }, 7],
    [{ shift: true, alt: true, ctrl: true }, 8],
  ] as const)("%o is %i", (held, expected) => {
    expect(modParam(mods(held))).toBe(expected);
  });
});

describe("ctrlByte", () => {
  it("maps @ through _ onto 0 through 31", () => {
    expect(ctrlByte("@")).toBe("\x00");
    expect(ctrlByte("A")).toBe("\x01");
    expect(ctrlByte("_")).toBe("\x1f");
  });

  it("is case-insensitive, because Ctrl+C and Ctrl+Shift+C are one byte", () => {
    expect(ctrlByte("c")).toBe("\x03");
    expect(ctrlByte("C")).toBe("\x03");
  });

  it("knows the two that are not in the range", () => {
    // Ctrl+? is DEL, and Ctrl+Space is NUL. Both predate the range.
    expect(ctrlByte("?")).toBe("\x7f");
    expect(ctrlByte(" ")).toBe("\x00");
  });

  it("returns null rather than inventing a byte for Ctrl+1", () => {
    expect(ctrlByte("1")).toBeNull();
    expect(ctrlByte("é")).toBeNull();
  });

  it("returns null for anything that is not one character", () => {
    expect(ctrlByte("")).toBeNull();
    expect(ctrlByte("ab")).toBeNull();
  });
});

describe("encodeChar", () => {
  it("sends the character when nothing is held", () => {
    expect(encodeChar("c", NO_MODS)).toBe("c");
  });

  it("uppercases under Shift, and prefers the cap's own shifted glyph", () => {
    expect(encodeChar("c", mods({ shift: true }))).toBe("C");
    // The layout knows that Shift+2 is `@` here and `"` on a UK keyboard;
    // `toUpperCase()` does not.
    expect(encodeChar("2", mods({ shift: true }), "@")).toBe("@");
  });

  it("makes a control code under Ctrl", () => {
    expect(encodeChar("c", mods({ ctrl: true }))).toBe("\x03");
  });

  it("falls through to the character when Ctrl has no meaning", () => {
    expect(encodeChar("1", mods({ ctrl: true }))).toBe("1");
  });

  it("prefixes ESC under Alt, which is what Alt is", () => {
    expect(encodeChar("f", mods({ alt: true }))).toBe("\x1bf");
  });

  it("composes Ctrl and Alt, in that order", () => {
    expect(encodeChar("c", mods({ ctrl: true, alt: true }))).toBe("\x1b\x03");
  });

  it("takes Ctrl from the shifted glyph when that is where the code lives", () => {
    // `^` is Shift+6, and Ctrl+^ is 0x1e. Without the shifted glyph there is
    // no way to reach RS from a US layout at all.
    expect(encodeChar("6", mods({ ctrl: true, shift: true }), "^")).toBe(
      "\x1e",
    );
  });
});

describe("encodeKey — the named keys", () => {
  it("sends bare CSI for an unmodified arrow", () => {
    expect(encodeKey({ kind: "named", name: "up" })).toBe("\x1b[A");
    expect(encodeKey({ kind: "named", name: "down" })).toBe("\x1b[B");
    expect(encodeKey({ kind: "named", name: "right" })).toBe("\x1b[C");
    expect(encodeKey({ kind: "named", name: "left" })).toBe("\x1b[D");
  });

  it("parameterises a modified arrow rather than prefixing ESC", () => {
    // `ESC ESC [ C` is what a naive Alt implementation produces, and readline
    // reads it as two keys. `CSI 1 ; 3 C` is the word-forward every terminal
    // actually sends.
    expect(
      encodeKey({ kind: "named", name: "right" }, mods({ alt: true })),
    ).toBe("\x1b[1;3C");
    expect(
      encodeKey({ kind: "named", name: "left" }, mods({ ctrl: true })),
    ).toBe("\x1b[1;5D");
  });

  it("uses the tilde form for the page and edit keys", () => {
    expect(encodeKey({ kind: "named", name: "pageup" })).toBe("\x1b[5~");
    expect(encodeKey({ kind: "named", name: "pagedown" })).toBe("\x1b[6~");
    expect(encodeKey({ kind: "named", name: "delete" })).toBe("\x1b[3~");
    expect(encodeKey({ kind: "named", name: "insert" })).toBe("\x1b[2~");
    expect(
      encodeKey({ kind: "named", name: "delete" }, mods({ ctrl: true })),
    ).toBe("\x1b[3;5~");
  });

  it("puts Home and End in the letter form, where xterm has them", () => {
    expect(encodeKey({ kind: "named", name: "home" })).toBe("\x1b[H");
    expect(encodeKey({ kind: "named", name: "end" })).toBe("\x1b[F");
  });

  it("sends CSI Z for Shift+Tab — the keystroke that asked for this board", () => {
    expect(encodeKey({ kind: "named", name: "tab" })).toBe("\t");
    expect(
      encodeKey({ kind: "named", name: "tab" }, mods({ shift: true })),
    ).toBe("\x1b[Z");
  });

  it("drops Ctrl from Tab rather than guessing at an encoding", () => {
    expect(
      encodeKey({ kind: "named", name: "tab" }, mods({ ctrl: true })),
    ).toBe("\t");
  });

  it("gives Shift+Enter and Alt+Enter the same bytes, which is what terminals do", () => {
    expect(encodeKey({ kind: "named", name: "enter" })).toBe("\r");
    expect(
      encodeKey({ kind: "named", name: "enter" }, mods({ shift: true })),
    ).toBe("\x1b\r");
    expect(
      encodeKey({ kind: "named", name: "enter" }, mods({ alt: true })),
    ).toBe("\x1b\r");
    expect(
      encodeKey({ kind: "named", name: "enter" }, mods({ ctrl: true })),
    ).toBe("\n");
  });

  it("sends DEL for backspace, and ESC DEL for the word behind it", () => {
    expect(encodeKey({ kind: "named", name: "backspace" })).toBe("\x7f");
    expect(
      encodeKey({ kind: "named", name: "backspace" }, mods({ alt: true })),
    ).toBe("\x1b\x7f");
    expect(
      encodeKey({ kind: "named", name: "backspace" }, mods({ ctrl: true })),
    ).toBe("\x08");
  });

  it("sends two escapes for Alt+Esc, which is Claude Code's rewind", () => {
    expect(encodeKey({ kind: "named", name: "escape" })).toBe("\x1b");
    expect(
      encodeKey({ kind: "named", name: "escape" }, mods({ alt: true })),
    ).toBe("\x1b\x1b");
  });

  it("makes Ctrl+Space NUL", () => {
    expect(encodeKey({ kind: "named", name: "space" })).toBe(" ");
    expect(
      encodeKey({ kind: "named", name: "space" }, mods({ ctrl: true })),
    ).toBe("\x00");
  });
});

describe("encodeKey — literals", () => {
  it("passes a finished sequence through untouched", () => {
    // Ctrl is deliberately not applied: `\x1b[Z` is already a complete key,
    // and running it through the control transform produces nonsense.
    expect(
      encodeKey({ kind: "literal", seq: "\x1b[Z" }, mods({ ctrl: true })),
    ).toBe("\x1b[Z");
  });

  it("still takes an Alt prefix, because a prefix composes with anything", () => {
    expect(
      encodeKey({ kind: "literal", seq: "\x03" }, mods({ alt: true })),
    ).toBe("\x1b\x03");
  });
});

describe("describeBytes", () => {
  it("says what a sequence is, so a failure message is readable", () => {
    expect(describeBytes("\x1b[1;5A")).toBe("ESC [ 1 ; 5 A");
    expect(describeBytes("\x03")).toBe("^C");
    expect(describeBytes("\x7f")).toBe("DEL");
    expect(describeBytes("\r")).toBe("CR");
    expect(describeBytes("\n")).toBe("LF");
    expect(describeBytes("\t")).toBe("TAB");
    expect(describeBytes(" ")).toBe("SPACE");
  });
});
