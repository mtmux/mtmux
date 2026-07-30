import { describe, it, expect } from "vitest";
import type { SessionInfo } from "@repo/protocol";
import {
  askSessions,
  collectTargets,
  orderCandidates,
  runCensus,
  type CensusCache,
  type CensusConnector,
  type CensusProbe,
  type CensusRow,
  type CensusSnapshot,
  type CensusTarget,
} from "./session-census";

function session(name: string): SessionInfo {
  return {
    name,
    id: `$${name}`,
    windows: 1,
    attached: false,
    created: "0",
    activity: "0",
  };
}

function snapshot(names: string[], observedAt = 1_000): CensusSnapshot {
  return { sessions: names.map(session), capabilities: null, observedAt };
}

function targets(...ids: string[]): CensusTarget[] {
  return ids.map((serverId) => ({ serverId, name: serverId }));
}

/** A cache that starts from a plain object, so a test can preload it. */
function memoryCache(seed: Record<string, CensusSnapshot> = {}): CensusCache & {
  written: string[];
} {
  const store = new Map(Object.entries(seed));
  const written: string[] = [];
  return {
    written,
    read: async (id) => store.get(id) ?? null,
    write: async (id, value) => {
      store.set(id, value);
      written.push(id);
    },
  };
}

/** A promise plus the handles to settle it later. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runCensus", () => {
  it("asks every machine and returns a row each, in the order given", async () => {
    const probe: CensusProbe = async (target) => snapshot([target.serverId]);
    const rows = await runCensus({ targets: targets("a", "b", "c"), probe });

    expect(rows.map((r) => r.serverId)).toEqual(["a", "b", "c"]);
    expect(rows.every((r) => r.source === "live")).toBe(true);
    expect(rows.every((r) => r.pending === false)).toBe(true);
  });

  it("never has more than four probes in flight at once", async () => {
    // The bound is the whole point: a phone with eight machines must not open
    // eight sockets, and an unbounded fan-out is the easy accident here.
    let inFlight = 0;
    let peak = 0;
    const gates = new Map<
      string,
      ReturnType<typeof deferred<CensusSnapshot>>
    >();

    const probe: CensusProbe = (target) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const gate = deferred<CensusSnapshot>();
      gates.set(target.serverId, gate);
      return gate.promise.finally(() => {
        inFlight -= 1;
      });
    };

    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const run = runCensus({
      targets: targets(...ids),
      probe,
      timeoutMs: 5_000,
    });

    // Let the pool fill, then release one at a time. Peak must stay at four
    // however the releases interleave.
    await settle();
    expect(gates.size).toBe(4);
    expect(peak).toBe(4);

    for (const id of ids) {
      let gate = gates.get(id);
      while (!gate) {
        await settle();
        gate = gates.get(id);
      }
      gate.resolve(snapshot([id]));
      await settle();
    }

    const rows = await run;
    expect(rows).toHaveLength(8);
    expect(peak).toBe(4);
  });

  it("keeps going when one machine is offline", async () => {
    const probe: CensusProbe = async (target) => {
      if (target.serverId === "dead") throw new Error("no route to host");
      return snapshot([target.serverId]);
    };

    const rows = await runCensus({
      targets: targets("dead", "b", "c"),
      probe,
      concurrency: 1,
    });

    const dead = rows.find((r) => r.serverId === "dead")!;
    expect(dead.error).toBe("no route to host");
    expect(dead.pending).toBe(false);
    expect(rows.filter((r) => r.source === "live")).toHaveLength(2);
  });

  it("bounds a machine that accepts the call and then goes quiet", async () => {
    // Never resolving is the failure mode that produces an endless spinner.
    const probe: CensusProbe = (target) =>
      target.serverId === "hung"
        ? new Promise<CensusSnapshot>(() => {})
        : Promise.resolve(snapshot([target.serverId]));

    const rows = await runCensus({
      targets: targets("hung", "b"),
      probe,
      timeoutMs: 20,
    });

    expect(rows.find((r) => r.serverId === "hung")!.error).toBe("Timed out");
    expect(rows.find((r) => r.serverId === "b")!.sessions).toHaveLength(1);
  });

  it("shows the offline machine's last known sessions rather than nothing", async () => {
    const cache = memoryCache({ dead: snapshot(["deploy"], 500) });
    const probe: CensusProbe = async () => {
      throw new Error("unreachable");
    };

    const [row] = await runCensus({ targets: targets("dead"), probe, cache });

    expect(row!.sessions.map((s) => s.name)).toEqual(["deploy"]);
    expect(row!.observedAt).toBe(500);
    expect(row!.source).toBe("cache");
    expect(row!.error).toBe("unreachable");
  });

  it("emits the cached answer before the network one", async () => {
    const cache = memoryCache({ a: snapshot(["old"], 500) });
    const gate = deferred<CensusSnapshot>();
    const probe: CensusProbe = () => gate.promise;

    const seen: CensusRow[] = [];
    const run = runCensus({
      targets: targets("a"),
      probe,
      cache,
      onUpdate: (row) => seen.push({ ...row }),
      timeoutMs: 5_000,
    });

    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.source).toBe("cache");
    expect(seen[0]!.pending).toBe(true);
    expect(seen[0]!.sessions.map((s) => s.name)).toEqual(["old"]);

    gate.resolve(snapshot(["new"], 2_000));
    const rows = await run;

    expect(seen).toHaveLength(2);
    expect(seen[1]!.source).toBe("live");
    expect(seen[1]!.pending).toBe(false);
    expect(rows[0]!.sessions.map((s) => s.name)).toEqual(["new"]);
    expect(cache.written).toEqual(["a"]);
  });

  it("does not spend tunnel bytes on a fresh cache, and says so quietly", async () => {
    const cache = memoryCache({ a: snapshot(["work"], 9_000) });
    const asked: boolean[] = [];
    // null means "declined to look" — the row must not read as an error.
    const probe: CensusProbe = async (_target, options) => {
      asked.push(options.allowTunnel);
      return null;
    };

    const [row] = await runCensus({
      targets: targets("a"),
      probe,
      cache,
      staleMs: 60_000,
      now: () => 10_000,
    });

    expect(asked).toEqual([false]);
    expect(row!.error).toBeNull();
    expect(row!.source).toBe("cache");
    expect(row!.sessions.map((s) => s.name)).toEqual(["work"]);
    expect(cache.written).toEqual([]);
  });

  it("allows the tunnel once the cache has gone stale, or the user asks", async () => {
    const cache = memoryCache({ a: snapshot(["work"], 0) });
    const asked: boolean[] = [];
    const probe: CensusProbe = async (_target, options) => {
      asked.push(options.allowTunnel);
      return snapshot(["work"]);
    };

    await runCensus({
      targets: targets("a"),
      probe,
      cache,
      staleMs: 1_000,
      now: () => 10_000,
    });
    await runCensus({
      targets: targets("a"),
      probe,
      cache,
      staleMs: 60_000,
      now: () => 10_000,
      force: true,
    });

    expect(asked).toEqual([true, true]);
  });

  it("reads the active machine from its live connection instead of probing it", async () => {
    const probed: string[] = [];
    const probe: CensusProbe = async (target) => {
      probed.push(target.serverId);
      return snapshot([target.serverId]);
    };

    const rows = await runCensus({
      targets: targets("open", "other"),
      probe,
      live: new Map([["open", snapshot(["live-one"], 42)]]),
    });

    expect(probed).toEqual(["other"]);
    const open = rows.find((r) => r.serverId === "open")!;
    expect(open.source).toBe("active");
    expect(open.sessions.map((s) => s.name)).toEqual(["live-one"]);
  });

  it("survives a cache that throws in both directions", async () => {
    const cache: CensusCache = {
      read: async () => {
        throw new Error("blocked");
      },
      write: async () => {
        throw new Error("blocked");
      },
    };
    const probe: CensusProbe = async () => snapshot(["work"]);

    const [row] = await runCensus({ targets: targets("a"), probe, cache });
    expect(row!.sessions.map((s) => s.name)).toEqual(["work"]);
    expect(row!.error).toBeNull();
  });

  it("returns nothing, and asks nothing, with no machines", async () => {
    let calls = 0;
    const probe: CensusProbe = async () => {
      calls += 1;
      return snapshot([]);
    };
    expect(await runCensus({ targets: [], probe })).toEqual([]);
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// askSessions — one connection's worth of conversation
// ---------------------------------------------------------------------------

type Script = "list" | "refuse" | "hangup" | "silent";

function connector(script: Script, sent: string[] = []): CensusConnector {
  return (handlers) => {
    queueMicrotask(() => {
      if (script === "hangup") {
        handlers.onClose();
        return;
      }
      handlers.onOpen();
      if (script === "refuse") {
        handlers.onMessage(
          JSON.stringify({ type: "auth:failure", reason: "unknown device" }),
        );
        return;
      }
      if (script === "silent") return;
      handlers.onMessage(
        JSON.stringify({
          type: "auth:success",
          serverVersion: "1.0.0",
          capabilities: { readOnly: true, files: "none", scope: "sessions" },
        }),
      );
      handlers.onMessage(
        JSON.stringify({ type: "session:list", sessions: [session("work")] }),
      );
    });
    return {
      send: (text) => sent.push(text),
      close: () => sent.push("<closed>"),
    };
  };
}

describe("askSessions", () => {
  it("authenticates, asks once, and hangs up", async () => {
    const sent: string[] = [];
    const result = await askSessions(connector("list", sent), "tok", 500);

    expect(result.sessions.map((s) => s.name)).toEqual(["work"]);
    expect(result.capabilities).toEqual({
      readOnly: true,
      files: "none",
      scope: "sessions",
    });
    expect(
      sent.map((s) => (s === "<closed>" ? s : JSON.parse(s).type)),
    ).toEqual(["auth", "session:list", "<closed>"]);
  });

  it("rejects when the machine refuses this device", async () => {
    await expect(askSessions(connector("refuse"), "tok", 500)).rejects.toThrow(
      "unknown device",
    );
  });

  it("rejects when the connection drops before an answer", async () => {
    await expect(askSessions(connector("hangup"), "tok", 500)).rejects.toThrow(
      /closed the connection/,
    );
  });

  it("closes the socket when the machine never answers", async () => {
    const sent: string[] = [];
    await expect(
      askSessions(connector("silent", sent), "tok", 20),
    ).rejects.toThrow("Timed out");
    expect(sent).toContain("<closed>");
  });
});

// ---------------------------------------------------------------------------
// collectTargets
// ---------------------------------------------------------------------------

describe("collectTargets", () => {
  it("uses the browser's own pairings when signed out", async () => {
    // Invariant #5: the dashboard is not an account feature. No broker call is
    // made at all here, and the names come from the pairing itself.
    const found = await collectTargets({
      listPaired: async () => ["aa11", "bb22"],
      readLabel: async (id) => `label-${id}`,
    });

    expect(found).toEqual([
      { serverId: "aa11", name: "label-aa11", online: undefined },
      { serverId: "bb22", name: "label-bb22", online: undefined },
    ]);
  });

  it("takes human names and the online hint from the account when there is one", async () => {
    const found = await collectTargets({
      listPaired: async () => ["aa11"],
      readLabel: async () => "gagan@thinkpad",
      fetchServers: async () => [
        { serverId: "aa11", name: "Build box", online: true },
        { serverId: "zz99", name: "Never paired here", online: true },
      ],
    });

    // The account may know about machines this browser cannot open. They have
    // no sessions to show, so they are not rows here.
    expect(found).toEqual([
      { serverId: "aa11", name: "Build box", online: true },
    ]);
  });

  it("falls back to the pairing's own label when the broker is unreachable", async () => {
    const found = await collectTargets({
      listPaired: async () => ["aa11"],
      readLabel: async () => "gagan@thinkpad",
      fetchServers: async () => {
        throw new Error("401");
      },
    });

    expect(found).toEqual([
      { serverId: "aa11", name: "gagan@thinkpad", online: undefined },
    ]);
  });

  it("never calls the broker when this browser has no pairings", async () => {
    let called = false;
    const found = await collectTargets({
      listPaired: async () => [],
      fetchServers: async () => {
        called = true;
        return [];
      },
    });
    expect(found).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("orderCandidates", () => {
  const descriptor = {
    candidates: ["http://a", "http://b", "http://c"],
    tunnelId: "t",
    deviceId: "d",
    publicKey: "p",
    label: "l",
  };

  it("tries last time's winner first, without repeating it", () => {
    expect(orderCandidates(descriptor, "http://b")).toEqual([
      "http://b",
      "http://a",
      "http://c",
    ]);
  });

  it("keeps the descriptor's own order when nothing has won yet", () => {
    expect(orderCandidates(descriptor)).toEqual([
      "http://a",
      "http://b",
      "http://c",
    ]);
  });
});

/** Let every pending microtask and timer-free continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
