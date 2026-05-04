import { env } from "@/env";

const FALLBACK_DEV_WS = "ws://localhost:14300";
const FALLBACK_DEV_HTTP = "http://localhost:14300";
const RELAY_PATH = "/_relay";

// Next.js inlines process.env.NODE_ENV at build time for client bundles, so
// this constant is statically known per build.
const isDev = process.env.NODE_ENV !== "production";

/**
 * Resolve the WebSocket URL for the relay.
 *
 * Priority:
 *   1. `NEXT_PUBLIC_RELAY_URL` if set (Docker/PM2 split-deployment).
 *   2. In dev mode without that env, fall back to ws://localhost:14300
 *      so the standard `pnpm dev` (web on 14100, relay on 14300) works
 *      out of the box.
 *   3. In production same-origin `/_relay` (CLI single-port).
 */
export function resolveRelayWsUrl(): string {
  if (env.NEXT_PUBLIC_RELAY_URL) return env.NEXT_PUBLIC_RELAY_URL;
  if (isDev) return FALLBACK_DEV_WS;
  if (typeof window === "undefined") return FALLBACK_DEV_WS;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${RELAY_PATH}`;
}

/** HTTP base for `/file?...` requests (same-origin in CLI mode). */
export function resolveRelayHttpBase(): string {
  if (env.NEXT_PUBLIC_RELAY_URL) {
    return env.NEXT_PUBLIC_RELAY_URL.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  }
  if (isDev) return FALLBACK_DEV_HTTP;
  if (typeof window === "undefined") return FALLBACK_DEV_HTTP;
  return window.location.origin;
}
