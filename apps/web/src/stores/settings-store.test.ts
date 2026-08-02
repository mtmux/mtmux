import { describe, it, expect } from "vitest";
import { mergeToolbarKeys, defaultToolbarKeys } from "./settings-store";

/**
 * The migration is the whole feature for anyone who has opened the app before.
 *
 * `persist` writes `toolbarKeys` to localStorage on first run and hands that
 * frozen array back forever, so a key added to the defaults would otherwise
 * reach new installs only — and `Shift+Tab` is being added for people who
 * already use this every day.
 */
describe("mergeToolbarKeys", () => {
  const legacy = [
    { id: "tab", label: "Tab", key: "\t", visible: true },
    { id: "esc", label: "Esc", key: "\x1b", visible: false },
    { id: "pipe", label: "|", key: "|", visible: true },
  ];

  it("adds Shift+Tab to a row saved before it existed", () => {
    const merged = mergeToolbarKeys(legacy);
    const shiftTab = merged.find((k) => k.id === "shift-tab");
    expect(shiftTab?.key).toBe("\x1b[Z");
    expect(shiftTab?.visible).toBe(true);
  });

  it("keeps the visibility the user chose", () => {
    const merged = mergeToolbarKeys(legacy);
    expect(merged.find((k) => k.id === "esc")?.visible).toBe(false);
    expect(merged.find((k) => k.id === "tab")?.visible).toBe(true);
  });

  it("takes the sequence from the default, never from the stored copy", () => {
    // So a wrong control code is fixable in a release rather than by asking
    // people to clear their site data.
    const merged = mergeToolbarKeys([
      { id: "tab", label: "Tab", key: "wrong", visible: true },
    ]);
    expect(merged.find((k) => k.id === "tab")?.key).toBe("\t");
  });

  it("drops ids that are no longer defaults", () => {
    const merged = mergeToolbarKeys([
      ...legacy,
      { id: "removed-long-ago", label: "?", key: "?", visible: true },
    ]);
    expect(merged.some((k) => k.id === "removed-long-ago")).toBe(false);
  });

  it("returns the full default set for a browser with nothing stored", () => {
    expect(mergeToolbarKeys(undefined)).toEqual(defaultToolbarKeys);
  });

  it("gives every key a group, so the sheet can never orphan one", () => {
    for (const key of mergeToolbarKeys(legacy)) {
      expect(key.group).toBeTruthy();
    }
  });
});
