/**
 * Where the hosted pairing broker lives.
 *
 * Overridable so self-hosters can point at their own `apps/api`, and so the
 * integration tests can point at a throwaway instance. Nothing in
 * `mtmux start` contacts this host — only `mtmux pair` does.
 */
export const DEFAULT_API_BASE = "https://api.mtmux.com";

export function apiBase(override?: string): string {
  const base = override ?? process.env.MTMUX_API_URL ?? DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
}

/**
 * The broker to talk to, including the one this machine has been told to use.
 *
 * Precedence: `--api` → `MTMUX_API_URL` → `mtmux config set api` → the account
 * this machine signed in against → ours.
 *
 * The stored value is why this exists. `Account.apiBase` has been written since
 * accounts shipped and was never read back, so a self-hoster had to export
 * `MTMUX_API_URL` or pass `--api` on *every single invocation* — which is not a
 * self-hosted product, it is a hosted product with a workaround. The account's
 * own broker is the last fallback because signing in against a broker is a
 * clear statement about which one you use.
 *
 * Async, unlike `apiBase`, because it reads the config file. Callers that
 * genuinely cannot await (or that must not touch disk) keep using `apiBase`.
 */
export async function resolveApiBase(override?: string): Promise<string> {
  if (override) return apiBase(override);
  if (process.env.MTMUX_API_URL) return apiBase();
  try {
    const configStore = await import("./config-store.js");
    const config = await configStore.load();
    const stored = config.apiBase ?? config.account?.apiBase;
    if (stored) return apiBase(stored);
  } catch {
    // An unreadable config must not stop the CLI reaching the default broker.
  }
  return apiBase();
}

/**
 * Is this a broker URL we are willing to store?
 *
 * `http:` is allowed because a self-hoster's first broker is usually on their
 * own network or behind a tunnel they already trust, and refusing it would
 * only teach them to fight the tool. Anything that is not an absolute http(s)
 * URL is rejected: it would fail later, at a point where the error names a
 * fetch rather than the setting that caused it.
 */
export function isBrokerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Ask the broker what public address this machine appears to come from. */
export async function discoverPublicIp(
  base: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(`${base}/v1/discover`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { ip?: unknown };
    return typeof body.ip === "string" ? body.ip : null;
  } catch {
    // Discovery is an optimisation: without it we simply advertise no
    // public candidate and the tunnel carries the session.
    return null;
  }
}
