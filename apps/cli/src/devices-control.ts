import type http from "node:http";
import crypto from "node:crypto";

/**
 * The loopback endpoint behind `mtmux status`'s Devices row.
 *
 * `status` is a separate process from the running server, so it has no way to
 * see the relay's connection table — the same problem `mtmux approve` solves
 * with its own control endpoints, solved the same way. A sibling module rather
 * than another branch inside `approve-control`: approvals are a stateful
 * conversation with a human, this is a stateless read, and the only thing they
 * share is the guard.
 *
 * Loopback-only and `AUTH_TOKEN`-authenticated, like every other control path.
 * A list of the devices attached to someone's terminal is not public, and the
 * labels are self-reported by the browsers that paired.
 */
export const DEVICES_PATH = "/_control/devices";

/**
 * Drop a device's session token from the running relay.
 *
 * `mtmux devices revoke` deletes the peer record, but that record is only what
 * the *next* boot restores from — the live relay holds its own in-memory copy,
 * so a revoked device kept working until the server was restarted. That was
 * survivable while the relay's window was a 24 h countdown. It stopped being
 * survivable once the window became a sliding 90 days renewed by the very
 * traffic the user is trying to stop, which is what made this endpoint
 * necessary rather than merely nice.
 */
export const DEVICES_REVOKE_PATH = "/_control/devices/revoke";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export type ConnectedDevice = {
  label: string;
  connectedAt: number;
  readOnly: boolean;
};

export type DevicesControlDeps = {
  authToken: string;
  /**
   * Absent when the embedded relay predates `connectionSummary`, which is the
   * case `mtmux status` must survive — an older daemon should cost the row,
   * not produce an error that makes an upgrade look broken.
   */
  summary?: () => { count: number; devices: ConnectedDevice[] };
  /** Absent when the embedded relay predates `revokeSessionToken`. */
  revokeToken?: (token: string) => void;
};

/** The token to revoke, from a small JSON body. Capped so a stray POST can't
 *  buffer without bound on a loopback endpoint. */
async function readToken(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 8192) return null;
    chunks.push(buf);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const token = (parsed as { token?: unknown })?.token;
    return typeof token === "string" && token.length >= 32 ? token : null;
  } catch {
    return null;
  }
}

function sameToken(a: string, b: string): boolean {
  const left = crypto.createHash("sha256").update(a, "utf8").digest();
  const right = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

export function createDevicesControl(deps: DevicesControlDeps): {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
} {
  return {
    async handle(req, res) {
      const url = (req.url ?? "").split("?")[0];
      if (url !== DEVICES_PATH && url !== DEVICES_REVOKE_PATH) return false;

      const peer = req.socket.remoteAddress ?? "";
      if (!LOOPBACK_ADDRESSES.has(peer)) {
        res.writeHead(403);
        res.end("Loopback only");
        return true;
      }

      const auth = req.headers.authorization;
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!bearer || !sameToken(bearer, deps.authToken)) {
        res.writeHead(401);
        res.end("Unauthorized");
        return true;
      }

      if (url === DEVICES_REVOKE_PATH) {
        const token = await readToken(req);
        if (!token) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing token" }));
          return true;
        }
        // Reported so the caller can say "restart to drop it" only when it is
        // actually true, rather than always.
        const applied = deps.revokeToken !== undefined;
        deps.revokeToken?.(token);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ applied }));
        return true;
      }

      const body = deps.summary?.() ?? { count: 0, devices: [] };
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
      return true;
    },
  };
}
