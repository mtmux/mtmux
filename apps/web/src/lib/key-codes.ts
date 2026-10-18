/**
 * Turning a keycap and a set of held modifiers into the bytes a pty reads.
 *
 * ## Why this exists at all
 *
 * The soft keyboard a phone ships cannot send a terminal's alphabet. It has no
 * Ctrl, no Alt, no Esc and no arrows, and the characters it *does* send arrive
 * through xterm's own hidden textarea — so `KeyboardToolbar`'s sticky Ctrl
 * could never apply to them. Tapping Ctrl and then `c` on the phone keyboard
 * sent a literal `c`, which is the single thing most often reported as "I
 * can't do that from my phone".
 *
 * The fix is to stop borrowing the platform's keyboard and render our own, and
 * the moment you do that every keystroke passes through one function. This is
 * that function. It is pure, it is exhaustively tested, and it is the only
 * place in the app that knows what a control code is.
 *
 * ## The encodings, and where they come from
 *
 * Nothing here is invented. The modifier parameter is xterm's — `1 + 1·shift +
 * 2·alt + 4·ctrl`, applied as the second parameter of a CSI sequence — and the
 * control range is ASCII's: `@` through `_` (64–95) map to codes 0–31, which is
 * the whole of what a terminal can express with Ctrl held. Alt is an ESC
 * prefix, which is why it composes with everything and Ctrl does not.
 */

export type Mods = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

export const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

/**
 * The keys that are not characters.
 *
 * Named rather than spelled as sequences in the layout tables, because each of
 * them has a *different* modified form and the table has no business knowing
 * which. `\x1b[A` with Ctrl is `\x1b[1;5A`; `\t` with Shift is `\x1b[Z`; `\r`
 * with Ctrl is `\n`. One `switch` below, instead of that knowledge scattered
 * across forty table rows.
 */
export type NamedKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "delete"
  | "insert"
  | "tab"
  | "enter"
  | "backspace"
  | "escape"
  | "space";

/** xterm's modifier parameter. 1 is "no modifiers", which is why it is 1. */
export function modParam(mods: Mods): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

/** `CSI <letter>`, or `CSI 1 ; <mods> <letter>` when anything is held. */
function csiLetter(letter: string, mods: Mods): string {
  const param = modParam(mods);
  return param === 1 ? `\x1b[${letter}` : `\x1b[1;${param}${letter}`;
}

/** `CSI <n> ~`, or `CSI <n> ; <mods> ~`. The PgUp/PgDn/Del/Ins family. */
function csiTilde(n: number, mods: Mods): string {
  const param = modParam(mods);
  return param === 1 ? `\x1b[${n}~` : `\x1b[${n};${param}~`;
}

/**
 * The control code for a character, or null when there is not one.
 *
 * Only `@` through `_` have one. `Ctrl+1` is not a thing a terminal can say,
 * and the honest answer is to send the `1` rather than to invent a byte — so
 * this returns null and the caller falls through to the unmodified character.
 *
 * `?` is the exception that is not in the range: Ctrl+? is DEL (0x7f), which is
 * what every terminal has sent since the VT100.
 */
export function ctrlByte(char: string): string | null {
  if (char.length !== 1) return null;
  if (char === "?") return "\x7f";
  if (char === " ") return "\x00";
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return null;
}

