/**
 * The two `/v1/auth/*` routes that answer *before* anyone is signed in.
 *
 * Everything in `routes.ts` runs behind `authenticate()`. These two cannot:
 * they are what the sign-in page asks in order to know what to render. They
 * live in their own module so that the "every route here is authenticated"
 * contract that file opens with stays true.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { account, passkey, user, type Db } from "@repo/db";

import type { AccountsConfig } from "./config.js";
import { readBody, sendJson } from "./http.js";

/**
 * Deliberately loose, matching the client's own check. The authority on
 * whether an address exists is this very endpoint; a strict pattern would only
 * reject somebody's perfectly valid address before it got the chance.
 */
export const LookupBody = z.object({
  email: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address")
    .transform((s) => s.toLowerCase()),
});

/**
 * How long every lookup takes, at a minimum.
 *
 * A hit reads three tables; a miss short-circuits after one. Left alone that
 * difference is measurable from a browser, and it would hand back exactly the
 * signal the rate limit is there to make expensive. Padding to a fixed floor
 * costs a signed-in user nothing they will notice and makes the two cases
 * indistinguishable by timing.
 *
 * It is a floor and not a fixed delay on purpose: a slow query makes the
 * response late rather than making the padding negative.
 */
const RESPONSE_FLOOR_MS = 120;

export type LookupResult = {
  exists: boolean;
  /** Whether a password sign-in would work. */
  hasPassword: boolean;
  /** Whether to offer the passkey button. */
  hasPasskey: boolean;
  /** Social providers already linked, e.g. `["google"]`. */
  providers: string[];
};

/**
 * What sign-in methods this deployment offers at all.
 *
 * Fetched at runtime rather than inlined as `NEXT_PUBLIC_*`, and that is the
 * whole point: Next inlines public env vars at build time, so rotating or
 * adding a provider would otherwise mean a rebuild and a redeploy of the web
 * app. It also leaves `deploy:hosted`'s bundle-origin grep untouched. The
 * client fails soft to password-only when this 404s, so deploying the web app
 * against an older API degrades instead of white-screening.
 */
export type AuthConfigResult = {
  emailPassword: boolean;
  passkeys: boolean;
  magicLink: boolean;
  passwordReset: boolean;
  providers: string[];
};

export function authConfig(config: AccountsConfig): AuthConfigResult {
  return {
    emailPassword: true,
    passkeys: true,
    // Both are the same capability wearing two hats: no mailer, no link.
    magicLink: config.emailEnabled,
    passwordReset: config.emailEnabled,
    providers: [...config.socialProviderIds],
  };
}

/**
 * Which sign-in methods exist for one address.
 *
 * **This is an account-enumeration oracle, and that is a considered trade.**
 * The oracle already exists — `sign-up/email` answers "User already exists" —
 * but this leaks more than a boolean, because the UI has to know *which*
 * methods to offer or it shows a dead-end password box to a Google-only
 * account. For a developer tool that is a low-consequence leak. It is paid for
 * with a dedicated 10/minute bucket and the timing floor above, and not with a
 * captcha: a third-party script on the most important path in the product is a
 * worse trade than the leak it would defend. better-auth ships a captcha
 * plugin if that judgement ever changes.
 */
export async function lookupAccount(
  db: Db,
  email: string,
): Promise<LookupResult> {
  const empty: LookupResult = {
    exists: false,
    hasPassword: false,
    hasPasskey: false,
    providers: [],
  };

  // `lower()` on both sides: better-auth normalises on write, but a row
  // created by an older path or by hand should still be found.
  const users = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email))
    .limit(1);

  const found = users[0];
  if (!found) return empty;

  const accounts = await db
    .select({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, found.id));

  const passkeys = await db
    .select({ count: sql<number>`count(*)` })
    .from(passkey)
    .where(eq(passkey.userId, found.id));

  return {
    exists: true,
    // better-auth files password credentials under the `credential` provider.
    hasPassword: accounts.some((a) => a.providerId === "credential"),
    hasPasskey: Number(passkeys[0]?.count ?? 0) > 0,
    providers: [
      ...new Set(
        accounts
          .map((a) => a.providerId)
          .filter((id) => id !== "credential" && id !== "passkey"),
      ),
    ].sort(),
  };
}

export type PublicRouteDeps = {
  db: Db;
  config: AccountsConfig;
  /** Consume one lookup token for this caller, or refuse. */
  takeLookup: () => boolean;
  /** `Retry-After` headers for a refused lookup. */
  lookupRetryAfter: () => Record<string, string>;
};

/** Handle a public `/v1/auth` route, or return false if this is not one. */
export async function handlePublicRoute(
  deps: PublicRouteDeps,
  ctx: { req: IncomingMessage; res: ServerResponse; url: URL },
): Promise<boolean> {
  const { req, res, url } = ctx;
  const method = req.method ?? "GET";

  if (url.pathname === "/v1/auth/config" && method === "GET") {
    sendJson(res, 200, { ...authConfig(deps.config) });
    return true;
  }

  if (url.pathname === "/v1/auth/lookup" && method === "POST") {
    if (!deps.takeLookup()) {
      sendJson(
        res,
        429,
        { error: "Too many requests." },
        deps.lookupRetryAfter(),
      );
      return true;
    }

    const started = Date.now();
    const body = await readBody(req, LookupBody);
    if (!body.ok) {
      // No floor on a malformed address: it says nothing about whether any
      // account exists, so there is nothing to hide behind constant time.
      sendJson(res, body.status, { error: body.error });
      return true;
    }

    const result = await lookupAccount(deps.db, body.data.email);
    await floor(started);
    sendJson(res, 200, { ...result });
    return true;
  }

  return false;
}

async function floor(startedAt: number): Promise<void> {
  const remaining = RESPONSE_FLOOR_MS - (Date.now() - startedAt);
  if (remaining <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, remaining));
}
