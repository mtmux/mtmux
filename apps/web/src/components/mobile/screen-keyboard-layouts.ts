import type { KeySend, Mods } from "@/lib/key-codes";

/**
 * The boards, as data.
 *
 * Three of them, and the third is the reason the other two were worth
 * building. `letters` and `symbols` are an ordinary phone keyboard that
 * happens to send bytes instead of text — valuable only because every key on
 * it composes with Ctrl and Alt, which the platform's keyboard cannot. `agent`
 * is a board that does not exist anywhere else: one screen holding every
 * keystroke Claude Code and Codex ask for, each of which was previously
 * either four taps into a sheet or impossible.
 *
 * Kept out of the component because a table is not a render, and because every
 * claim this file makes — that each key resolves to bytes, that no row
 * overflows, that no id repeats — is a unit test that should not have to mount
 * React to run.
 */

export type LayerName = "letters" | "symbols" | "agent";

/** A long press alternate: a second key on the same cap. */
export type HoldAlternate = {
  send: KeySend;
  /** Applied on top of whatever is latched. Ctrl, for the letter caps. */
  mods?: Partial<Mods>;
  /** Printed small in the corner, so the alternate is discoverable. */
  label: string;
};

export type KeyCap = {
  id: string;
  label: string;
  /** What the cap reads when Shift is latched. Letters flip case. */
  shiftLabel?: string;
  /** Bytes. Absent only for the caps that act on the keyboard itself. */
  send?: KeySend;
  /** A cap that drives the UI rather than the pty. */
  action?: KeyAction;
  /** Flex weight. Space is wide; the rest are 1. */
  width?: number;
  /** Holding it repeats it — arrows, backspace, nothing else. */
  repeat?: boolean;
  /** Holding it sends something else instead. Mutually exclusive with repeat. */
  hold?: HoldAlternate;
  /** For `aria-label` and the help sheet, where the cap is not self-evident. */
  hint?: string;
  tone?: "plain" | "muted" | "accent" | "danger";
};

export type KeyAction =
  | { kind: "mod"; mod: keyof Mods }
  | { kind: "layer"; to: LayerName };

export type KeyRow = KeyCap[];

/** Every cap on a layer, in rows, top to bottom. */
export type Layer = {
  name: LayerName;
  /** The segmented control's label. */
  tab: string;
  rows: KeyRow[];
};

/** Shorthand for a plain character cap. */
const ch = (
  char: string,
  extra: Omit<KeyCap, "id" | "label" | "send"> = {},
): KeyCap => ({
  id: `c-${char}`,
  label: char,
  send: { kind: "char", char },
  ...extra,
});

/**
 * A letter cap, whose long press is its control code.
 *
 * This is the affordance that makes the board worth using over a toolbar with
 * a sticky Ctrl: `^C` is holding `c`, not tapping a modifier and hoping it
 * survives to the next tap. The `^` in the corner is how anyone finds out.
 */
const letter = (char: string): KeyCap => ({
  id: `c-${char}`,
  label: char,
  shiftLabel: char.toUpperCase(),
  send: { kind: "char", char },
  hold: {
    send: { kind: "char", char },
    mods: { ctrl: true },
    label: `^${char.toUpperCase()}`,
  },
  hint: `${char}, hold for Ctrl+${char.toUpperCase()}`,
});

/** A cap that sends a finished sequence — a control code, or a CSI. */
const seq = (
  id: string,
  label: string,
  s: string,
  extra: Omit<KeyCap, "id" | "label" | "send"> = {},
): KeyCap => ({
  id,
  label,
  send: { kind: "literal", seq: s },
  ...extra,
});

/** A cap that sends one of the named keys, so modifiers compose properly. */
const named = (
  id: string,
  label: string,
  name: Extract<KeySend, { kind: "named" }>["name"],
  extra: Omit<KeyCap, "id" | "label" | "send"> = {},
): KeyCap => ({
  id,
  label,
  send: { kind: "named", name },
  ...extra,
});

