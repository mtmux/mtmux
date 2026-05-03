import { env } from "@/env";

const FALLBACK_DEV_WS = "ws://localhost:14300";
const RELAY_PATH = "/_relay";

/**
 * Resolve the WebSocket URL for the relay.
 *
 * Priority:
 *   1. `NEXT_PUBLIC_RELAY_URL` if set (Docker/PM2 split-deployment).
 *   2. Same-origin `/_relay` when running in the browser (CLI single-port).
 *   3. Hardcoded localhost fallback for SSR / dev defaults.
 */
export function resolveRelayWsUrl(): string {
  if (env.NEXT_PUBLIC_RELAY_URL) return env.NEXT_PUBLIC_RELAY_URL;
  if (typeof window === "undefined") return FALLBACK_DEV_WS;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${RELAY_PATH}`;
}

/** HTTP base for `/file?...` requests (same-origin in CLI mode). */
export function resolveRelayHttpBase(): string {
  if (env.NEXT_PUBLIC_RELAY_URL) {
    return env.NEXT_PUBLIC_RELAY_URL.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  }
  if (typeof window === "undefined") return "http://localhost:14300";
  return window.location.origin;
}
