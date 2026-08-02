import { clearDescriptorFor, clearSessionKeys } from "./session-store";
import { forgetMachinePrefs } from "./machine-directory";

/**
 * Forget one machine on this device.
 *
 * The counterpart to `forget-session.ts`, which can only forget whichever
 * machine the current tab happens to be pointed at. A list needs to forget the
 * third row without visiting it first.
 *
 * This is deliberately *not* "remove from the account". Removing there deletes
 * the registry row for every device on the account; this drops the keys on this
 * one, which is what someone means by "let me pair this phone again" — the
 * thing that previously had no route at all, and which people were reaching by
 * removing the machine from their account and re-registering it.
 *
 * Keys first, then the descriptor, then the local name — the same ordering
 * `forget-session.ts` documents. The descriptor is what every reader uses to
 * decide there is a session at all, so dropping it first opens a window where
 * the app believes it is unpaired while the keys are still on disk.
 */
export async function forgetMachine(serverId: string): Promise<void> {
  await clearSessionKeys(serverId);
  await clearDescriptorFor(serverId);
  await forgetMachinePrefs(serverId);
}