const BACKSPACE = named("backspace", "⌫", "backspace", {
  width: 1.5,
  repeat: true,
  hint: "Backspace",
  tone: "muted",
});

const ENTER = named("enter", "⏎", "enter", {
  width: 1.75,
  hint: "Enter",
  tone: "accent",
});

const LETTERS: Layer = {
  name: "letters",
  tab: "abc",
  rows: [
    [..."qwertyuiop"].map(letter),
    [..."asdfghjkl"].map(letter),
    [
      {
        id: "shift",
        label: "⇧",
        action: { kind: "mod", mod: "shift" },
        width: 1.5,
        hint: "Shift — once for the next key, twice to lock",
        tone: "muted",
      },
      ...[..."zxcvbnm"].map(letter),
      BACKSPACE,
    ],
    [
      {
        id: "ctrl",
        label: "ctrl",
        action: { kind: "mod", mod: "ctrl" },
        width: 1.25,
        hint: "Ctrl — once for the next key, twice to lock",
        tone: "muted",
      },
      {
        id: "alt",
        label: "alt",
        action: { kind: "mod", mod: "alt" },
        width: 1.25,
        hint: "Alt — once for the next key, twice to lock",
        tone: "muted",
      },
      ch("/", {
        hold: { send: { kind: "char", char: "?" }, label: "?" },
        hint: "Slash, hold for ?",
      }),
      named("space", "space", "space", { width: 3.5, hint: "Space" }),
      ch(".", {
        hold: { send: { kind: "char", char: "," }, label: "," },
        hint: "Full stop, hold for a comma",
      }),
      ENTER,
    ],
  ],
};

const SYMBOLS: Layer = {
  name: "symbols",
  tab: "?123",
  rows: [
    [..."1234567890"].map((d) => ch(d)),
    [..."!@#$%^&*()"].map((s) => ch(s)),
    [
      ch("-", {
        hold: { send: { kind: "char", char: "_" }, label: "_" },
      }),
      ch("_"),
      ch("="),
      ch("+"),
      ch("["),
      ch("]"),
      ch("{"),
      ch("}"),
      ch("\\"),
      ch("|"),
    ],
    [
      ch("`"),
      ch("~"),
      ch("'"),
      ch('"'),
      ch(":"),
      ch(";"),
      ch(","),
      ch("<"),
      ch(">"),
      BACKSPACE,
    ],
  ],
};

/**
 * The agent board.
 *
 * Every cap here is a keystroke one of these CLIs documents and a phone could
 * not previously send, or could only send by scrolling a toolbar strip past
 * eleven icon buttons.
 *
 *  - `Esc Esc` rewinds to edit the previous message.
 *  - `⇧Tab` cycles Claude Code's permission modes; back a field in Codex.
 *  - `⌥⏎` is a newline that does not submit — the whole of writing a
 *    multi-line prompt on a phone.
 *  - `1`–`5`, `y` and `n` answer the option lists and the yes/no prompts,
 *    which is what asked for this board in the first place. The arrows and
 *    Enter beside them are the other way through the same list, and the cursor
 *    pad is the third.
 *  - `^R` expands the transcript, `^O` toggles verbose, `^P`/`^N` walk a list
 *    in anything carrying emacs bindings.
 *  - `/`, `@`, `#` and `!` open slash commands, the file picker, memory and
 *    bash mode. All four are two taps deep on an iOS keyboard.
 */
