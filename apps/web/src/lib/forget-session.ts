import {
  clearDescriptor,
  clearSessionKeys,
  loadDescriptor,
  serverIdFor,
} from "./session-store";

/**
 * Forget the machine this tab is paired with.
 *
 * Both halves of a pairing, deliberately. `clearDescriptor` alone leaves the
 * key material in IndexedDB for a machine the user has said they are done with,
 * and `clearSessionKeys` alone leaves a descriptor whose keys cannot be loaded —
 * which the terminal layout reads as "no session" and bounces on, so it looks
 * like it worked while quietly accumulating orphans.
 *
 * Both functions have existed since pairing shipped and neither was reachable
 * from anywhere in the UI. That is the actual gap this fills: a session that
 * could not connect had no route to starting over except clearing site data.
 *
 * Keys first, then the descriptor: the descriptor is what every reader uses to
 * decide there is a session at all, so dropping it first opens a window where
 * the app believes it is unpaired while the keys are still on disk — the mirror
 * image of the ordering `persistPairing` documents on the way in.
 */
export async function forgetActiveSession(): Promise<void> {
  const session = loadDescriptor();
  if (session) {
    await clearSessionKeys(serverIdFor(session.descriptor));
  }
  clearDescriptor();
}
