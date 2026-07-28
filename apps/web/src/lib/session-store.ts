import type { SealedDescriptor } from "@repo/protocol";
import type { SessionKeys } from "@repo/crypto";

/**
 * Where a paired session lives in the browser.
 *
 * Key material goes in IndexedDB, never localStorage: an XSS can read
 * localStorage in one line, and today's 64-hex token sitting there is the
 * single worst part of the current design.
 *
 * ## Why the descriptor is in IndexedDB too
 *
 * It used to live only in sessionStorage, "so it dies with the tab" — which
 * sounded like a security property and was really just a bug. The keys survive
 * a reload in IndexedDB; the descriptor did not, so a refresh left the browser
 * holding a working key schedule with no idea where to use it and sent the user
 * back to re-pair. Nothing about candidate URLs and a tunnel id is more secret
 * than the keys that are the only way to use them.
 *
 * So the durable copy is in IndexedDB, keyed by the paired machine's device id,
 * and sessionStorage is kept as a synchronous mirror — `resolveRelayWsUrl` and
 * the `/file` URL builders are called during render and cannot await. Call
 * `hydrateDescriptor()` once on boot to refill the mirror from the durable
 * copy.
 *
 * ## What is deliberately not in the durable record
 *
 * `directToken`. Not because persisting it would be new exposure — it is
 * derived from the pairing keys and `saveSessionKeys` already writes it to
 * IndexedDB under the same device id — but because a second copy is a second
 * thing to get wrong, with nothing to gain. `hydrateDescriptor` reads it back
 * out of the keys record and puts it in the tab-scoped mirror, so its
 * synchronous availability stays exactly as wide as before and its persistent
 * footprint stays exactly one record.
 */

const DB_NAME = "mtmux";
/** v2 adds the descriptor store; v1 databases are upgraded in place. */
const DB_VERSION = 2;
const KEY_STORE = "session-keys";
const DESCRIPTOR_STORE = "descriptors";
const DESCRIPTOR_KEY = "mtmux:session-descriptor";

