import { describe, it, expect } from "vitest";
import { encodeKey, NO_MODS, type Mods } from "@/lib/key-codes";
import {
  capLabel,
  LAYERS,
  LAYER_ORDER,
  rowWidth,
  type KeyCap,
} from "./screen-keyboard-layouts";

const layers = LAYER_ORDER.map((name) => LAYERS[name]);
const allCaps: KeyCap[] = layers.flatMap((layer) => layer.rows.flat());

/**
 * The boards are data, so the things that can go wrong with them are the
 * things that go wrong with data: a cap that sends nothing, a row that
 * overflows, two caps claiming the same React key, a `hold` that was never
 * wired up. None of those throws. Several of them are invisible in review and
 * obvious on a phone.
 */
describe("the boards", () => {
  it("has every layer in the order the switcher shows", () => {
    expect(LAYER_ORDER).toEqual(["letters", "symbols", "agent"]);
    for (const name of LAYER_ORDER) {
      expect(LAYERS[name].name).toBe(name);
      expect(LAYERS[name].tab).toBeTruthy();
    }
  });

  it("gives every cap either bytes or a job", () => {
    for (const cap of allCaps) {
      expect(
        Boolean(cap.send) || Boolean(cap.action),
        `${cap.id} does nothing at all`,
      ).toBe(true);
    }
  });

  it("gives every cap a label, so no key is blank", () => {
    for (const cap of allCaps) {
      expect(cap.label.length, `${cap.id} has no label`).toBeGreaterThan(0);
    }
  });

  /*
   * Ten units is the width of a row. A row that sums past it does not wrap —
   * flexbox shrinks every cap on it instead, which takes the whole row under
   * the 44px tap-target floor. That is a regression nobody sees in a diff.
   */
  it("keeps every row inside the ten units a row has", () => {
    for (const layer of layers) {
      for (const [index, row] of layer.rows.entries()) {
        const width = rowWidth(row);
        expect(
          width,
          `${layer.name} row ${index} is ${width} units wide`,
        ).toBeLessThanOrEqual(10.8);
        expect(width).toBeGreaterThan(8);
      }
    }
  });

  it("has no duplicate ids within a layer", () => {
    for (const layer of layers) {
      const ids = layer.rows.flat().map((cap) => cap.id);
      expect(new Set(ids).size, `${layer.name} repeats an id`).toBe(ids.length);
    }
  });

  it("encodes every cap to bytes, under every modifier combination", () => {
    const combos: Mods[] = [
      NO_MODS,
      { ctrl: true, alt: false, shift: false },
      { ctrl: false, alt: true, shift: false },
      { ctrl: false, alt: false, shift: true },
      { ctrl: true, alt: true, shift: true },
    ];
    for (const cap of allCaps) {
      if (!cap.send) continue;
      for (const held of combos) {
        const bytes = encodeKey(cap.send, held);
        expect(bytes.length, `${cap.id} sent nothing`).toBeGreaterThan(0);
      }
    }
  });

  it("never repeats and offers an alternate on the same cap", () => {
    // They are the same gesture. A cap that did both would either repeat the
    // base key or fire the alternate, depending on which timer won.
    for (const cap of allCaps) {
      expect(
        Boolean(cap.repeat && cap.hold),
        `${cap.id} both repeats and holds`,
      ).toBe(false);
    }
  });

  it("wires every long-press alternate to something that sends", () => {
    for (const cap of allCaps) {
      if (!cap.hold) continue;
      expect(cap.hold.label.length).toBeGreaterThan(0);
      expect(encodeKey(cap.hold.send, NO_MODS).length).toBeGreaterThan(0);
    }
  });
});