const AGENT: Layer = {
  name: "agent",
  tab: "agent",
  rows: [
    [
      seq("esc-esc", "esc esc", "\x1b\x1b", {
        hint: "Rewind to edit your previous message",
        tone: "muted",
      }),
      seq("shift-tab", "⇧tab", "\x1b[Z", {
        hint: "Cycle permission modes; back a field",
        tone: "muted",
      }),
      named("tab", "tab", "tab", { hint: "Tab", tone: "muted" }),
      seq("alt-enter", "⌥⏎", "\x1b\r", {
        hint: "Newline without sending",
        tone: "muted",
      }),
      named("agent-enter", "⏎", "enter", { hint: "Enter", tone: "accent" }),
      named("agent-backspace", "⌫", "backspace", {
        repeat: true,
        hint: "Backspace",
        tone: "muted",
      }),
      seq("ctrl-c", "^C", "\x03", { hint: "Interrupt", tone: "danger" }),
      seq("ctrl-d", "^D", "\x04", { hint: "End of input" }),
      seq("ctrl-z", "^Z", "\x1a", { hint: "Suspend" }),
      seq("ctrl-l", "^L", "\x0c", { hint: "Clear the screen" }),
    ],
    [
      ch("1", { hint: "Pick option 1", tone: "accent" }),
      ch("2", { hint: "Pick option 2", tone: "accent" }),
      ch("3", { hint: "Pick option 3", tone: "accent" }),
      ch("4", { hint: "Pick option 4", tone: "accent" }),
      ch("5", { hint: "Pick option 5", tone: "accent" }),
      ch("y", { hint: "Yes" }),
      ch("n", { hint: "No" }),
      seq("ctrl-r", "^R", "\x12", {
        hint: "Expand the transcript; reverse-search a shell",
      }),
      seq("ctrl-o", "^O", "\x0f", { hint: "Toggle verbose output" }),
      seq("ctrl-p", "^P", "\x10", { hint: "Previous, where emacs keys apply" }),
    ],
    [
      named("agent-up", "↑", "up", { repeat: true, hint: "Up" }),
      named("agent-down", "↓", "down", { repeat: true, hint: "Down" }),
      named("agent-left", "←", "left", { repeat: true, hint: "Left" }),
      named("agent-right", "→", "right", { repeat: true, hint: "Right" }),
      named("home", "home", "home", { hint: "Start of the line" }),
      named("end", "end", "end", { hint: "End of the line" }),
      named("pageup", "pgup", "pageup", { repeat: true, hint: "Page up" }),
      named("pagedown", "pgdn", "pagedown", {
        repeat: true,
        hint: "Page down",
      }),
      seq("ctrl-a", "^A", "\x01", { hint: "Start of the line" }),
      seq("ctrl-e", "^E", "\x05", { hint: "End of the line" }),
    ],
    [
      ch("/", { hint: "Slash commands" }),
      ch("@", { hint: "Mention a file" }),
      ch("#", { hint: "Add to memory" }),
      ch("!", { hint: "Bash mode" }),
      ch("~"),
      ch("-"),
      ch("_"),
      seq("ctrl-u", "^U", "\x15", { hint: "Clear before the cursor" }),
      seq("ctrl-w", "^W", "\x17", { hint: "Delete the word behind" }),
      seq("ctrl-k", "^K", "\x0b", { hint: "Clear after the cursor" }),
    ],
  ],
};

export const LAYERS: Record<LayerName, Layer> = {
  letters: LETTERS,
  symbols: SYMBOLS,
  agent: AGENT,
};

export const LAYER_ORDER: LayerName[] = ["letters", "symbols", "agent"];

/**
 * The widest row on a board, in flex units.
 *
 * Asserted in the unit suite rather than eyeballed: a row that sums past ten
 * does not wrap, it shrinks every cap on that row below the 44px tap-target
 * floor, which is the kind of regression nobody sees in review and everybody
 * feels on a phone.
 */
export function rowWidth(row: KeyRow): number {
  return row.reduce((sum, cap) => sum + (cap.width ?? 1), 0);
}

/**
 * What the cap should read, given what is latched.
 *
 * A keyboard whose caps do not change when you arm a modifier is a keyboard
 * that asks you to remember what you armed. Shift flips the case, and Ctrl
 * turns every letter into the control code it is about to send — so arming
 * Ctrl and seeing `^C` where `c` was is the confirmation that the latch took,
 * delivered on the key you are about to press rather than on a chip somewhere
 * else.
 */
export function capLabel(cap: KeyCap, latches: Partial<Mods>): string {
  if (latches.ctrl && cap.hold?.mods?.ctrl) return cap.hold.label;
  if (latches.shift && cap.shiftLabel) return cap.shiftLabel;
  return cap.label;
}
