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
};

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
      if (url !== DEVICES_PATH) return false;

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
