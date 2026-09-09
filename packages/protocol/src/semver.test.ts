import { describe, it, expect } from "vitest";
import { MIN_PAIR_CLI_VERSION, semverGte } from "./semver";

describe("semverGte", () => {
  it("orders by major, then minor, then patch", () => {
    expect(semverGte("0.6.0", "0.6.0")).toBe(true);
    expect(semverGte("0.6.1", "0.6.0")).toBe(true);
    expect(semverGte("0.7.0", "0.6.9")).toBe(true);
    expect(semverGte("1.0.0", "0.99.99")).toBe(true);
    expect(semverGte("0.5.9", "0.6.0")).toBe(false);
    expect(semverGte("0.6.0", "0.6.1")).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    // "0.10.0" < "0.9.0" as strings, and that is the classic way to get this
    // wrong — it would tell everyone on 0.10 to upgrade.
    expect(semverGte("0.10.0", "0.9.0")).toBe(true);
    expect(semverGte("0.9.0", "0.10.0")).toBe(false);
  });

  it("accepts a leading v and a pre-release suffix", () => {
    expect(semverGte("v0.6.0", "0.6.0")).toBe(true);
    // Someone on a release candidate has the feature.
    expect(semverGte("0.6.0-rc.1", "0.6.0")).toBe(true);
    expect(semverGte("  0.6.0  ", "0.6.0")).toBe(true);
  });

  it("returns null — not false — for anything unparseable", () => {
    // `cliVersion` is free text the broker stores on a machine's behalf. An
    // unrecognised value has to read as "unknown", never as "too old": telling
    // someone to upgrade a CLI that is already current is the worse failure,
    // because the upgrade changes nothing and there is nowhere else to look.
    for (const version of [null, undefined, "", "dev", "unknown", "1", "1.2"]) {
      expect(semverGte(version, "0.6.0")).toBeNull();
    }
  });

  it("returns null for an unparseable minimum too", () => {
    expect(semverGte("0.6.0", "not-a-version")).toBeNull();
  });

  it("gates the pairing-length notice on a real version", () => {
    // `mtmux pair` below this parses six digits and refuses the eight the app
    // now shows, with a message that cannot be fixed after the fact.
    expect(semverGte("0.6.3", MIN_PAIR_CLI_VERSION)).toBe(false);
    expect(semverGte("0.7.0", MIN_PAIR_CLI_VERSION)).toBe(true);
  });
});
