/**
 * Accounts, servers and billing, as one mountable unit.
 *
 * `createAccounts` is the entire integration surface: hand it a database and a
 * config, mount `handleRequest` at the top of the HTTP handler, and call
 * `authenticate` / `checkTunnel` / `recordUsage` from the pairing paths that
 * care. Nothing else in the broker needs to know that better-auth, Drizzle or
 * a payment provider exist.
 *
 * ## The degradation rule
 *
 * With no `DATABASE_URL` — or with a database that will not open — this
 * returns a stub: the account routes answer 503, `authenticate` returns null,
 * and every entitlement check allows. That is not a courtesy, it is the
 * product. mtmux is a tool you install on your own server; pairing, tunnelling
 * and terminal access have to work with no account, no network calls to us,
 * and no database at all. Accounts add a dashboard and more than one machine.
 * If they ever become a prerequisite, the self-hosted path is dead.
 *
 * So: no code path below may make an accounts failure into a pairing failure.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { createLogger } from "@repo/logger";
import { createDb, migrate, type Db } from "@repo/db";
import { DEFAULT_PLAN } from "@repo/config/plans";

import { createRateLimiter } from "../rate-limit.js";
import { createEntitlements } from "../entitlements.js";
import {
  createBilling,
  claimDelivery,
  releaseDelivery,
} from "../billing/index.js";
import { createAuth } from "./auth.js";
import { accountsConfig, type AccountsConfig } from "./config.js";
import { applyCors, clientIp, readRawBody, sendJson } from "./http.js";
import { handlePublicRoute } from "./public.js";
import { handleAccountRoute, type RouteDeps } from "./routes.js";
import { createServerRegistry } from "./servers.js";
import type { Accounts, AuthedUser, Decision } from "./types.js";

export type { Accounts, AuthedUser, Decision } from "./types.js";
export type { AccountsConfig } from "./config.js";
export { accountsConfig, buildAccountsConfig } from "./config.js";
export { CLI_CLIENT_ID } from "./auth.js";

const logger = createLogger("api:accounts");

const AUTH_PREFIX = "/api/auth";
const WEBHOOK_PATH = "/api/auth/dodopayments/webhooks";

const ALLOWED: Decision = { allowed: true };

/**
 * Paths this module owns. Everything else falls through to the broker.
 *
 * `createStub` calls this same function, which is what makes a path added here
 * answer 503 without a database rather than throwing on a null `db`. Adding a
 * route to the router without adding it here is the failure mode — it would
 * 404 for everyone; adding it here without a stub answer would be worse.
 * `accounts.test.ts`'s "without a database" block pins both.
 */
function owns(pathname: string): boolean {
  return (
    pathname === AUTH_PREFIX ||
    pathname.startsWith(`${AUTH_PREFIX}/`) ||
    pathname === "/v1/auth/lookup" ||
    pathname === "/v1/auth/config" ||
    pathname === "/v1/me" ||
    pathname === "/v1/servers" ||
    pathname.startsWith("/v1/servers/") ||
    pathname === "/v1/billing" ||
    pathname.startsWith("/v1/billing/") ||
    // Authenticated, so it belongs here rather than with the anonymous pairing
    // routes the broker owns — it is the session that says which machines the
    // caller may ask for.
    pathname === "/v1/pair/request"
  );
}

/**
 * Open the accounts database, or return null.
 *
 * Migrations run here rather than as a deploy step: the broker is one process
 * that owns its own file, so there is no window where a new binary and an old
 * schema are both live. A failure is logged and swallowed — booting without
 * accounts is a working broker, and refusing to boot would take pairing down
 * over a feature the caller may not even use.
 */
export function openAccountsDb(
  config: AccountsConfig = accountsConfig,
): Db | null {
  if (!config.databaseUrl) {
    logger.info(
      "DATABASE_URL is unset — accounts and billing are off. Pairing and " +
        "tunnelling are unaffected.",
    );
    return null;
  }

  try {
    const db = createDb({ url: config.databaseUrl });
    migrate(db);
    return db;
  } catch (err) {
    logger.error(
      { err },
      "Could not open the accounts database; disabling accounts",
    );
    return null;
  }
}

export type CreateAccountsOptions = {
  /** Null disables accounts. See `openAccountsDb`. */
  db: Db | null;
  config?: AccountsConfig;
  /** See `RouteDeps.pairRequest`. Absent means the route answers 503. */
  pairRequest?: RouteDeps["pairRequest"];
};

