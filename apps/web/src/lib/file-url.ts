import { resolveRelayHttpBase } from "@/lib/relay-url";

const TOKEN_KEY = "ccremote-token";

/** Read the stored auth token (client-side only). */
export function getStoredToken(): string {
  return typeof window !== "undefined"
    ? (localStorage.getItem(TOKEN_KEY) ?? "")
    : "";
}

/**
 * Build the `/file?path=..` URL WITHOUT the token in the query. Use this for
 * resources loaded via `fetchFileObjectUrl` (embedded media), where the token
 * travels in an `Authorization` header instead of leaking into the URL (and
 * thus into browser history, referrers, and server access logs).
 */
export function getFileUrl(path: string, download?: boolean): string {
  const httpBase = resolveRelayHttpBase();
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
  const token = getStoredToken();
  const params = new URLSearchParams({ path, download: "1", token });
  return `${httpBase}/file?${params.toString()}`;
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
