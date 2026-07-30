import { describe, expect, it } from "vitest";
import type { GrantRecord } from "@repo/protocol";

import { parseDuration, parseFiles, shareBanner } from "./share-grants.js";

const NOW = 1_700_000_000_000;

function grant(over: Partial<GrantRecord> = {}): GrantRecord {
  return {
    id: "grn_x",
    label: "test",
    scope: { kind: "sessions", sessions: [{ id: "$1", name: "work" }] },
    readOnly: false,
    files: "none",
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
    tmuxServerPid: null,
    tokenHash: "0".repeat(64),
    ...over,
  };
}

describe("parseDuration", () => {
  it("reads the forms the help text promises", () => {
    expect(parseDuration("24h", NOW)).toBe(NOW + 86_400_000);
    expect(parseDuration("7d", NOW)).toBe(NOW + 7 * 86_400_000);
    expect(parseDuration("30m", NOW)).toBe(NOW + 1_800_000);
    expect(parseDuration("2w", NOW)).toBe(NOW + 14 * 86_400_000);
    expect(parseDuration("never", NOW)).toBeNull();
  });

  it("is case- and space-insensitive", () => {
    expect(parseDuration("  7D ", NOW)).toBe(NOW + 7 * 86_400_000);
    expect(parseDuration("NEVER", NOW)).toBeNull();
  });

  it("refuses input it cannot read rather than defaulting", () => {
    // The failure that matters: `7days` silently becoming "forever" would
    // share a session permanently because of a typo.
    for (const bad of ["7days", "", "soon", "-1d", "1y", "d7"]) {
      expect(parseDuration(bad, NOW), bad).toBeUndefined();
    }
  });
});

describe("parseFiles", () => {
  it("accepts the spellings people type", () => {
    expect(parseFiles(undefined)).toBe("none");
    expect(parseFiles("none")).toBe("none");
    expect(parseFiles("off")).toBe("none");
    expect(parseFiles("ro")).toBe("read");
    expect(parseFiles("read")).toBe("read");
    expect(parseFiles("rw")).toBe("write");
    expect(parseFiles("write")).toBe("write");
  });

  it("refuses anything else", () => {
    expect(parseFiles("yes")).toBeUndefined();
    expect(parseFiles("all")).toBeUndefined();
  });

  it("defaults to none, never to the allow-list", () => {
    // A share of one tmux session must not ship with read+write over $HOME,
    // which is what ALLOWED_PATHS defaults to.
    expect(parseFiles(undefined)).toBe("none");
  });
});

describe("shareBanner", () => {
  it("warns before the code on a read-write share", () => {
    const text = shareBanner(grant(), NOW).join("\n");
    expect(text).toContain("read-write");
    expect(text).toContain("tmux switch-client");
    expect(text).toContain(
      "--read-only for a share that is actually a boundary",
    );
  });

  it("does not warn on a read-only share, because it is a boundary", () => {
    const text = shareBanner(grant({ readOnly: true }), NOW).join("\n");
    expect(text).toContain("read-only");
    expect(text).not.toContain("tmux switch-client");
  });

  it("states the file level and the expiry plainly", () => {
    const text = shareBanner(
      grant({ files: "write", expiresAt: NOW + 3 * 86_400_000 }),
      NOW,
    ).join("\n");
    expect(text).toContain("read-write file access");
    expect(text).toContain("expires in 3 days");
  });

  it("says so when a share never expires", () => {
    expect(shareBanner(grant(), NOW).join("\n")).toContain("never expires");
  });

  it("names the sessions and counts them", () => {
    const text = shareBanner(
      grant({
        scope: {
          kind: "sessions",
          sessions: [
            { id: "$1", name: "work" },
            { id: "$2", name: "logs" },
          ],
        },
      }),
      NOW,
    ).join("\n");
    expect(text).toContain("2 sessions (work, logs)");
  });
});