/** The named keys, with every modifier form each one actually has. */
function encodeNamed(name: NamedKey, mods: Mods): string {
  switch (name) {
    case "up":
      return csiLetter("A", mods);
    case "down":
      return csiLetter("B", mods);
    case "right":
      return csiLetter("C", mods);
    case "left":
      return csiLetter("D", mods);
    case "home":
      return csiLetter("H", mods);
    case "end":
      return csiLetter("F", mods);
    case "insert":
      return csiTilde(2, mods);
    case "delete":
      return csiTilde(3, mods);
    case "pageup":
      return csiTilde(5, mods);
    case "pagedown":
      return csiTilde(6, mods);

    /*
     * Shift+Tab is `CSI Z`, and it is the reason an agent CLI is usable from a
     * phone at all: it cycles Claude Code's permission modes and steps
     * backwards through Codex's fields. Ctrl+Tab has no terminal encoding, so
     * Ctrl is dropped rather than guessed at.
     */
    case "tab":
      if (mods.shift) return mods.alt ? "\x1b\x1b[Z" : "\x1b[Z";
      return mods.alt ? "\x1b\t" : "\t";

    /*
     * Shift+Enter and Alt+Enter are the same bytes, `ESC CR`, which is what
     * most terminals send and what both agent CLIs read as "newline, do not
     * submit". Ctrl+Enter is LF — Ctrl+J — which is distinct and occasionally
     * wanted.
     */
    case "enter":
      if (mods.ctrl) return "\n";
      return mods.shift || mods.alt ? "\x1b\r" : "\r";

    /*
     * DEL, not BS. A terminal's backspace key has sent 0x7f since termios made
     * it the erase character; 0x08 is Ctrl+H, which readline binds to the same
     * thing but a full-screen program may not. Alt+Backspace is "delete the
     * word behind the cursor" in readline, and therefore in every one of these
     * CLIs.
     */
    case "backspace":
      if (mods.ctrl) return "\x08";
      return mods.alt ? "\x1b\x7f" : "\x7f";

    /*
     * Two escapes, deliberately, for Alt+Esc. `ESC ESC` is Claude Code's
     * "rewind to edit the previous message" — a real shortcut people want and
     * the one keystroke a phone has never been able to produce.
     */
    case "escape":
      return mods.alt ? "\x1b\x1b" : "\x1b";

    case "space":
      if (mods.ctrl) return mods.alt ? "\x1b\x00" : "\x00";
      return mods.alt ? "\x1b " : " ";
  }
}

/**
 * A character key, with the shifted glyph the keycap is carrying.
 *
 * `shifted` is passed rather than derived because `toUpperCase()` is right for
 * letters and wrong for everything else: Shift+`2` is `@` on a US layout and
 * `"` on a UK one, and only the layout table knows which keyboard it is.
 */
export function encodeChar(char: string, mods: Mods, shifted?: string): string {
  const base = mods.shift ? (shifted ?? char.toUpperCase()) : char;
  // Ctrl is defined on the *unshifted* letter — Ctrl+Shift+C is still 0x03 —
  // but on the shifted glyph for punctuation, because `Ctrl+^` is 0x1e and the
  // key it lives on is `6`.
  const forCtrl = mods.ctrl ? (ctrlByte(base) ?? ctrlByte(char)) : null;
  const body = forCtrl ?? base;
  return mods.alt ? `\x1b${body}` : body;
}

/**
 * What a key sends. The discriminant the layout tables are written in.
 *
 * `literal` is the escape hatch for a sequence that is already complete —
 * `ESC ESC`, `\x1b[Z`, a bracketed-paste wrapper. Modifiers are deliberately
 * *not* applied to it, except Alt, which is a prefix and composes with
 * anything. Routing a finished sequence through the Ctrl transform is how you
 * get bytes nobody asked for.
 */
export type KeySend =
  | { kind: "char"; char: string; shifted?: string }
  | { kind: "named"; name: NamedKey }
  | { kind: "literal"; seq: string };

/** The one entry point. Give it a keycap and what is held; get bytes. */
export function encodeKey(send: KeySend, mods: Mods = NO_MODS): string {
  switch (send.kind) {
    case "char":
      return encodeChar(send.char, mods, send.shifted);
    case "named":
      return encodeNamed(send.name, mods);
    case "literal":
      return mods.alt ? `\x1b${send.seq}` : send.seq;
  }
}

/**
 * A readable name for a sequence, for the help sheet and for failure messages.
 *
 * Shared with `key-sheet.tsx`'s `sequenceHint` in spirit and kept separate in
 * fact: that one describes a stored key, this one describes bytes that were
 * just built, and a test that asserts on `ESC [ 1 ; 5 A` is far easier to read
 * than one asserting on a string of hex escapes.
 */
export function describeBytes(seq: string): string {
  return [...seq]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (ch === "\x1b") return "ESC";
      if (ch === "\t") return "TAB";
      if (ch === "\r") return "CR";
      if (ch === "\n") return "LF";
      if (ch === "\x7f") return "DEL";
      if (ch === " ") return "SPACE";
      if (code < 32) return `^${String.fromCharCode(code + 64)}`;
      return ch;
    })
    .join(" ");
}
