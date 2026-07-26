import { env } from "@/env";
import { loadDescriptor } from "@/lib/session-store";

const RELAY_PATH = "/_relay";

/**
 * Resolve the WebSocket URL for the relay.
 *
 * Priority:
 *   1. `NEXT_PUBLIC_RELAY_URL` if set — the split deployment (Docker/PM2), where
 *      the relay lives on its own host/port. `pnpm dev:split` sets it too.
 *   2. Same-origin `/_relay`. This is single-port mode: `tmuxremote start` and
 *      `pnpm dev` both serve the relay off the web app's own port.
 *
 * There is deliberately no dev-vs-production branch. Dev used to hardcode
 * ws://localhost:14300, which meant the shipped single-port topology was never
 * exercised until release — and pointed the browser at a dead port as soon as
 * dev became single-port.
 *
 * Both callers run in the browser; the empty string on the server is a
 * never-connect placeholder for SSR/prerender.
 */
export function resolveRelayWsUrl(): string {
  // Third branch, ahead of the other two: a hosted pairing established in this
  // tab wins, because the relay it points at is not this origin at all. The
  // two branches below are untouched, so split-mode and self-hosting behave
  // byte-for-byte as before.
  const paired = pairedRelayUrl();
  if (paired) return paired;

  if (env.NEXT_PUBLIC_RELAY_URL) return env.NEXT_PUBLIC_RELAY_URL;
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${RELAY_PATH}`;
}

/**
 * The relay URL for a session paired through the broker, or null.
 *
 * Returns the candidate that won the direct race if there is one, and
 * otherwise the tunnel. Both are only reachable with the session keys held in
 * IndexedDB, so a descriptor on its own grants nothing.
 */
export function pairedRelayUrl(): string | null {
  const session = loadDescriptor();
  if (!session) return null;

  if (session.preferredCandidate) {
    return `${session.preferredCandidate.replace(/^http/, "ws")}${RELAY_PATH}`;
  }

  const apiBase = env.NEXT_PUBLIC_API_URL;
  if (!apiBase) return null;
  return `${apiBase.replace(/^http/, "ws")}/v1/tunnel/${session.descriptor.tunnelId}`;
}

/** True when this tab is driving a relay reached through hosted pairing. */
export function isPairedSession(): boolean {
  return loadDescriptor() !== null;
}

/** HTTP base for `/file?...` requests (same-origin in single-port mode). */
export function resolveRelayHttpBase(): string {
  const session = loadDescriptor();
  if (session?.preferredCandidate) return session.preferredCandidate;

  if (env.NEXT_PUBLIC_RELAY_URL) {
    return env.NEXT_PUBLIC_RELAY_URL.replace(/^ws:/, "http:").replace(
      /^wss:/,
      "https:",
    );
  }
  if (typeof window === "undefined") return "";
  return window.location.origin;
}
