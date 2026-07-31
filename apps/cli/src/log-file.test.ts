import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `~/.mtmux/logs` is resolved at import time from `MTMUX_CONFIG_DIR`, so every
 * test here needs the env var set before the module is loaded — hence the
 * dynamic import and the module-registry reset.
 */
let dir: string;
let mod: typeof import("./log-file.js");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mtmux-logs-"));
  process.env.MTMUX_CONFIG_DIR = dir;
  vi.resetModules();
  mod = await import("./log-file.js");
});

afterEach(async () => {
  delete process.env.MTMUX_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("rotateIfNeeded", () => {
  it("does nothing when there is no log yet", async () => {
    await expect(mod.rotateIfNeeded()).resolves.toBeUndefined();
    expect(await readdir(mod.LOG_DIR)).toEqual([]);
  });

  it("leaves a log that is under the cap alone", async () => {
    await mod.rotateIfNeeded(); // creates the directory
    await writeFile(mod.LOG_PATH, "small\n");
    await mod.rotateIfNeeded(mod.LOG_PATH, 1024);
    expect(await readdir(mod.LOG_DIR)).toEqual(["mtmux.log"]);
  });

  it("rolls a log past the cap and keeps a bounded history", async () => {
    // Rotation happens once at startup rather than per line, because rotating
    // while pino holds the fd leaves it writing into an unlinked inode.
    for (let i = 0; i < 6; i += 1) {
      await mod.rotateIfNeeded(); // ensure the dir exists
      await writeFile(mod.LOG_PATH, "x".repeat(64));
      await mod.rotateIfNeeded(mod.LOG_PATH, 32);
    }
    const files = (await readdir(mod.LOG_DIR)).sort();
    expect(files).toEqual(["mtmux.log.1", "mtmux.log.2", "mtmux.log.3"]);
  });
});

describe("tailLines", () => {
  it("returns the last n lines, oldest first", async () => {
    await mod.rotateIfNeeded();
    await writeFile(
      mod.LOG_PATH,
      ["one", "two", "three", "four"].join("\n") + "\n",
    );
    expect(await mod.tailLines(2)).toEqual(["three", "four"]);
    expect(await mod.tailLines(99)).toEqual(["one", "two", "three", "four"]);
  });

  it("reaches back into rotated files when the live one is short", async () => {
    await mod.rotateIfNeeded();
    await writeFile(`${mod.LOG_PATH}.1`, "older-a\nolder-b\n");
    await writeFile(mod.LOG_PATH, "newest\n");
    expect(await mod.tailLines(3)).toEqual(["older-a", "older-b", "newest"]);
  });

  it("is empty rather than throwing when nothing has been logged", async () => {
    expect(await mod.tailLines(50)).toEqual([]);
  });

  it("skips blank lines", async () => {
    await mod.rotateIfNeeded();
    await writeFile(mod.LOG_PATH, "a\n\n   \nb\n");
    expect(await mod.tailLines(10)).toEqual(["a", "b"]);
  });
});
