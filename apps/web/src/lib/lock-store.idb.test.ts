import { beforeEach, describe, expect, it, vi } from "vitest";
import { openJson, type SealedRecord } from "@repo/crypto";

import {
  enrollPin,
  eraseDevice,
  isSessionLocked,
  lockoutUntil,
  readLockRecord,
  setSessionLock,
  unlockWithPin,
} from "./lock-store";
import {
  KEY_STORE,
  isSealed,
  keysAad,
  loadSessionKeys,
  openDb,
  saveSessionKeys,
  tx,
  type KeyRecord,
} from "./session-store";
import { forget, isEnrolled, isUnlocked, masterKey } from "./unlocked";
import { readSelfHostedToken } from "./storage-keys";

/**
 * The lock, against a real IndexedDB implementation.
 *
 * These live in their own vitest project because they do genuine PBKDF2 and
 * would otherwise be the slowest thing in the fast suite. `fake-indexeddb/auto`
 * runs in the node environment, so no jsdom is dragged in.
 */

const SERVER = "device-abc";

function keys(directToken = "tok-1") {
  return {
    c2s: new Uint8Array([1, 2, 3, 4]),
    s2c: new Uint8Array([5, 6, 7, 8]),
    confirm: new Uint8Array([9, 10]),
    directToken,
  };
}

async function readRaw(serverId: string): Promise<KeyRecord | undefined> {
  const db = await openDb();
  const value = await tx<KeyRecord | undefined>(
    db,
    KEY_STORE,
    "readonly",
    (store) => store.get(serverId),
  );
  db.close();
  return value;
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
  vi.stubGlobal("window", { localStorage: memoryStorage() });
  vi.stubGlobal("localStorage", memoryStorage());
  // Mocks first: the abort test replaces `IDBDatabase.transaction`, and
  // `eraseDevice` is itself a multi-store transaction that the replacement
  // would abort.
  vi.restoreAllMocks();
  await eraseDevice();
  forget();
});

describe("enrollment", () => {
  it("seals every existing key record and leaves nothing in the clear", async () => {
    await saveSessionKeys(SERVER, keys());
    expect(isSealed(await readRaw(SERVER))).toBe(false);

    await enrollPin("123456");

    const raw = await readRaw(SERVER);
    expect(isSealed(raw)).toBe(true);
    // The whole point: the token must not be readable from the stored bytes.
    expect(JSON.stringify(raw)).not.toContain("tok-1");
  });

  it("keeps the keys usable straight afterwards", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");

    const loaded = await loadSessionKeys(SERVER);
    expect(loaded?.directToken).toBe("tok-1");
    expect(Array.from(loaded!.c2s)).toEqual([1, 2, 3, 4]);
  });

  it("seals records written after enrollment too", async () => {
    await enrollPin("123456");
    await saveSessionKeys("device-later", keys("tok-2"));
    expect(isSealed(await readRaw("device-later"))).toBe(true);
  });

  it("leaves the database untouched when the transaction aborts", async () => {
    await saveSessionKeys(SERVER, keys());

    // Force the commit to fail partway. Either everything happened or nothing
    // did — a half-sealed key store is a device that cannot reach its own keys,
    // which is the failure this single transaction exists to make impossible.
    const real = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      names: string | Iterable<string>,
      ...rest: unknown[]
    ) {
      const transaction = real.apply(this, [
        names,
        ...rest,
      ] as unknown as Parameters<typeof real>);
      if (typeof names !== "string" && [...names].length > 1) {
        queueMicrotask(() => transaction.abort());
      }
      return transaction;
    });

    await expect(enrollPin("123456")).rejects.toThrow();
    vi.restoreAllMocks();

    expect(isSealed(await readRaw(SERVER))).toBe(false);
    expect(await readLockRecord()).toBeNull();
  });

  it("refuses a second enrollment rather than orphaning the first", async () => {
    await enrollPin("123456");
    await expect(enrollPin("999999")).rejects.toThrow();
  });
});

