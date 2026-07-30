/**
 * The `/v1` account routes.
 *
 * Every route here is authenticated, rate limited and zod-validated by the
 * caller in `index.ts` before it arrives — this module is the business logic
 * and nothing else, which is why there is no auth check in sight below.
 *
 * The response shapes are a contract with `apps/cli/src/account.ts`. Field
 * names are camelCase and mirror that file exactly; the one place snake_case
 * appears anywhere in this service is the RFC 8628 device grant, where the
 * spec requires it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Db } from "@repo/db";
import { deviceIdFor, hexToBytes } from "@repo/crypto";
import { PairRequestBody } from "@repo/protocol";

import type { Billing } from "../billing/index.js";
import { CheckoutRequest } from "../billing/index.js";
import { readSubscription } from "../billing/subscriptions.js";
import type { Entitlements } from "../entitlements.js";
import type { AccountsConfig } from "./config.js";
import { matchPath, readBody, sendJson, sendNoContent } from "./http.js";
import type { ServerRegistry } from "./servers.js";
import type { AuthedUser } from "./types.js";

/**
 * A machine's Ed25519 identity: 32 bytes, hex. Validated tightly because it is
 * the primary key of the registry in everything but name — a malformed one
 * would create a row that the CLI could never match again.
 */
const PublicKey = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "must be a 64-character hex Ed25519 public key")
  .transform((s) => s.toLowerCase());

const ServerName = z
  .string()
  .trim()
  .min(1, "cannot be empty")
  .max(64, "must be 64 characters or fewer");

export const RegisterServerBody = z.object({
  name: ServerName,
  publicKey: PublicKey,
  hostname: z.string().trim().max(255).optional(),
  platform: z.string().trim().max(64).optional(),
  cliVersion: z.string().trim().max(32).optional(),
});

export const RenameServerBody = z.object({ name: ServerName });

export type RouteDeps = {
  db: Db;
  config: AccountsConfig;
  registry: ServerRegistry;
  entitlements: Entitlements;
  billing: Billing;
  /**
   * Hand a requested pairing to the broker, which owns the machine's socket.
   *
   * Split this way because the two halves know different things: only this
   * module can say who is asking and whether they own the machine, and only
   * the broker can reach it. The device id is resolved here so the broker is
   * never in a position to be told which machine to forward to.
   */
  pairRequest?: (
    deviceId: string,
    body: { deviceLabel: string; accountEmail: string },
  ) => { status: number; body: unknown };
};

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user: AuthedUser;
};

