/**
 * Is this origin serving a relay, or is it app.mtmux.com?
 *
 * ## Why `isHostedBuild` cannot answer this
 *
 * `isHostedBuild` is `NEXT_PUBLIC_API_URL !== null`, and the CLI's own build
 * bakes `https://api.mtmux.com` into the shipped bundle
 * (`apps/cli/scripts/build.mjs`) so that a self-hosted install's `/pair` page
 * can still reach the broker. So `isHostedBuild` means "a broker origin is
 * known" — which is true of every build we ship. It says nothing about whether
 * the page you are looking at was served by `mtmux start` on your laptop or by
 * app.mtmux.com.
 *
 * The one thing that does differ is the origin itself: `mtmux start` serves the
 * relay on the same port as the web client and answers `GET /health`
 * (`apps/relay/src/server.ts`), while app.mtmux.com has no such route.
 *
 * ## This is cosmetic, and must stay cosmetic
 *
 * The only consumer is `/start`, where it decides which of two always-present
 * options gets the visual lead. Both remain visible and functional whichever
 * way this resolves — so a reverse proxy that answers `/health` for unrelated
 * reasons produces a slightly oddly-ordered page and nothing worse. Do not
 * grow a security or capability decision on top of it.
 */

const PROBE_TIMEOUT_MS = 600;

let probe: Promise<boolean> | null = null;

/**
 * True when this origin also serves a relay — i.e. `mtmux start`, `pnpm dev`,
 * or a self-hosted single-port deployment.
 *
 * Memoized for the life of the page: the answer is a property of the origin,
 * not of the moment, and `/start` may ask more than once as it renders.
 * Failure of any kind — offline, CORS, 404, timeout — is `false`, which is the
 * hosted reading and the safe default for a purely cosmetic hint.
 */
export function servesRelay(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  probe ??= runProbe();
  return probe;
}

async function runProbe(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch("/health", {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam. Never call this from application code. */
export function resetOriginModeProbe(): void {
  probe = null;
}
