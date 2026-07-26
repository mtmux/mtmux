import type { SealedDescriptor } from "@repo/protocol";
import type { SessionKeys } from "@repo/crypto";

/**
 * Where a paired session lives in the browser.
 *
 * Key material goes in IndexedDB, never localStorage: an XSS can read
 * localStorage in one line, and today's 64-hex token sitting there is the
 * single worst part of the current design. The descriptor (candidate URLs,
 * tunnel id) is not secret to this origin and lives in sessionStorage so it
 * dies with the tab.
 */

const DB_NAME = "mtmux";
const DB_VERSION = 1;
const KEY_STORE = "session-keys";
const DESCRIPTOR_KEY = "mtmux:session-descriptor";

export type PairedSession = {
  descriptor: SealedDescriptor;
  /** Which candidate won the race last time, so we can try it first. */
  preferredCandidate?: string;
  pairedAt: number;
};

export type StoredKeys = {
  c2s: Uint8Array;
  s2c: Uint8Array;
  confirm: Uint8Array;
  directToken: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(KEY_STORE, mode).objectStore(KEY_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

export async function saveSessionKeys(
  serverId: string,
  keys: SessionKeys,
): Promise<void> {
  const db = await openDb();
  await tx(db, "readwrite", (store) =>
    store.put(
      {
        c2s: keys.c2s,
        s2c: keys.s2c,
        confirm: keys.confirm,
        directToken: keys.directToken,
      },
      serverId,
    ),
  );
  db.close();
}

export async function loadSessionKeys(
  serverId: string,
): Promise<SessionKeys | null> {
  try {
    const db = await openDb();
    const stored = await tx<StoredKeys | undefined>(db, "readonly", (store) =>
      store.get(serverId),
    );
    db.close();
    if (!stored) return null;
    return {
      c2s: new Uint8Array(stored.c2s),
      s2c: new Uint8Array(stored.s2c),
      confirm: new Uint8Array(stored.confirm),
      directToken: stored.directToken,
    };
  } catch {
    // A private-mode browser with IndexedDB blocked simply has no session.
    return null;
  }
}

export async function clearSessionKeys(serverId: string): Promise<void> {
  try {
    const db = await openDb();
    await tx(db, "readwrite", (store) => store.delete(serverId));
    db.close();
  } catch {
    // Nothing to clear.
  }
}

export function saveDescriptor(session: PairedSession): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(DESCRIPTOR_KEY, JSON.stringify(session));
}

export function loadDescriptor(): PairedSession | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(DESCRIPTOR_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PairedSession;
  } catch {
    sessionStorage.removeItem(DESCRIPTOR_KEY);
    return null;
  }
}

export function clearDescriptor(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(DESCRIPTOR_KEY);
}

/** Stable id for a paired machine — its device fingerprint. */
export function serverIdFor(descriptor: SealedDescriptor): string {
  return descriptor.deviceId;
}