/** Handle a `/v1` route, or return false if this is not one of them. */
export async function handleAccountRoute(
  deps: RouteDeps,
  ctx: RouteContext,
): Promise<boolean> {
  const { req, res, url, user } = ctx;
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (pathname === "/v1/me" && method === "GET") {
    // Resolved here, not taken from `user.plan`. That field was captured in
    // `authenticate()` before this handler ran, and a trial that starts during
    // the request — or simply expires between the two — would make it a stale
    // read reporting "free" while entitlements say "pro".
    const resolved = await deps.entitlements.resolveFor(user.id);
    sendJson(res, 200, {
      userId: user.id,
      email: user.email,
      plan: resolved.plan,
      planSource: resolved.source,
      trial: resolved.trial,
    });
    return true;
  }

  if (pathname === "/v1/servers" && method === "GET") {
    sendJson(res, 200, {
      servers: await deps.registry.list(user.id),
    });
    return true;
  }

  if (pathname === "/v1/pair/request" && method === "POST") {
    const body = await readBody(req, PairRequestBody);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return true;
    }
    if (!deps.pairRequest) {
      sendJson(res, 503, { error: "Requested pairing is unavailable." });
      return true;
    }

    // The ownership check, and the only one that matters here. A machine the
    // caller does not own is reported exactly as one that does not exist, so
    // this cannot be used to discover other people's server ids.
    const owned = await deps.registry.list(user.id);
    const server = owned.find((s) => s.id === body.data.serverId);
    if (!server) {
      sendJson(res, 404, { error: "No such machine on this account." });
      return true;
    }

    const result = deps.pairRequest(deviceIdFor(hexToBytes(server.publicKey)), {
      deviceLabel: body.data.deviceLabel,
      // Shown on the machine so the person approving can see whose account
      // is asking. It is their own address; it tells them nothing new.
      accountEmail: user.email,
    });
    sendJson(res, result.status, result.body as Parameters<typeof sendJson>[2]);
    return true;
  }

  if (pathname === "/v1/servers/register" && method === "POST") {
    const body = await readBody(req, RegisterServerBody);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return true;
    }

    // Captured from the decision rather than re-queried afterwards: the trial
    // starts *because of* this check, and a second read could not tell "we
    // just started it" from "it was already running".
    let trialStarted = false;
    const outcome = await deps.registry.register(
      user.id,
      body.data,
      async () => {
        const decision = await deps.entitlements.checkServerLimit(user.id);
        trialStarted = decision.trialStarted === true;
        return decision;
      },
    );

    if (outcome.kind === "limited") {
      // 402 rather than 403: this is not a permission the account can be
      // granted by an administrator, it is one that costs money. The CLI
      // treats it as a normal outcome and keeps serving without an account.
      //
      // With the trial in place this is now a genuinely rare answer — it means
      // the account has already spent its trial — which is why the copy on the
      // CLI side leads with the upgrade rather than with the refusal.
      sendJson(res, 402, {
        error: outcome.reason,
        upgradeUrl: deps.config.upgradeUrl,
      });
      return true;
    }
    if (outcome.kind === "conflict") {
      sendJson(res, 409, { error: outcome.reason });
      return true;
    }

    const resolved = await deps.entitlements.resolveFor(user.id);
    sendJson(res, outcome.created ? 201 : 200, {
      serverId: outcome.serverId,
      plan: resolved.plan,
      planSource: resolved.source,
      trial: { ...resolved.trial, justStarted: trialStarted },
    });
    return true;
  }

  const heartbeat = matchPath("/v1/servers/:id/heartbeat", pathname);
  if (heartbeat && method === "POST") {
    const found = await deps.registry.heartbeat(
      user.id,
      heartbeat.id as string,
    );
    if (!found) {
      sendJson(res, 404, { error: "No such server." });
      return true;
    }
    sendNoContent(res);
    return true;
  }

  const server = matchPath("/v1/servers/:id", pathname);
  if (server && method === "PATCH") {
    // `user.plan` is the value `authenticate()` captured before this handler
    // ran; resolving again is what lets a rename be the thing that starts the
    // trial, and stops an expiry in between being missed.
    const current = await deps.entitlements.resolveFor(user.id);
    const rename = await deps.entitlements.checkRename(user.id, current.plan);
    if (!rename.allowed) {
      sendJson(res, 402, {
        error: rename.reason,
        upgradeUrl: deps.config.upgradeUrl,
      });
      return true;
    }

    const body = await readBody(req, RenameServerBody);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return true;
    }

    const found = await deps.registry.rename(
      user.id,
      server.id as string,
      body.data.name,
    );
    if (!found) {
      sendJson(res, 404, { error: "No such server." });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      trialStarted: rename.trialStarted === true,
    });
    return true;
  }

  if (server && method === "DELETE") {
    const found = await deps.registry.remove(user.id, server.id as string);
    if (!found) {
      sendJson(res, 404, { error: "No such server." });
      return true;
    }
    sendNoContent(res);
    return true;
  }

  if (pathname === "/v1/billing" && method === "GET") {
    sendJson(res, 200, await deps.billing.summary(user.id));
    return true;
  }

  if (pathname === "/v1/billing/checkout" && method === "POST") {
    const body = await readBody(req, CheckoutRequest);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return true;
    }

    const outcome = await deps.billing.checkout(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        customerId: user.customerId,
      },
      body.data,
    );
    if (outcome.kind !== "ok") {
      // 503, not 4xx: nothing about the request was wrong, this deployment
      // simply cannot sell anything right now.
      sendJson(res, 503, { error: outcome.reason });
      return true;
    }
    sendJson(res, 200, { url: outcome.url });
    return true;
  }

  if (pathname === "/v1/billing/portal" && method === "POST") {
    // The portal is keyed by the Dodo customer, which the mirror knows about
    // even when the plugin has not yet written it back to the user row.
    const subscription = await readSubscription(deps.db, user.id);
    const outcome = await deps.billing.portal(
      user.customerId ?? subscription.dodoCustomerId,
    );
    if (outcome.kind !== "ok") {
      sendJson(res, 503, { error: outcome.reason });
      return true;
    }
    sendJson(res, 200, { url: outcome.url });
    return true;
  }

  return false;
}
