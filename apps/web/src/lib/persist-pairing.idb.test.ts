import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SealedDescriptor } from "@repo/protocol";
import type { SessionKeys } from "@repo/crypto";

import { pairedMessage, persistPairing } from "./persist-pairing";
import * as candidateRace from "./candidate-race";
import { eraseDevice } from "./lock-store";
import { loadDescriptor, loadSessionKeys, serverIdFor } from "./session-store";
import { forget } from "./unlocked";

/**
 * The three steps every finished handshake runs, against a real IndexedDB.
 *
 * There are three callers — `/j`, `/pair` and the dashboard's request dialog —
 * and before this module they were three copies of the same fifteen lines.
 * What these tests pin is the part that is easy to get subtly wrong in a copy:
 * the *order*, and the fact that a descriptor is never written without the keys
 * that make it usable.
 */

const DESCRIPTOR: SealedDescriptor = {
  candidates: ["http://192.168.1.5:14100", "http://10.0.0.9:14100"],
  tunnelId: "tnl-abcdefgh",
  deviceId: "0".repeat(16),
  publicKey: "1".repeat(64),
  label: "gagan@thinkpad",
};

function keys(): SessionKeys {
  return {
    c2s: new Uint8Array([1, 2, 3, 4]),
    s2c: new Uint8Array([5, 6, 7, 8]),
    confirm: new Uint8Array([9, 10]),
    directToken: "tok-1",
  };
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

beforeEach(async () => {
  const session = memoryStorage();
  vi.stubGlobal("window", { sessionStorage: session });
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", memoryStorage());
  vi.restoreAllMocks();
  await eraseDevice();
  forget();
});

describe("persistPairing", () => {
  it("records the winning candidate, so the next load goes direct", async () => {
    vi.spyOn(candidateRace, "raceCandidates").mockResolvedValue({
      winner: "http://10.0.0.9:14100",
      elapsedMs: 12,
    });

    const result = await persistPairing({
      keys: keys(),
      descriptor: DESCRIPTOR,
    });

    expect(result.winner).toBe("http://10.0.0.9:14100");
    expect(result.serverId).toBe(serverIdFor(DESCRIPTOR));
    expect(loadDescriptor()?.preferredCandidate).toBe("http://10.0.0.9:14100");
  });

  it("leaves the candidate unset when nothing direct answers", async () => {
    vi.spyOn(candidateRace, "raceCandidates").mockResolvedValue({
      winner: null,
      elapsedMs: 800,
    });

    const result = await persistPairing({
      keys: keys(),
      descriptor: DESCRIPTOR,
    });

    expect(result.winner).toBeNull();
    // Undefined rather than null: `resolveRelayWsUrl` reads its absence as
    // "everything rides the tunnel".
    expect(loadDescriptor()?.preferredCandidate).toBeUndefined();
  });

  it("stores keys that can be read back for the same machine", async () => {
    vi.spyOn(candidateRace, "raceCandidates").mockResolvedValue({
      winner: null,
      elapsedMs: 5,
    });

    await persistPairing({ keys: keys(), descriptor: DESCRIPTOR });

    const stored = await loadSessionKeys(serverIdFor(DESCRIPTOR));
    expect(stored?.directToken).toBe("tok-1");
    expect(stored?.c2s).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  /**
   * The ordering that matters. The descriptor is what every reader uses to
   * decide there is a session at all, so writing it before the keys opens a
   * window where the app believes it is paired and cannot decrypt anything.
   */
  it("writes no descriptor when the keys cannot be saved", async () => {
    vi.spyOn(candidateRace, "raceCandidates").mockResolvedValue({
      winner: null,
      elapsedMs: 5,
    });
    const sessionStore = await import("./session-store");
    vi.spyOn(sessionStore, "saveSessionKeys").mockRejectedValue(
      new Error("This device is locked."),
    );

    await expect(
      persistPairing({ keys: keys(), descriptor: DESCRIPTOR }),
    ).rejects.toThrow(/locked/i);

    expect(loadDescriptor()).toBeNull();
  });
});

describe("pairedMessage", () => {
  it("says how the connection was made, because it changes what to expect", () => {
    expect(pairedMessage(DESCRIPTOR, "http://10.0.0.9:14100")).toBe(
      "Connected to gagan@thinkpad directly",
    );
    expect(pairedMessage(DESCRIPTOR, null)).toBe(
      "Connected to gagan@thinkpad over the relay",
    );
  });
});
