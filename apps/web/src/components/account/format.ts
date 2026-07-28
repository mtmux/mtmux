/** Display helpers shared by the account surfaces. Pure, so they are testable. */

/**
 * "4m ago". Matches the phrasing `mtmux servers` prints in the terminal, so the
 * dashboard and the CLI never disagree about how long a machine has been quiet.
 */
export function timeAgo(
  at: number | null | undefined,
  now = Date.now(),
): string {
  if (at == null) return "never seen";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Accepts the epoch-ms the broker sends, and tolerates an ISO string. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
  freebsd: "FreeBSD",
};

export function platformName(platform: string | null | undefined): string {
  if (!platform) return "Unknown platform";
  return PLATFORM_NAMES[platform] ?? platform;
}

/**
 * Bytes at one decimal place, in the units a bandwidth allowance is quoted in.
 * Deliberately binary (GiB) to match `@repo/config/plans`, which counts in
 * 1024s, while printing the shorter "GB" people expect on an invoice.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded =
    value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

export function formatDate(at: number | null): string {
  if (at == null) return "—";
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Where to send someone after they sign in.
 *
 * Only same-origin paths are honoured. `?next=https://evil.example` would
 * otherwise turn the sign-in page into an open redirect, and `//evil.example`
 * is a protocol-relative URL that looks like a path but is not one.
 */
export function safeNext(
  next: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}
