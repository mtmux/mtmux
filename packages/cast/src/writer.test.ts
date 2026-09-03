import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCast } from "./format.js";
import { createCastWriter } from "./writer.js";

let dir: string;
let clock: number;
const now = () => clock;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mtmux-cast-"));
  clock = 0;
});

afterEach(() => {
  clock = 0;
});

function target(name = "rec.cast"): string {
  return path.join(dir, name);
}

describe("createCastWriter", () => {
  it("writes a parseable cast with the header it was given", async () => {
    const file = target();
    const writer = await createCastWriter({
      path: file,
      cols: 80,
      rows: 24,
      title: "work",
      term: "screen-256color",
      now,
    });

    writer.write("hello");
    clock = 1500;
    writer.write("world");
    await writer.stop();

    const cast = parseCast(await readFile(file, "utf8"));
    expect(cast.header.width).toBe(80);
    expect(cast.header.title).toBe("work");
    expect(cast.header.env).toEqual({ TERM: "screen-256color" });
    expect(cast.events).toEqual([
      { time: 0, type: "o", data: "hello" },
      { time: 1.5, type: "o", data: "world" },
    ]);
  });

  it("never records SHELL", async () => {
    const file = target();
    const writer = await createCastWriter({ path: file, cols: 80, rows: 24 });
    await writer.stop();
    expect(await readFile(file, "utf8")).not.toContain("SHELL");
  });

  it("creates the file 0600", async () => {
    // A cast holds every byte that was on screen. Anything wider is a bug.
    const file = target();
    await (await createCastWriter({ path: file, cols: 80, rows: 24 })).stop();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses to open a path that already exists", async () => {
    // `wx`, never `a`: a recording id collision must fail rather than
    // interleave two sessions into one file.
    const file = target();
    await (await createCastWriter({ path: file, cols: 80, rows: 24 })).stop();
    await expect(
      createCastWriter({ path: file, cols: 80, rows: 24 }),
    ).rejects.toThrow(/EEXIST/);
  });

  it("records a resize, and only when the size actually changes", async () => {
    const file = target();
    const writer = await createCastWriter({
      path: file,
      cols: 80,
      rows: 24,
      now,
    });
    writer.resize(80, 24);
    clock = 1000;
    writer.resize(120, 40);
    writer.resize(120, 40);
    await writer.stop();

    const cast = parseCast(await readFile(file, "utf8"));
    expect(cast.events).toEqual([{ time: 1, type: "r", data: "120x40" }]);
  });

  it("stops at the byte limit, keeping the chunk that crossed it", async () => {
    const file = target();
    const writer = await createCastWriter({
      path: file,
      cols: 80,
      rows: 24,
      maxBytes: 40,
      now,
    });

    writer.write("x".repeat(50));
    writer.write("never written");
    const reason = await writer.stop();

    expect(reason).toBe("limit");
    expect(writer.stopReason).toBe("limit");
    const cast = parseCast(await readFile(file, "utf8"));
    expect(cast.events).toHaveLength(1);
    expect(cast.events[0]!.data).toBe("x".repeat(50));
  });

  it("stops at the time limit", async () => {
    const file = target();
    const writer = await createCastWriter({
      path: file,
      cols: 80,
      rows: 24,
      maxMs: 1000,
      now,
    });
    writer.write("a");
    clock = 2000;
    writer.write("b");
    writer.write("c");
    await writer.stop();

    expect(writer.stopReason).toBe("limit");
    const cast = parseCast(await readFile(file, "utf8"));
    expect(cast.events.map((e) => e.data)).toEqual(["a", "b"]);
  });

  it("ignores empty writes", async () => {
    const file = target();
    const writer = await createCastWriter({ path: file, cols: 80, rows: 24 });
    writer.write("");
    await writer.stop();
    expect(writer.events).toBe(0);
  });

  it("is idempotent on stop and keeps the first reason", async () => {
    const writer = await createCastWriter({
      path: target(),
      cols: 80,
      rows: 24,
    });
    const first = await writer.stop("limit");
    const second = await writer.stop("requested");
    expect(first).toBe("limit");
    expect(second).toBe("limit");
    expect(writer.stopReason).toBe("limit");
  });
});
