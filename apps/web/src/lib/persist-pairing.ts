import type { SealedDescriptor } from "@repo/protocol";
import type { SessionKeys } from "@repo/crypto";
import { raceCandidates } from "./candidate-race";
import { saveDescriptor, saveSessionKeys, serverIdFor } from "./session-store";

/**
 * Everything that turns a finished handshake into a usable session.
 *
 * Three steps that must happen together and in this order, and which three
 * different surfaces need identically: `/j` (claiming a code the terminal
 * showed), `/pair` (showing a code the terminal claims), and the dashboard's
 * request-access dialog. Before this they were three copies of the same
 * fifteen lines, which is three chances for one of them to drift into saving a
 * descriptor whose keys never landed.
 *
 * The race goes first on purpose. `preferredCandidate` is part of the
 * descriptor record, so racing afterwards would mean writing the descriptor
 * twice — and a reader that caught the first write would route a session
 * through the tunnel that had a perfectly good direct route.
 *
 * The probe authenticates with the token both ends derived, so a candidate only
 * wins if it really is the machine we just paired with. A hijacked LAN address
 * cannot fake that.
 */
export type PersistedPairing = {
  /** The direct candidate that won, or null when everything rides the tunnel. */
  winner: string | null;
  serverId: string;
};

export async function persistPairing(update: {
  keys: SessionKeys;
  descriptor: SealedDescriptor;
}): Promise<PersistedPairing> {
  const { keys, descriptor } = update;
  const serverId = serverIdFor(descriptor);

  const { winner } = await raceCandidates(
    descriptor.candidates,
    keys.directToken,
  );

  // Keys before descriptor. The descriptor is what every reader uses to decide
  // there is a session at all, so writing it first opens a window where the
  // app believes it is paired and cannot decrypt anything.
  await saveSessionKeys(serverId, keys);
  saveDescriptor({
    descriptor,
    preferredCandidate: winner ?? undefined,
    directToken: keys.directToken,
    pairedAt: Date.now(),
  });

  return { winner, serverId };
}

/** The one sentence every caller shows on success. Kept here so all three agree. */
export function pairedMessage(
  descriptor: SealedDescriptor,
  winner: string | null,
): string {
  return winner
    ? `Connected to ${descriptor.label} directly`
    : `Connected to ${descriptor.label} over the relay`;
}
