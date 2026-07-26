/**
 * Pick a direct route to the paired machine, or give up quickly.
 *
 * Every candidate is probed at once and the first `/health` to answer wins.
 * The timeout is short and the tunnel is always available as a backstop, which
 * is what makes "direct first" safe to attempt: a candidate that is blocked —
 * by a rebind-protecting resolver, a guest network, or simply the wrong subnet
 * — costs a few hundred milliseconds and then degrades, never fails.
 */

export const CANDIDATE_TIMEOUT_MS = 800;

export type RaceResult = {
  /** The winning base URL, or null when every candidate failed. */
  winner: string | null;
  /** How long the race took, for the connection detail panel. */
  elapsedMs: number;
};

export async function raceCandidates(
  candidates: readonly string[],
  timeoutMs: number = CANDIDATE_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<RaceResult> {
  const started = Date.now();
  if (candidates.length === 0) {
    return { winner: null, elapsedMs: 0 };
  }

  const controllers = candidates.map(() => new AbortController());
  const timer = setTimeout(() => {
    for (const c of controllers) c.abort();
  }, timeoutMs);

  const probes = candidates.map(async (candidate, i) => {
    const res = await fetchImpl(`${candidate}/health`, {
      signal: controllers[i]!.signal,
      // The relay answers /health without credentials; sending none keeps the
      // probe cheap and avoids a preflight.
      mode: "cors",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`health ${res.status}`);
    return candidate;
  });

  try {
    // Promise.any resolves on the first success and only rejects if every
    // probe fails, which is exactly the semantics we want.
    const winner = await Promise.any(probes);
    return { winner, elapsedMs: Date.now() - started };
  } catch {
    return { winner: null, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    for (const c of controllers) c.abort();
  }
}