describe("unlocking", () => {
  it("opens with the right PIN and stays shut with the wrong one", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    forget();

    expect(await unlockWithPin("000000")).toMatchObject({ ok: false });
    expect(masterKey()).toBeNull();

    expect(await unlockWithPin("123456")).toEqual({ ok: true });
    expect(isUnlocked()).toBe(true);
  });

  it("returns null for sealed keys while locked, rather than throwing", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    forget();

    expect(await loadSessionKeys(SERVER)).toBeNull();
  });

  it("counts the attempt before verifying, so killing the tab is not a free guess", async () => {
    await enrollPin("123456");
    forget();

    await unlockWithPin("000000");
    expect((await readLockRecord())?.failedAttempts).toBe(1);
  });

  it("clears the counter on success", async () => {
    await enrollPin("123456");
    forget();
    await unlockWithPin("000000");
    await unlockWithPin("123456");
    expect((await readLockRecord())?.failedAttempts).toBe(0);
  });

  it("throttles rather than allowing unlimited guesses", async () => {
    await enrollPin("123456");
    forget();
    for (let i = 0; i < 4; i += 1) await unlockWithPin("000000");

    const outcome = await unlockWithPin("000000");
    expect(outcome).toMatchObject({ ok: false, reason: "throttled" });
    // Even the correct PIN waits — otherwise the throttle is advisory.
    expect(await unlockWithPin("123456")).toMatchObject({
      reason: "throttled",
    });
  });

  it("is off by default for wiping, so ten mistakes are recoverable", async () => {
    await enrollPin("123456");
    expect((await readLockRecord())?.wipeAfter10).toBe(false);
  });
});

describe("lockoutUntil", () => {
  it("gives three free attempts, then doubles, then caps", () => {
    expect(lockoutUntil(1, 0)).toBeNull();
    expect(lockoutUntil(3, 0)).toBeNull();
    expect(lockoutUntil(4, 0)).toBe(2_000);
    expect(lockoutUntil(5, 0)).toBe(4_000);
    // The cap matters: uncapped doubling reaches "come back tomorrow" and
    // punishes the owner, not the attacker with a copy of the database.
    expect(lockoutUntil(40, 0)).toBe(15 * 60_000);
  });
});

describe("per-session lock", () => {
  it("stores the flag inside the sealed record, never beside it", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    await setSessionLock(SERVER, "prod", true);

    const raw = await readRaw(SERVER);
    expect(isSealed(raw)).toBe(true);
    // The list of which sessions are marked is itself the sensitive part.
    expect(JSON.stringify(raw)).not.toContain("prod");

    const opened = openJson<{ sessionLocks?: Record<string, true> }>(
      masterKey()!,
      raw as SealedRecord,
      keysAad(SERVER),
    );
    expect(opened.sessionLocks).toEqual({ prod: true });
    expect(isSessionLocked(SERVER, "prod")).toBe(true);
  });

  it("unsets cleanly", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    await setSessionLock(SERVER, "prod", true);
    await setSessionLock(SERVER, "prod", false);
    expect(isSessionLocked(SERVER, "prod")).toBe(false);
  });

  it("survives a lock and unlock", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    await setSessionLock(SERVER, "prod", true);

    forget();
    await unlockWithPin("123456");
    await loadSessionKeys(SERVER);

    expect(isSessionLocked(SERVER, "prod")).toBe(true);
  });
});

describe("the self-hosted token", () => {
  it("moves out of localStorage on enrollment and comes back on unlock", async () => {
    // On the self-hosted path this is a *working credential* sitting in a
    // store any script on the origin can read, surviving a lock that encrypts
    // everything else.
    localStorage.setItem("mtmux-token", "self-hosted-secret");

    await enrollPin("123456");
    expect(localStorage.getItem("mtmux-token")).toBeNull();
    expect(readSelfHostedToken()).toBe("self-hosted-secret");

    forget();
    expect(readSelfHostedToken()).toBeNull();

    await unlockWithPin("123456");
    expect(readSelfHostedToken()).toBe("self-hosted-secret");
  });

  it("leaves localStorage alone on a device with no lock", async () => {
    localStorage.setItem("mtmux-token", "self-hosted-secret");
    expect(readSelfHostedToken()).toBe("self-hosted-secret");
    expect(localStorage.getItem("mtmux-token")).toBe("self-hosted-secret");
  });
});

describe("eraseDevice", () => {
  it("leaves nothing behind", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");

    await eraseDevice();

    expect(await readLockRecord()).toBeNull();
    expect(await readRaw(SERVER)).toBeUndefined();
    expect(isEnrolled()).toBe(false);
    expect(isUnlocked()).toBe(false);
  });
});
