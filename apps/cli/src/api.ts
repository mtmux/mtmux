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
