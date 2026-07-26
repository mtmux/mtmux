import { resolveRelayHttpBase } from "@/lib/relay-url";

export const PAIR_LOCAL_PATH = "/_pair/local";

export type LocalPairingResult = { token: string; expiresAt: number };

/**
 * Redeem the one-time nonce from the `mtmux start` QR code for a scoped
 * session token.
 *
 * The nonce arrives in the URL *fragment* (`/login#n=…`), so it is never sent
 * to the server as part of the navigation and never lands in an access log. It
 * is posted here in a request body rather than a query string for the same
 * reason.
 *
 * Only single-port CLI mode ever arms a nonce; in the split deployment the
 * relay has none outstanding and this always fails closed.
 */
export async function redeemLocalPairingNonce(
  nonce: string,
  signal?: AbortSignal,
): Promise<LocalPairingResult> {
  const res = await fetch(`${resolveRelayHttpBase()}${PAIR_LOCAL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
    signal,
  });

  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "That sign-in code has expired or was already used. Check your terminal for a fresh one."
        : `Pairing failed (${res.status})`,
    );
  }

  const body = (await res.json()) as Partial<LocalPairingResult>;
  if (typeof body.token !== "string" || !body.token) {
    throw new Error("Pairing failed: malformed response");
  }
  return { token: body.token, expiresAt: body.expiresAt ?? 0 };
}
