import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  transportFor,
  describeGrant,
  record,
  readAccessLog,
} from "./access-log.js";
import { FULL_GRANT } from "./grant.js";
import type { GrantRecord } from "@repo/protocol";

const base = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "relay-access-")),
);
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("transportFor", () => {
  it("calls a loopback peer loopback", () => {
    expect(transportFor("127.0.0.1")).toBe("loopback");
    expect(transportFor("::1")).toBe("loopback");
    expect(transportFor("::ffff:127.0.0.1")).toBe("loopback");
  });

  it("calls anything else lan", () => {
    expect(transportFor("192.168.1.44")).toBe("lan");
    expect(transportFor("::ffff:10.0.0.2")).toBe("lan");
  });

  /**
   * A tunnelled browser reaches the relay through the agent, on loopback, so
   * the address alone cannot tell it apart from someone at the keyboard —
   * which is exactly the distinction the machine's owner cares about.
   */
  it("recognises the tunnel agent despite its loopback address", () => {
    expect(transportFor("127.0.0.1", "mtmux-tunnel-agent")).toBe("tunnel");
  });

  it("does not let an arbitrary user-agent claim to be the tunnel", () => {
    expect(transportFor("192.168.1.44", "Mozilla/5.0")).toBe("lan");
  });
});

describe("describeGrant", () => {
  it("records the full grant as scope all with no id", () => {
    // The machine's own AUTH_TOKEN. There is no share to name.
    expect(describeGrant(FULL_GRANT)).toEqual({
      grantId: null,
      scope: "all",
      readOnly: false,
      files: FULL_GRANT.files,
    });
  });

  it("records a scoped share's id, scope and limits", () => {
    const grant: GrantRecord = {
      ...FULL_GRANT,
      id: "grn_abc",
      readOnly: true,
      files: "read",
      scope: { kind: "sessions", sessions: [{ id: "$1", name: "work" }] },
    };
    expect(describeGrant(grant)).toEqual({
      grantId: "grn_abc",
      scope: "sessions",
      readOnly: true,
      files: "read",
    });
  });
});

describe("record and read back", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(base, "run-"));
    logPath = path.join(dir, "access.log");
  });

  it("appends NDJSON at 0600 and reads it back in order", async () => {
    await record(
      {
        at: "2026-09-09T00:00:00.000Z",
        event: "connected",
        grantId: null,
        scope: "all",
        readOnly: false,
        files: "write",
        label: "iPhone",
        transport: "lan",
      },
      logPath,
    );
    await record(
      {
        at: "2026-09-09T00:01:00.000Z",
        event: "disconnected",
        grantId: null,
        scope: "all",
        readOnly: false,
        files: "write",
        label: "iPhone",
        transport: "lan",
        seconds: 60,
      },
      logPath,
    );

    const events = await readAccessLog(logPath);
    expect(events.map((e) => e.event)).toEqual(["connected", "disconnected"]);
    expect(events[1]!.seconds).toBe(60);

    const mode = fs.statSync(logPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns nothing when the log does not exist yet", async () => {
    expect(await readAccessLog(path.join(dir, "nope.log"))).toEqual([]);
  });

  it("skips a truncated final line rather than refusing the whole file", async () => {
    const p = path.join(dir, "partial.log");
    fs.writeFileSync(p, '{"event":"connected"}\n{"event":"disc');
    const events = await readAccessLog(p);
    expect(events).toHaveLength(1);
  });

  /** A full disk must never be able to deny someone their own machine. */
  it("never throws when the log cannot be written", async () => {
    // A regular file where a directory has to be: ENOTDIR, which is the same
    // shape of failure as a read-only home or a full disk.
    const blocker = path.join(dir, "blocked");
    fs.writeFileSync(blocker, "not a directory");
    await expect(
      record(
        {
          at: "2026-09-09T00:00:00.000Z",
          event: "connected",
          grantId: null,
          scope: "all",
          readOnly: false,
          files: "write",
          label: null,
          transport: "loopback",
        },
        path.join(blocker, "access.log"),
      ),
    ).resolves.toBeUndefined();
  });
});