export type PairedSession = {
  descriptor: SealedDescriptor;
  /** Which candidate won the race last time, so we can try it first. */
  preferredCandidate?: string;
  /**
   * The derived relay token, carried alongside the descriptor in memory.
   *
   * `/file` requests are plain HTTP — an `<a download>` navigation cannot carry
   * an Authorization header, and `fetch` callers are synchronous — so the token
   * has to be readable without awaiting IndexedDB. It therefore lives in the
   * sessionStorage mirror, never in localStorage and never in the durable
   * record: the one persistent copy is the one `saveSessionKeys` already writes
   * to IndexedDB, and `hydrateDescriptor` reads it back from there. This is a
   * 24-hour scoped session token, the same class of credential as the
   * self-hosted path's `mtmux-token`, not the machine's long-lived
   * AUTH_TOKEN — which never reaches the browser at all.
   */
  directToken?: string;
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
      if (!db.objectStoreNames.contains(DESCRIPTOR_STORE)) {
        db.createObjectStore(DESCRIPTOR_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

function tx<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(storeName, mode).objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

export async function saveSessionKeys(
  serverId: string,
  keys: SessionKeys,
): Promise<void> {
  const db = await openDb();
  await tx(db, KEY_STORE, "readwrite", (store) =>
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
    const stored = await tx<StoredKeys | undefined>(
      db,
      KEY_STORE,
      "readonly",
      (store) => store.get(serverId),
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
    await tx(db, KEY_STORE, "readwrite", (store) => store.delete(serverId));
    db.close();
  } catch {
    // Nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// The descriptor: durable in IndexedDB, mirrored in sessionStorage
// ---------------------------------------------------------------------------

/** What actually survives a reload — see the note at the top of this file. */
type StoredDescriptor = Omit<PairedSession, "directToken">;

function writeMirror(session: PairedSession): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(DESCRIPTOR_KEY, JSON.stringify(session));
}

/**
 * Persist a completed pairing.
 *
 * The mirror is written synchronously because the very next thing the caller
 * does is navigate to the terminal, where `resolveRelayWsUrl` reads it during
 * render. The durable copy follows on its own; a browser that blocks IndexedDB
 * still gets a working session for the life of the tab.
 */
export function saveDescriptor(session: PairedSession): void {
  writeMirror(session);
  void (async () => {
    try {
      const { directToken: _omitted, ...durable } = session;
      const db = await openDb();
      await tx(db, DESCRIPTOR_STORE, "readwrite", (store) =>
        store.put(
          durable satisfies StoredDescriptor,
          serverIdFor(session.descriptor),
        ),
      );
      db.close();
    } catch {
      // Private mode, or a blocked upgrade. The tab still works.
    }
  })();
}

/** Synchronous read of the tab's mirror. Never touches IndexedDB. */
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

/**
 * Refill the mirror from IndexedDB, so a reload does not force a re-pair.
 *
 * Call this once before anything reads `loadDescriptor()` in a fresh tab. It is
 * a no-op when the mirror is already populated, so calling it on every route is
 * cheap. The most recent pairing wins when a browser has several paired
 * machines: there is one active session at a time and it is the one the user
 * last chose.
 */
export async function hydrateDescriptor(): Promise<PairedSession | null> {
  if (typeof window === "undefined") return null;
  const mirrored = loadDescriptor();
  if (mirrored) return mirrored;

  try {
    const db = await openDb();
    const stored = await tx<StoredDescriptor[]>(
      db,
      DESCRIPTOR_STORE,
      "readonly",
      (store) => store.getAll(),
    );
    db.close();

    const newest = stored
      .filter((s) => s?.descriptor)
      .sort((a, b) => b.pairedAt - a.pairedAt)[0];
    if (!newest) return null;

    // The token is not in the durable record on purpose; it comes back out of
    // the keys, which are the only thing that could use it anyway.
    const keys = await loadSessionKeys(serverIdFor(newest.descriptor));
    if (!keys) return null;

    const session: PairedSession = {
      ...newest,
      directToken: keys.directToken,
    };
    writeMirror(session);
    return session;
  } catch {
    return null;
  }
}

/**
 * Every machine this browser holds a usable pairing for.
 *
 * The dashboard lists servers from the account, which is a different question
 * from "can this browser open one" — the account knows the machine exists, but
 * only this device holds the keys. Intersecting the two is what lets the
 * dashboard show Connect on the servers it can actually reach and an honest
 * "pair this device first" on the rest.
 *
 * A descriptor with no surviving keys is not usable, so it is filtered out
 * rather than offered and then failing on click.
 */
export async function listPairedServerIds(): Promise<string[]> {
  if (typeof window === "undefined") return [];
  try {
    const db = await openDb();
    const stored = await tx<StoredDescriptor[]>(
      db,
      DESCRIPTOR_STORE,
      "readonly",
      (store) => store.getAll(),
    );
    db.close();

    const ids = stored
      .filter((s) => s?.descriptor)
      .map((s) => serverIdFor(s.descriptor));
    const usable = await Promise.all(
      ids.map(async (id) => ((await loadSessionKeys(id)) ? id : null)),
    );
    return usable.filter((id): id is string => id !== null);
  } catch {
    return [];
  }
}

/**
 * Make a previously paired machine the active session.
 *
 * This is the whole of "connect from the dashboard": the keys and the
 * descriptor are already on this device from the first pairing, so switching
 * machines is a local lookup and a mirror write, with nothing asked of the
 * broker and no new code to type. Returns null when this browser has never
 * paired with that machine, which the caller renders as an invitation to pair.
 */
export async function activateDescriptor(
  serverId: string,
): Promise<PairedSession | null> {
  if (typeof window === "undefined") return null;
  try {
    const db = await openDb();
    const stored = await tx<StoredDescriptor | undefined>(
      db,
      DESCRIPTOR_STORE,
      "readonly",
      (store) => store.get(serverId),
    );
    db.close();
    if (!stored?.descriptor) return null;

    const keys = await loadSessionKeys(serverId);
    if (!keys) return null;

    const session: PairedSession = { ...stored, directToken: keys.directToken };
    writeMirror(session);
    return session;
  } catch {
    return null;
  }
}

export function clearDescriptor(): void {
  if (typeof window === "undefined") return;
  const session = loadDescriptor();
  sessionStorage.removeItem(DESCRIPTOR_KEY);
  if (!session) return;
  void (async () => {
    try {
      const db = await openDb();
      await tx(db, DESCRIPTOR_STORE, "readwrite", (store) =>
        store.delete(serverIdFor(session.descriptor)),
      );
      db.close();
    } catch {
      // Nothing to clear.
    }
  })();
}

/** Stable id for a paired machine — its device fingerprint. */
export function serverIdFor(descriptor: SealedDescriptor): string {
  return descriptor.deviceId;
}