describe("the letters board", () => {
  const letters = LAYERS.letters.rows.flat();

  it("has all twenty-six, each one holding its own control code", () => {
    const caps = new Map(letters.map((cap) => [cap.label, cap]));
    for (const char of "abcdefghijklmnopqrstuvwxyz") {
      const cap = caps.get(char);
      expect(cap, `no ${char} key`).toBeDefined();
      expect(encodeKey(cap!.send!, NO_MODS)).toBe(char);
      // Holding a letter is how you send its control code without a modifier
      // tap — the single best thing about the board, and worth a test.
      expect(
        encodeKey(cap!.hold!.send, {
          ...NO_MODS,
          ...cap!.hold!.mods,
        }),
      ).toBe(String.fromCharCode(char.toUpperCase().charCodeAt(0) - 64));
    }
  });

  it("carries the three modifiers, and only as actions", () => {
    for (const mod of ["ctrl", "alt", "shift"] as const) {
      const cap = letters.find((c) => c.id === mod);
      expect(cap?.action).toEqual({ kind: "mod", mod });
      expect(cap?.send).toBeUndefined();
    }
  });
});

describe("the agent board", () => {
  const caps = LAYERS.agent.rows.flat();
  const byId = new Map(caps.map((cap) => [cap.id, cap]));

  /**
   * Each of these is a keystroke one of the agent CLIs documents, and each was
   * either impossible from a phone or four taps into a sheet. If one of them
   * disappears from this board, the board has stopped being the reason it
   * exists.
   */
  it.each([
    ["esc-esc", "\x1b\x1b"],
    ["shift-tab", "\x1b[Z"],
    ["alt-enter", "\x1b\r"],
    ["ctrl-c", "\x03"],
    ["ctrl-d", "\x04"],
    ["ctrl-z", "\x1a"],
    ["ctrl-r", "\x12"],
    ["ctrl-o", "\x0f"],
    ["ctrl-l", "\x0c"],
    ["ctrl-u", "\x15"],
    ["ctrl-w", "\x17"],
    ["ctrl-k", "\x0b"],
  ])("%s sends the right bytes", (id, bytes) => {
    const cap = byId.get(id);
    expect(cap, `${id} is missing from the agent board`).toBeDefined();
    expect(encodeKey(cap!.send!, NO_MODS)).toBe(bytes);
  });

  it("can answer an option list without any other surface", () => {
    // An option list is picked with a digit, or walked with the arrows and
    // taken with Enter. All three have to be on the one board.
    for (const digit of ["1", "2", "3", "4", "5"]) {
      expect(byId.has(`c-${digit}`), `no ${digit} key`).toBe(true);
    }
    for (const id of [
      "agent-up",
      "agent-down",
      "agent-left",
      "agent-right",
      "agent-enter",
    ]) {
      expect(byId.has(id), `no ${id}`).toBe(true);
    }
    expect(byId.has("c-y")).toBe(true);
    expect(byId.has("c-n")).toBe(true);
  });

  it("carries the four keys that open the pickers", () => {
    for (const char of ["/", "@", "#", "!"]) {
      expect(byId.has(`c-${char}`), `no ${char} key`).toBe(true);
    }
  });

  it("holds no modifiers, because every cap on it is already complete", () => {
    expect(caps.some((cap) => cap.action)).toBe(false);
  });
});

describe("capLabel", () => {
  const c = LAYERS.letters.rows[0]![0]!;

  it("prints the cap as written when nothing is held", () => {
    expect(capLabel(c, {})).toBe("q");
  });

  it("flips case under Shift", () => {
    expect(capLabel(c, { shift: true })).toBe("Q");
  });

  it("shows the control code under Ctrl, on the key about to send it", () => {
    expect(capLabel(c, { ctrl: true })).toBe("^Q");
  });

  it("lets Ctrl win over Shift, because that is the byte that goes", () => {
    expect(capLabel(c, { ctrl: true, shift: true })).toBe("^Q");
  });

  it("leaves a cap with no alternate alone under Ctrl", () => {
    const esc = LAYERS.agent.rows[0]![0]!;
    expect(capLabel(esc, { ctrl: true })).toBe(esc.label);
  });
});
