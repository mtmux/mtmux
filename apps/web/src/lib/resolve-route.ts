import type { SessionKeys } from "@repo/crypto";
import { env } from "@/env";
import { raceCandidates } from "./candidate-race";
import { sealedTransport, type TransportFactory } from "./transport";
import {
  loadDescriptor,
  loadSessionKeys,
  saveDescriptor,
  serverIdFor,
  type PairedSession,
} from "./session-store";

/**
 * Decide, right now, how to reach the paired machine.
 *
 * This exists because the answer used to be decided exactly once, at pairing
 * time, and then never revisited. `persistPairing` raced the candidates and
 * wrote the winner as `preferredCandidate`; every later read trusted it
 * forever. So a phone paired at home was pinned to `ws://192.168.1.5:14100`
 * and, once it left the house, retried that dead address until the user gave
 * up — the tunnel was never tried, because the pin was truthy.
 *
 * A route that worked once is a hint, never a commitment. The race is already
 * bounded at 800 ms and the tunnel is always there to fall through to, so
 * re-deciding costs a fraction of a second on a cold start and buys a session
 * that survives moving between networks.
 *
 * Returns the winning direct candidate, or a sealed tunnel transport when
 * nothing direct answers. Either way the stored preference is brought back in
 * line with reality — including being cleared, which is the case that was
 * impossible before.
 */
export type ResolvedRoute = {
  /** The direct candidate that won, or null when everything rides the tunnel. */
  preferredCandidate: string | null;
  /** Set only for the tunnelled path; the direct path uses a plain socket. */
  transport?: TransportFactory;
};

export async function resolveRoute(
  session: PairedSession,
  keys: SessionKeys,
): Promise<ResolvedRoute> {
  const { winner } = await raceCandidates(
    session.descriptor.candidates,
    keys.directToken,
  );

  persistPreferred(session, winner);

  if (winner) return { preferredCandidate: winner };

  // No direct route. The tunnel is the backstop, and the only thing that can
  // take it away is a build with no broker configured — which is the
  // self-hosted bundle, where a paired session cannot exist in the first place.
  if (!env.NEXT_PUBLIC_API_URL) return { preferredCandidate: null };

  const url = `${env.NEXT_PUBLIC_API_URL.replace(/^http/, "ws")}/v1/tunnel/${session.descriptor.tunnelId}`;
  return {
    preferredCandidate: null,
    transport: sealedTransport({ url, keys }),
  };
}

/**
 * Re-decide the route for whatever session this tab is driving.
 *
 * The reconnect loop has no idea which machine it is talking to — it holds a
 * transport and a token — so this reads the active descriptor itself. Returns
 * null on the self-hosted path, where there is no descriptor and nothing to
 * re-decide, which is also what makes this safe to call unconditionally.
 */
export async function reresolveActiveRoute(): Promise<ResolvedRoute | null> {
  const session = loadDescriptor();
  if (!session) return null;
  const keys = await loadSessionKeys(serverIdFor(session.descriptor));
  if (!keys) return null;
  return resolveRoute(session, keys);
}

/**
 * Write the decision back, so the next cold start tries the winner first.
 *
 * Re-read rather than reusing the caller's `session`: resolving is async and
 * the descriptor may have been re-activated for a different machine while the
 * race was in flight. Writing a stale copy would repoint the active session at
 * whichever machine was resolved last — the same class of bug
 * `loadDescriptorFor` exists to avoid in the census.
 */
function persistPreferred(session: PairedSession, winner: string | null): void {
  const current = loadDescriptor();
  if (!current) return;
  if (current.descriptor.tunnelId !== session.descriptor.tunnelId) return;
  if ((current.preferredCandidate ?? null) === winner) return;

  const { preferredCandidate: _previous, ...rest } = current;
  saveDescriptor(winner ? { ...rest, preferredCandidate: winner } : rest);
}
