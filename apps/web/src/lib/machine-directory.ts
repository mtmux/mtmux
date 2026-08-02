import {
  MACHINE_STORE,
  listPairedServerIds,
  loadDescriptorFor,
  openDb,
  tx,
} from "./session-store";

/**
 * What this browser calls its machines, and what order it puts them in.
 *
 * Three places wanted this and none of them could have it. The dashboard's
 * rename writes to the *account*, which is Pro-gated and does not exist on a
 * self-hosted pairing. The census reads `descriptor.label`, which is the
 * machine's own hostname and cannot be changed from a browser at all. And
 * nothing anywhere held an order, so both machine lists were sorted by
 * whichever query happened to return first.
 *
 * So: a device-local layer over the pairings that already exist. It never
 * creates a machine — `listPairedServerIds()` is still the only definition of
 * "a machine this browser can open" — it only decorates one.
 *
 * ## Why IndexedDB rather than localStorage
 *
 * Nothing in here is secret: a name someone typed and a sort key. But the rest
 * of a machine's record is already in IndexedDB, and a second storage mechanism
 * for half of one object is a second thing to keep in sync, a second thing to
 * clear when a machine is forgotten, and a second answer to "what does this
 * browser know". `storage-keys.ts` documents the one deliberate localStorage
 * exception; this is not it.
 */

/** The device-local half. Absent fields mean "no opinion, use the default". */
export type MachinePrefs = {
  /** What the user renamed it to here. Wins over the account and the hostname. */
  name?: string;
  /** Position in both machine lists. Missing sorts last, then by pairing time. */
  order?: number;
  /** Whether its session list is folded up in the dashboard. */
  collapsed?: boolean;
};

export type MachineEntry = {
  serverId: string;
  /** The resolved name: local rename, else the caller's, else the hostname. */
  name: string;
  /** True when `name` came from a rename made on this device. */
  renamedHere: boolean;
  /** The machine's own label from the pairing, always available. */
  hostname: string;
  pairedAt: number;
  order: number;
  collapsed: boolean;
};

/** Machines sort after every explicitly ordered one, not before them. */
const UNORDERED = Number.MAX_SAFE_INTEGER;

async function readPrefs(serverId: string): Promise<MachinePrefs | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    const stored = await tx<MachinePrefs | undefined>(
      db,
      MACHINE_STORE,
      "readonly",
      (store) => store.get(serverId),
    );
    db.close();
    return stored ?? null;
  } catch {
    return null;
  }
}

async function writePrefs(
  serverId: string,
  changes: MachinePrefs,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const current = (await readPrefs(serverId)) ?? {};
    const next: MachinePrefs = { ...current, ...changes };
    const db = await openDb();
    await tx(db, MACHINE_STORE, "readwrite", (store) =>
      store.put(next, serverId),
    );
    db.close();
  } catch {
    // Private mode, or a blocked upgrade. Names and ordering are a nicety;
    // losing them must never take the page down with them.
  }
}

/**
 * Every machine this browser holds keys for, named and in order.
 *
 * `names` is what the caller already knows — the account's list on the hosted
 * build — and is used only when this device has no rename of its own. Passing
 * nothing is correct for a self-hosted build, where the hostname from the
 * pairing is the only name there has ever been.
 */
export async function listMachines(
  names?: ReadonlyMap<string, string>,
): Promise<MachineEntry[]> {
  const ids = await listPairedServerIds();
  const entries = await Promise.all(
    ids.map(async (serverId) => {
      const [record, prefs] = await Promise.all([
        loadDescriptorFor(serverId),
        readPrefs(serverId),
      ]);
      const hostname = record?.descriptor.label || "Unnamed machine";
      const renamedHere = typeof prefs?.name === "string" && prefs.name !== "";
      return {
        serverId,
        name: renamedHere
          ? prefs!.name!
          : (names?.get(serverId) ?? hostname) || hostname,
        renamedHere,
        hostname,
        pairedAt: record?.pairedAt ?? 0,
        order: prefs?.order ?? UNORDERED,
        collapsed: prefs?.collapsed === true,
      } satisfies MachineEntry;
    }),
  );
  return sortMachines(entries);
}

/**
 * The one sort order, exported so the lists that do not go through
 * `listMachines` can agree with the ones that do.
 *
 * Ties break on pairing time rather than on nothing: two machines with no
 * explicit order must not swap places between renders, or a list reshuffles
 * itself while someone is reading it.
 */
export function sortMachines<T extends { order: number; pairedAt: number }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort(
    (a, b) => a.order - b.order || a.pairedAt - b.pairedAt,
  );
}

export async function renameMachine(
  serverId: string,
  name: string,
): Promise<void> {
  await writePrefs(serverId, { name: name.trim().slice(0, 64) });
}

/** Drop the local rename, falling back to the account name or the hostname. */
export async function clearMachineName(serverId: string): Promise<void> {
  await writePrefs(serverId, { name: "" });
}

export async function setMachineCollapsed(
  serverId: string,
  collapsed: boolean,
): Promise<void> {
  await writePrefs(serverId, { collapsed });
}

/**
 * Write a whole ordering at once.
 *
 * Every id gets an explicit index, including the ones that had none, so a
 * single "move up" cannot leave half the list ordered and half of it sorted by
 * pairing time — which reads as the list shuffling itself.
 */
export async function setMachineOrder(
  orderedIds: readonly string[],
): Promise<void> {
  await Promise.all(
    orderedIds.map((serverId, index) => writePrefs(serverId, { order: index })),
  );
}

/**
 * Move one machine one place, and persist the result.
 *
 * Buttons rather than drag-and-drop, deliberately. Reordering a list by drag on
 * a phone means holding a target inside a page that is itself scrolling, and it
 * is unusable with a keyboard or a screen reader. Two buttons are neither
 * fashionable nor ambiguous.
 */
export async function moveMachine(
  orderedIds: readonly string[],
  serverId: string,
  direction: -1 | 1,
): Promise<string[]> {
  const ids = [...orderedIds];
  const from = ids.indexOf(serverId);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= ids.length) return ids;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  await setMachineOrder(ids);
  return ids;
}

/**
 * Every stored preference at once, for the lists that render many machines.
 *
 * The dashboard needs order and collapsed state for a dozen rows before its
 * first paint; a `get` per machine would be a dozen transactions to answer one
 * question. Machines with no preferences simply have no entry.
 */
export async function readAllMachinePrefs(): Promise<
  Map<string, MachinePrefs>
> {
  const out = new Map<string, MachinePrefs>();
  if (typeof indexedDB === "undefined") return out;
  try {
    const db = await openDb();
    const [keys, values] = await Promise.all([
      tx<IDBValidKey[]>(db, MACHINE_STORE, "readonly", (store) =>
        store.getAllKeys(),
      ),
      tx<MachinePrefs[]>(db, MACHINE_STORE, "readonly", (store) =>
        store.getAll(),
      ),
    ]);
    db.close();
    keys.forEach((key, index) => {
      const value = values[index];
      if (typeof key === "string" && value) out.set(key, value);
    });
    return out;
  } catch {
    return out;
  }
}

/** Forget a machine's local name and place. Called when the pairing goes. */
export async function forgetMachinePrefs(serverId: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await tx(db, MACHINE_STORE, "readwrite", (store) => store.delete(serverId));
    db.close();
  } catch {
    // Nothing to clear.
  }
}
