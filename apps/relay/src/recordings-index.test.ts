import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const original = process.env.MTMUX_CONFIG_DIR;
let dir: string;
let index: typeof import("./recordings-index.js");

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mtmux-recidx-"));
  process.env.MTMUX_CONFIG_DIR = dir;
  // The module resolves its directory at import time, the way `grants-store.ts`
  // does, so each test needs a fresh instance pointed at its own tmpdir.
  vi.resetModules();
  index = await import("./recordings-index.js");
});

afterEach(() => {
  if (original === undefined) delete process.env.MTMUX_CONFIG_DIR;
  else process.env.MTMUX_CONFIG_DIR = original;
});

function row(over: Partial<import("@repo/protocol").RecordingInfo> = {}) {
  return {
    ...index.startedRecording({
      id: "rec_aaaaaaaaaaaaaaaa",
      filename: "a.cast",
      target: { kind: "session" as const, session: "work" },
      title: "work",
      cols: 80,
      rows: 24,
      startedAt: 1000,
    }),
    ...over,
  };
}

describe("newRecordingId", () => {
  it("matches the id the protocol accepts", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(index.newRecordingId()).toMatch(/^rec_[a-z2-7]{16}$/);
    }
  });

  it("does not repeat", () => {
    const ids = new Set(
      Array.from({ length: 200 }, () => index.newRecordingId()),
    );
    expect(ids.size).toBe(200);
  });
});

describe("recordingFilename", () => {
  it("is built only from values we generate", () => {
    // `pipe-pane` interpolates this path into `/bin/sh -c`. Nothing a caller
    // supplied may reach it.
    const name = index.recordingFilename(
      "rec_aaaaaaaaaaaaaaaa",
      "work; rm -rf ~ #$(id)`whoami`'\"",
      new Date("2026-09-03T17:44:39Z"),
    );
    // Every shell metacharacter is gone; only the letters survive.
    expect(name).toBe(
      "20260903-174439-workrm-rfidwhoami-rec_aaaaaaaaaaaaaaaa.cast",
    );
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("falls back to a slug rather than an empty one", () => {
    expect(index.recordingFilename("rec_aaaaaaaaaaaaaaaa", "日本語")).toContain(
      "-session-",
    );
  });
});

describe("the index file", () => {
  it("round-trips a recording", async () => {
    await index.put(row());
    expect(await index.get("rec_aaaaaaaaaaaaaaaa")).toEqual(row());
    expect(await index.list()).toHaveLength(1);
  });

  it("writes 0600", async () => {
    await index.put(row());
    const file = path.join(dir, "recordings", "index.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("replaces rather than duplicates on a repeat put", async () => {
    await index.put(row());
    await index.put(row({ title: "renamed" }));
    const all = await index.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("renamed");
  });

  it("patches without letting the id be rewritten", async () => {
    await index.put(row());
    const patched = await index.patch("rec_aaaaaaaaaaaaaaaa", {
      endedAt: 5000,
      bytes: 12,
      id: "rec_bbbbbbbbbbbbbbbb" as never,
    });
    expect(patched?.id).toBe("rec_aaaaaaaaaaaaaaaa");
    expect(patched?.endedAt).toBe(5000);
  });

  it("returns null patching something that is not there", async () => {
    expect(await index.patch("rec_bbbbbbbbbbbbbbbb", { bytes: 1 })).toBeNull();
  });

  it("removes the row and the file, and tolerates a missing file", async () => {
    await index.put(row());
    expect(await index.remove("rec_aaaaaaaaaaaaaaaa")).toBe(true);
    expect(await index.list()).toEqual([]);
    expect(await index.remove("rec_aaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("reads a corrupt file as empty, never as fatal", async () => {
    // A hand-edit must not stop the relay booting. The same call
    // `grants-store.ts` makes for `grants.json`.
    await index.put(row());
    await writeFile(path.join(dir, "recordings", "index.json"), "{ not json");
    expect(await index.list()).toEqual([]);
  });

  it("reads a well-formed file with an unknown version as empty", async () => {
    await index.put(row());
    await writeFile(
      path.join(dir, "recordings", "index.json"),
      JSON.stringify({ version: 99, recordings: [] }),
    );
    expect(await index.list()).toEqual([]);
  });

  it("never writes a filesystem path into the index", async () => {
    // The property that keeps `recording:fetch` from being `file:read`.
    await index.put(row());
    const raw = await readFile(
      path.join(dir, "recordings", "index.json"),
      "utf8",
    );
    expect(raw).not.toContain(dir);
    expect(raw).not.toContain("/");
  });
});

describe("sweepRecordings", () => {
  it("closes a row a crash left open, and marks it truncated", async () => {
    await index.put(row({ endedAt: null, bytes: 42 }));
    const { closed } = await index.sweepRecordings();
    expect(closed).toBe(1);

    const swept = await index.get("rec_aaaaaaaaaaaaaaaa");
    expect(swept?.endedAt).toBe(1000);
    expect(swept?.truncated).toBe(true);
    expect(swept?.stopReason).toBe("interrupted");
  });

  it("leaves a properly closed row alone", async () => {
    const closedRow = row({ endedAt: 2000, bytes: 42 });
    await index.put(closedRow);
    await index.sweepRecordings();
    expect(await index.get("rec_aaaaaaaaaaaaaaaa")).toEqual(closedRow);
  });

  it("drops the oldest recordings once the total is over budget", async () => {
    for (const [n, at] of [
      ["a", 1000],
      ["b", 2000],
      ["c", 3000],
    ] as const) {
      await index.put(
        row({
          id: `rec_${n.repeat(16)}`,
          filename: `${n}.cast`,
          startedAt: at,
          endedAt: at + 1,
          bytes: 100,
        }),
      );
    }

    const { dropped } = await index.sweepRecordings(250);
    expect(dropped).toBe(1);
    expect((await index.list()).map((r) => r.filename)).toEqual([
      "b.cast",
      "c.cast",
    ]);
  });

  it("never evicts down to nothing", async () => {
    // A single recording larger than the whole budget is still the only one
    // there is. Deleting it would make the cap a feature that eats your data.
    await index.put(row({ bytes: 10_000, endedAt: 2000 }));
    const { dropped } = await index.sweepRecordings(10);
    expect(dropped).toBe(0);
    expect(await index.list()).toHaveLength(1);
  });

  it("is a no-op on an empty index and never throws", async () => {
    await expect(index.sweepRecordings()).resolves.toEqual({
      closed: 0,
      dropped: 0,
    });
  });
});