export function createAccounts({
  db,
  config = accountsConfig,
  pairRequest,
}: CreateAccountsOptions): Accounts {
  if (!db) return createStub();

  try {
    return createLiveAccounts(db, config, pairRequest);
  } catch (err) {
    // Almost certainly a configuration error — a bad base URL, a plugin that
    // refused its options. Logged loudly, but it still must not stop the
    // broker from brokering.
    logger.error(
      { err },
      "Accounts failed to initialise; falling back to the stub",
    );
    return createStub();
  }
}

function createLiveAccounts(
  db: Db,
  config: AccountsConfig,
  pairRequest?: RouteDeps["pairRequest"],
): Accounts {
  const entitlements = createEntitlements(db);
  const billing = createBilling(db, config, entitlements);
  const registry = createServerRegistry(db, config.onlineWindowSeconds);

  const auth = createAuth({
    db,
    config,
    plugins: billing.plugin ? [billing.plugin] : [],
  });
  const authHandler = toNodeHandler(auth);

  // Two buckets: reads are generous because the dashboard polls, writes are
  // not because they are the ones that cost something. Keyed per user once
  // authenticated, per IP before that — otherwise one noisy network would
  // rate-limit everybody behind it out of signing in.
  const reads = createRateLimiter(config.requestsPerMinute);
  const writes = createRateLimiter(config.writesPerMinute);
  // A third bucket, an order of magnitude tighter, for the one route that
  // will happily tell a stranger whether an address has an account. See the
  // note on `lookupsPerMinute` and the one on `lookupAccount`.
  const lookups = createRateLimiter(config.lookupsPerMinute);

  const routeDeps = {
    db,
    config,
    registry,
    entitlements,
    billing,
    pairRequest,
  };

  async function authenticate(
    req: IncomingMessage,
  ): Promise<AuthedUser | null> {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      if (!session?.user) return null;

      const user = session.user as typeof session.user & {
        dodoCustomerId?: string | null;
      };
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: await entitlements.planFor(user.id),
        customerId: user.dodoCustomerId ?? null,
      };
    } catch (err) {
      // An unreadable session is an anonymous request, not a 500. The caller
      // decides whether anonymous is acceptable for what it is doing.
      logger.warn({ err }, "Session lookup failed");
      return null;
    }
  }

  /**
   * Dedupe a webhook delivery, then hand it to the plugin for verification.
   *
   * The plugin's handlers never see the `webhook-id` header — it reads the
   * headers itself and passes only the parsed event on — so the only place the
   * idempotency key is visible is here, in front of it. That means reading the
   * body before better-auth does, which in turn means this one path cannot go
   * through `toNodeHandler` (it would find an already-consumed stream) and is
   * replayed into `auth.handler` as a fetch `Request` instead.
   *
   * Order matters: the claim is taken before verification, so an unsigned
   * request could burn an id it does not own. That is acceptable and the
   * alternative is not — verifying first would mean parsing the body twice and
   * leaving the race this exists to close wide open — because the id is a
   * random 27-character ksuid from Dodo, so burning a *specific* future id
   * requires guessing it. A burnt claim is released whenever verification or
   * handling fails, below.
   */
  async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const raw = await readRawBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Webhook body is too large." });
      return;
    }

    const header = req.headers["webhook-id"];
    const deliveryId = Array.isArray(header) ? header[0] : header;
    if (!deliveryId) {
      sendJson(res, 400, { error: "Missing webhook-id." });
      return;
    }

    // Only a label for the stored row; the authoritative type comes from the
    // verified payload inside the plugin.
    let type = "unknown";
    try {
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        const value = (parsed as { type: unknown }).type;
        if (typeof value === "string") type = value.slice(0, 64);
      }
    } catch {
      // Unparseable bodies still get claimed and then rejected by the plugin.
    }

    if ((await claimDelivery(db, deliveryId, type)) === "duplicate") {
      logger.info({ type }, "Duplicate webhook delivery ignored");
      sendJson(res, 200, { received: true, duplicate: true });
      return;
    }

    let response: Response;
    try {
      response = await auth.handler(toWebRequest(req, raw, config));
    } catch (err) {
      await releaseDelivery(db, deliveryId);
      throw err;
    }

    if (!response.ok) await releaseDelivery(db, deliveryId);
    await writeWebResponse(res, response);
  }

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "api"}`);
    if (!owns(url.pathname)) return false;

    applyCors(req, res, config);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }

    if (url.pathname === WEBHOOK_PATH && req.method === "POST") {
      await handleWebhook(req, res);
      return true;
    }

    if (url.pathname.startsWith(AUTH_PREFIX)) {
      // Keyed by IP, because there is no user yet — and on the write bucket,
      // because the POSTs under this prefix are sign-in attempts. Thirty a
      // minute leaves the device grant's five-second poll (twelve a minute)
      // comfortable while making password guessing pointless.
      const ip = clientIp(req);
      const limiter = req.method === "GET" ? reads : writes;
      const key = `auth:${ip}`;
      if (!limiter.take(key)) {
        sendJson(
          res,
          429,
          { error: "Too many requests." },
          retryAfter(limiter, key),
        );
        return true;
      }
      // Not hand-rolled: `toNodeHandler` is what gets streaming bodies and
      // multiple Set-Cookie headers right, and both matter here — the session
      // cookie and the CSRF cookie are set in the same response.
      await authHandler(req, res);
      return true;
    }

    // Before `authenticate`, because these are what the sign-in page asks in
    // order to know what to render — there is by definition no session yet.
    if (
      await handlePublicRoute(
        {
          db,
          config,
          takeLookup: () => lookups.take(`lookup:${clientIp(req)}`),
          lookupRetryAfter: () =>
            retryAfter(lookups, `lookup:${clientIp(req)}`),
        },
        { req, res, url },
      )
    ) {
      return true;
    }

    const user = await authenticate(req);
    if (!user) {
      sendJson(res, 401, { error: "Sign in first: `mtmux login`." });
      return true;
    }

    const method = req.method ?? "GET";
    const limiter = method === "GET" ? reads : writes;
    if (!limiter.take(user.id)) {
      sendJson(
        res,
        429,
        { error: "Too many requests." },
        retryAfter(limiter, user.id),
      );
      return true;
    }

    const handled = await handleAccountRoute(routeDeps, {
      req,
      res,
      url,
      user,
    });
    if (!handled) sendJson(res, 404, { error: "Not found." });
    return true;
  }

  return {
    handleRequest,
    authenticate,
    ownerOfDevice: (publicKey) => registry.ownerOf(publicKey),
    checkTunnel: (userId) => entitlements.checkTunnel(userId),
    checkDevice: async (userId, serverId) => {
      if (!userId) return ALLOWED;
      return entitlements.checkDevice(
        userId,
        serverId,
        await entitlements.planFor(userId),
      );
    },
    recordUsage: (userId, bytes, seconds) =>
      entitlements.recordUsage(userId, bytes, seconds),
    enabled: true,
    close: async () => {
      // Nothing async to unwind: better-sqlite3 is synchronous and the process
      // is exiting. Kept async so the caller's shutdown path is uniform.
    },
  };
}

/**
 * The no-database accounts.
 *
 * Account routes answer 503 — they exist but are not configured, which is a
 * truer answer than 404 — while everything the pairing path asks is answered
 * permissively so that an install with no accounts behaves exactly like one
 * that never had them.
 *
 * The 503 covers every path `owns()` claims, including the unauthenticated
 * `/v1/auth/lookup` and `/v1/auth/config`. That is not incidental: a route
 * that is owned by the router but has no stub answer would reach a handler
 * with a null database and throw.
 */
function createStub(): Accounts {
  return {
    async handleRequest(req, res) {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "api"}`,
      );
      if (!owns(url.pathname)) return false;
      sendJson(res, 503, {
        error: "Accounts are not enabled on this broker.",
        plan: DEFAULT_PLAN,
      });
      return true;
    },
    async authenticate() {
      return null;
    },
    async ownerOfDevice() {
      // Every machine is anonymous when there is no registry to own it.
      return null;
    },
    async checkTunnel() {
      return ALLOWED;
    },
    async checkDevice() {
      return ALLOWED;
    },
    async recordUsage() {
      // Nowhere to record it, and nothing depends on it having happened.
    },
    enabled: false,
    async close() {},
  };
}

function retryAfter(
  limiter: { retryAfterMs(key: string): number },
  key: string,
): Record<string, string> {
  return {
    "Retry-After": String(Math.ceil(limiter.retryAfterMs(key) / 1000)),
  };
}

/** Rebuild a node request as a fetch `Request`, body included. */
function toWebRequest(
  req: IncomingMessage,
  body: Buffer,
  config: AccountsConfig,
): Request {
  const headers = fromNodeHeaders(req.headers);
  return new Request(new URL(req.url ?? "/", config.baseUrl), {
    method: req.method ?? "POST",
    headers,
    body: new Uint8Array(body),
  });
}

/** Copy a fetch `Response` onto a node one, preserving multiple Set-Cookie. */
async function writeWebResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    res.setHeader(key, value);
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);

  res.writeHead(response.status);
  res.end(Buffer.from(await response.arrayBuffer()));
}
