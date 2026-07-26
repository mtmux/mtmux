import { env } from "@/env";

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
  if (env.NEXT_PUBLIC_RELAY_URL) return env.NEXT_PUBLIC_RELAY_URL;
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${RELAY_PATH}`;
}

/** HTTP base for `/file?...` requests (same-origin in single-port mode). */
export function resolveRelayHttpBase(): string {
  if (env.NEXT_PUBLIC_RELAY_URL) {
    return env.NEXT_PUBLIC_RELAY_URL.replace(/^ws:/, "http:").replace(
      /^wss:/,
      "https:",
    );
  }
  if (typeof window === "undefined") return "";
  return window.location.origin;
}
