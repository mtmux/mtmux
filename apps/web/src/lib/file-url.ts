import { resolveRelayHttpBase } from "@/lib/relay-url";

import { loadDescriptor } from "@/lib/session-store";

import { TOKEN_KEY, readStored } from "./storage-keys";

/**
 * Thrown when the current connection has no HTTP route to the relay.
 *
 * Distinguishing this from a transport failure matters: it is not retryable and
 * the UI should say so plainly rather than showing a network error.
 */
export class FilesUnavailableError extends Error {
  constructor() {
    super("Files are not available over the relay tunnel.");
    this.name = "FilesUnavailableError";
  }
}

/**
 * Read the credential for relay HTTP requests (client-side only).
 *
 * Two kinds of session reach here. A self-hosted login stores the token in
 * localStorage. A paired session never does — its credential is the token both
 * ends derived from the PAKE — so reading only localStorage left every paired
 * session sending no Authorization header at all and getting a 401.
 */
export function getStoredToken(): string {
  if (typeof window === "undefined") return "";
  const stored = readStored(TOKEN_KEY);
  if (stored) return stored;
  return loadDescriptor()?.directToken ?? "";
}

/** Whether `/file` requests can be made on this connection at all. */
export function filesAvailable(): boolean {
  return resolveRelayHttpBase() !== "";
}

/**
 * Build the `/file?path=..` URL WITHOUT the token in the query. Use this for
 * resources loaded via `fetchFileObjectUrl` (embedded media), where the token
 * travels in an `Authorization` header instead of leaking into the URL (and
 * thus into browser history, referrers, and server access logs).
 */
export function getFileUrl(path: string, download?: boolean): string {
  const httpBase = resolveRelayHttpBase();
  if (!httpBase) throw new FilesUnavailableError();
  const params = new URLSearchParams({ path });
  if (download) params.set("download", "1");
  return `${httpBase}/file?${params.toString()}`;
}

/**
 * Build a download URL. User-initiated downloads use an `<a href download>`
 * navigation, which cannot carry an `Authorization` header, so the token stays
 * in the query as a pragmatic exception for these transient, explicit actions.
 */
export function getFileDownloadUrl(path: string): string {
  const httpBase = resolveRelayHttpBase();
  if (!httpBase) throw new FilesUnavailableError();
  const token = getStoredToken();
  const params = new URLSearchParams({ path, download: "1", token });
  return `${httpBase}/file?${params.toString()}`;
}

/**
 * Same as `getFileDownloadUrl` but null instead of throwing.
 *
 * Download links are built during render, where a throw would take out the
 * whole subtree. Callers render the link only when there is one.
 */
export function tryFileDownloadUrl(path: string): string | null {
  try {
    return getFileDownloadUrl(path);
  } catch {
    return null;
  }
}

/**
 * Fetch a file as a blob using the `Authorization: Bearer <token>` header
 * (never the URL) and return an object URL. The caller MUST revoke the
 * returned URL on cleanup/unmount to avoid leaks — see `useFileObjectUrl`.
 */
export async function fetchFileObjectUrl(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const token = getStoredToken();
  const res = await fetch(getFileUrl(path), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok) {
    throw new Error(`Failed to load file (${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
