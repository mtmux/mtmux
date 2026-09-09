/**
 * Plumbing shared by the account and billing routes.
 *
 * `apps/api` is a bare `node:http` server rather than a framework, so the
 * small things a framework would provide — reading a bounded JSON body,
 * writing a JSON response, credentialed CORS — are here, once, instead of
 * being re-improvised per route.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";

import type { AccountsConfig } from "./config.js";

/**
 * Account bodies are tiny — the largest is a server registration with a hex
 * public key. A bound this low means a malicious client cannot make the broker
 * buffer anything worth buffering.
 */
const MAX_BODY_BYTES = 16 * 1024;

export type Json = Record<string, unknown>;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: Json,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    // Every response here is either a session-scoped read or a mutation.
    // Neither is ever safely cacheable, and a shared cache holding one
    // account's `/v1/me` would be a data leak rather than a stale page.
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}

export type BodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; raw?: unknown };

/**
 * Read and validate a JSON body against a zod schema.
 *
 * Validation errors come back as a flat message rather than zod's issue tree:
 * the consumers are a CLI printing one line and a fetch call in a browser, and
 * neither renders a nested error usefully.
 */
export async function readBody<T extends z.ZodTypeAny>(
  req: IncomingMessage,
  schema: T,
): Promise<BodyResult<z.infer<T>>> {
  const raw = await readRawBody(req);
  if (raw === null) {
    return { ok: false, status: 413, error: "Request body is too large." };
  }

  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, status: 400, error: "Body must be valid JSON." };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".");
    return {
      ok: false,
      status: 400,
      error: first
        ? `${where ? `${where}: ` : ""}${first.message}`
        : "Invalid request body.",
      // Carried so a caller can tell "too old to speak this protocol" apart
      // from "malformed", which are the same zod failure and very different
      // answers to give a reader.
      raw: parsed,
    };
  }
  return { ok: true, data: result.data as z.infer<T> };
}

/** Buffer a request body, or null if it exceeded the cap. */
export function readRawBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

/**
 * Credentialed CORS for the account routes.
 *
 * Three details are load-bearing and each is a silent failure on its own:
 * the origin must be echoed exactly (a wildcard is rejected outright when
 * credentials are involved), `Allow-Credentials` must be present or the
 * browser drops the session cookie it just received, and `Vary: Origin` must
 * be set or a shared cache will hand one origin's allow header to another.
 */
export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  config: AccountsConfig,
): void {
  const origin = req.headers.origin;
  // `Vary` unconditionally: the response differs by origin even when this
  // particular origin is refused.
  res.setHeader("Vary", "Origin");
  if (!origin || !config.corsOrigins.includes(origin)) return;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Cookie",
  );
  res.setHeader("Access-Control-Expose-Headers", "set-auth-token");
  res.setHeader("Access-Control-Max-Age", "600");
}

/**
 * Client address, preferring the proxy's `X-Forwarded-For`.
 *
 * Duplicated from `server.ts` rather than imported: that module imports this
 * one's caller, and a cycle between the router and the thing it mounts is a
 * needless hazard for four lines.
 */
export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = first?.split(",")[0]?.trim();
  return candidate || req.socket.remoteAddress || "unknown";
}

/**
 * Match a path against a `/v1/servers/:id/heartbeat`-style pattern.
 *
 * A hand-rolled matcher rather than a router: there are nine routes, the
 * segments are all literal or a single id, and a dependency for that would be
 * more surface than the thing it replaces.
 */
export function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const want = pattern.split("/");
  const got = pathname.split("/");
  if (want.length !== got.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as string;
    const g = got[i] as string;
    if (w.startsWith(":")) {
      if (g === "") return null;
      params[w.slice(1)] = decodeURIComponent(g);
    } else if (w !== g) {
      return null;
    }
  }
  return params;
}
