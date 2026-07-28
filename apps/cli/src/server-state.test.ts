import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let serverState: typeof import("./server-state.js");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mtmux-state-"));
  process.env.MTMUX_CONFIG_DIR = dir;
  // The module reads MTMUX_CONFIG_DIR at import time, so it must be re-imported
  // once the temporary directory exists.
  vi.resetModules();
  serverState = await import("./server-state.js");
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.MTMUX_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

function record(
  overrides: Partial<import("./server-state.js").ServerState> = {},
) {
  return {
    pid: process.pid,
    port: 14100,
    host: "0.0.0.0",
    localUrl: "http://localhost:14100",
    lanUrl: "http://192.168.1.5:14100",
    mode: "tunnel" as const,
    inviteUrl: "https://app.mtmux.com/j#482913",
    startedAt: Date.now(),
    version: "0.4.0",
    ...overrides,
  };
}

describe("read", () => {
  it("returns null when nothing was ever written", async () => {
    expect(await serverState.read()).toBeNull();
  });

  it("round-trips a record for a live process", async () => {
    // Our own pid is guaranteed alive, and /health is stubbed below.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await serverState.write(record());
    const state = await serverState.read();
    expect(state?.port).toBe(14100);
    expect(state?.mode).toBe("tunnel");
  });

  /**
   * The case that makes this file worth having: a machine that lost power
   * leaves a record behind, and reporting it as "running" would make `status`
   * lie and make the next `start` think the port was taken.
   */
  it("deletes a record whose process is gone", async () => {
    // pid 2^22 + 1 is above the default pid_max, so it cannot exist.
    await serverState.write(record({ pid: 4_194_305 }));
    expect(await serverState.read()).toBeNull();
    await expect(readFile(join(dir, "server.json"), "utf8")).rejects.toThrow();
  });

  it("keeps a record whose process is alive but not yet serving", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    await serverState.write(record());
    // Mid-boot, or wedged — either way the record may become valid a moment
    // later, so it must survive.
    expect(await serverState.read()).not.toBeNull();
  });

  it("survives a corrupted file rather than throwing", async () => {
    await writeFile(join(dir, "server.json"), "{ not json");
    expect(await serverState.read()).toBeNull();
  });
});

describe("stop", () => {
  it("reports not-running when there is no record", async () => {
    expect(await serverState.stop()).toBe("not-running");
  });

  it("reports not-running when the recorded process is already gone", async () => {
    await serverState.write(record({ pid: 4_194_305 }));
    expect(await serverState.stop()).toBe("not-running");
  });

  it("reports denied when the process belongs to someone else", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await serverState.write(record());
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      // `read()` probes with signal 0 first; only the real SIGTERM is denied.
      if (signal === 0) return true;
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    expect(await serverState.stop()).toBe("denied");
  });

  it("clears the record once the process exits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await serverState.write(record());

    let signalled = false;
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM") {
        signalled = true;
        return true;
      }
      // Alive until signalled, gone afterwards.
      if (signalled) throw new Error("ESRCH");
      return true;
    });

    expect(await serverState.stop()).toBe("stopped");
    expect(await serverState.read()).toBeNull();
  });
});
