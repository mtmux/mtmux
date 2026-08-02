import { describe, it, expect, beforeEach } from "vitest";
import {
  clearMachineName,
  forgetMachinePrefs,
  moveMachine,
  readAllMachinePrefs,
  renameMachine,
  setMachineCollapsed,
  setMachineOrder,
  sortMachines,
} from "./machine-directory";

/**
 * The directory is what makes a rename, an order and a collapsed group survive
 * a reload. Every one of those is invisible in a screenshot and obvious the
 * moment it is wrong, which is exactly the kind of thing to pin down here.
 */
describe("machine directory", () => {
  beforeEach(async () => {
    for (const id of ["a", "b", "c"]) await forgetMachinePrefs(id);
  });

  it("round-trips a local name", async () => {
    await renameMachine("a", "Studio");
    expect((await readAllMachinePrefs()).get("a")?.name).toBe("Studio");
  });

  it("trims and caps a name rather than storing whatever was typed", async () => {
    await renameMachine("a", `  ${"x".repeat(200)}  `);
    expect((await readAllMachinePrefs()).get("a")?.name).toHaveLength(64);
  });

  it("clears a name back to empty, so the account's shows through again", async () => {
    await renameMachine("a", "Studio");
    await clearMachineName("a");
    expect((await readAllMachinePrefs()).get("a")?.name).toBe("");
  });

  it("keeps the name when only the collapsed flag changes", async () => {
    // A blind `put` of the changed field is the obvious bug here, and it would
    // silently delete a rename every time a group was folded.
    await renameMachine("a", "Studio");
    await setMachineCollapsed("a", true);
    const prefs = (await readAllMachinePrefs()).get("a");
    expect(prefs?.name).toBe("Studio");
    expect(prefs?.collapsed).toBe(true);
  });

  it("writes an explicit index for every machine in an ordering", async () => {
    await setMachineOrder(["c", "a", "b"]);
    const prefs = await readAllMachinePrefs();
    expect(prefs.get("c")?.order).toBe(0);
    expect(prefs.get("a")?.order).toBe(1);
    expect(prefs.get("b")?.order).toBe(2);
  });

  it("moves one machine one place and persists the result", async () => {
    await setMachineOrder(["a", "b", "c"]);
    expect(await moveMachine(["a", "b", "c"], "c", -1)).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect((await readAllMachinePrefs()).get("c")?.order).toBe(1);
  });

  it("refuses to move past either end", async () => {
    expect(await moveMachine(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(await moveMachine(["a", "b"], "b", 1)).toEqual(["a", "b"]);
  });

  it("forgets a machine's preferences with the pairing", async () => {
    await renameMachine("a", "Studio");
    await forgetMachinePrefs("a");
    expect((await readAllMachinePrefs()).has("a")).toBe(false);
  });
});

describe("sortMachines", () => {
  const entry = (serverId: string, order: number, pairedAt: number) => ({
    serverId,
    order,
    pairedAt,
  });

  it("puts unordered machines last, oldest pairing first", () => {
    const unordered = Number.MAX_SAFE_INTEGER;
    const sorted = sortMachines([
      entry("new", unordered, 200),
      entry("old", unordered, 100),
      entry("pinned", 0, 999),
    ]);
    expect(sorted.map((e) => e.serverId)).toEqual(["pinned", "old", "new"]);
  });
});
