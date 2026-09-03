import crypto from "node:crypto";
import type http from "node:http";

import type { RecordingInfo, RecordingTarget } from "@repo/protocol";

/**
 * The loopback control plane behind `mtmux record`.
 *
 * `mtmux record` is a separate process from the running server, and only the
 * server holds the tmux connection, the recorder's ptys and the index. The same
 * problem `mtmux approve` and `mtmux devices` solve, solved the same way: a
 * loopback-only, `AUTH_TOKEN`-authenticated endpoint on the server the CLI
 * already knows the port of.
 *
 * Deliberately **not** `mtmux start --record`. Recording is something you
 * start, not a mode you boot into — a flag would mean the answer to "am I
 * recording?" is decided minutes before the thing worth recording happens.
 */
export const RECORD_PATH = "/_control/record";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The most a control request body may be. A loopback POST still gets a cap. */
const MAX_BODY_BYTES = 8192;

export type RecordAction =
  | { action: "list" }
  | { action: "start"; target: RecordingTarget; title?: string }
  | { action: "stop"; id: string }
  | { action: "stopAll" }
  | { action: "delete"; id: string };

export type RecordControlDeps = {
  authToken: string;
  /**
   * Absent when the embedded relay predates recording.
   *
   * `mtmux record` against an older bundle should say so plainly rather than
   * failing in a way that makes an upgrade look broken — the same courtesy
   * `devices-control` extends to `connectionSummary`.
   */
  recorder?: {
    list(): Promise<RecordingInfo[]>;
    start(options: {
      target: RecordingTarget;
      title?: string;
    }): Promise<RecordingInfo>;
    stop(id: string): Promise<RecordingInfo | null>;
    stopAll(): Promise<void>;
    remove(id: string): Promise<boolean>;
  };
};

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function sameToken(a: string, b: string): boolean {
  const left = crypto.createHash("sha256").update(a, "utf8").digest();
  const right = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

export function createRecordControl(deps: RecordControlDeps): {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
} {
  return {
    async handle(req, res) {
      if ((req.url ?? "").split("?")[0] !== RECORD_PATH) return false;

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

      const json = (status: number, body: unknown): true => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(body));
        return true;
      };

      if (!deps.recorder) {
        return json(501, {
          error: "This server was started by a build that cannot record.",
          code: "UNSUPPORTED",
        });
      }

      const body = (await readBody(req)) as RecordAction | null;
      if (!body || typeof body.action !== "string") {
        return json(400, { error: "Missing action" });
      }

      try {
        switch (body.action) {
          case "list":
            return json(200, { recordings: await deps.recorder.list() });

          case "start": {
            const recording = await deps.recorder.start({
              target: body.target,
              ...(body.title ? { title: body.title } : {}),
            });
            return json(200, { recording });
          }

          case "stop": {
            const recording = await deps.recorder.stop(body.id);
            if (!recording) return json(404, { error: "No such recording" });
            return json(200, { recording });
          }

          case "stopAll":
            await deps.recorder.stopAll();
            return json(200, { ok: true });

          case "delete": {
            const removed = await deps.recorder.remove(body.id);
            if (!removed) return json(404, { error: "No such recording" });
            return json(200, { ok: true });
          }

          default:
            return json(400, { error: "Unknown action" });
        }
      } catch (err) {
        // `RecordingError` carries a code the CLI prints as-is; anything else
        // is a genuine fault and gets a generic message rather than a stack.
        const code = (err as { code?: unknown }).code;
        return json(400, {
          error: err instanceof Error ? err.message : "Recording failed",
          ...(typeof code === "string" ? { code } : {}),
        });
      }
    },
  };
}
