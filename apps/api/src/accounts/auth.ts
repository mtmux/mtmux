/**
 * The better-auth instance.
 *
 * Three things make this configuration non-obvious, and all three are here
 * rather than spread across the routes:
 *
 * 1. **Two origins.** The browser is `app.mtmux.com`; this API is
 *    `api.mtmux.com`. That makes every authenticated request cross-site, so
 *    the session cookie has to be `SameSite=None; Secure` and scoped to the
 *    parent domain. It also means two independent allow-lists must agree —
 *    CORS (the browser's check, in `http.ts`) and `trustedOrigins`
 *    (better-auth's own CSRF check, here).
 * 2. **No browser on the CLI's machine.** `mtmux login` runs on a headless
 *    box, so sign-in is the device authorization grant: the CLI polls, a
 *    human approves somewhere else.
 * 3. **Local development is the common case.** Everything above is derived
 *    from configuration with localhost defaults, because a hard-coded
 *    `.mtmux.com` cookie domain does not merely degrade `pnpm dev:pairing`,
 *    it makes signing in impossible there.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { schema, type Db } from "@repo/db";

import type { AccountsConfig } from "./config.js";

/** The one client id `mtmux login` presents. */
export const CLI_CLIENT_ID = "mtmux-cli";

/**
 * A CLI session has to outlive a laptop lid, a holiday, and a broker restart.
 *
 * Thirty days with a rolling one-day refresh means a machine that is used at
 * all never signs in twice, while an abandoned token still expires. The refresh
 * is what makes the long lifetime acceptable: an unused token is not renewed.
 */
const SESSION_EXPIRES_IN = 60 * 60 * 24 * 30;
const SESSION_UPDATE_AGE = 60 * 60 * 24;

export type AuthPluginList = NonNullable<
  Parameters<typeof betterAuth>[0]["plugins"]
>;

/**
 * The slice of better-auth this service actually uses.
 *
 * Declared by hand rather than inferred, for a mundane but unavoidable reason:
 * better-auth's inferred instance type transitively names types from *its*
 * copy of zod (v4), while this workspace is on zod v3, and TypeScript cannot
 * write a portable declaration that references a package the consumer does not
 * have. Annotating the boundary stops the inference at the point where it is
 * no longer anyone else's problem.
 *
 * Narrowing it is a small bonus: everything outside this module talks to
 * accounts through `Accounts`, so a wider type here would only make it easier
 * to reach past that seam by accident.
 */
export type Auth = {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (context: { headers: Headers }) => Promise<{
      user: { id: string; email: string; name: string };
    } | null>;
  };
};

export type CreateAuthOptions = {
  db: Db;
  config: AccountsConfig;
  /**
   * Extra plugins — in practice the Dodo Payments plugin, injected rather than
   * imported so that this module stays loadable (and the schema stays
   * generatable) with no payment provider configured at all.
   */
  plugins?: AuthPluginList;
};

export function createAuth(options: CreateAuthOptions): Auth {
  return build(options);
}

function build({ db, config, plugins = [] }: CreateAuthOptions) {
  return betterAuth({
    baseURL: config.baseUrl,
    secret: config.secret,

    // The schema must be handed to the adapter as well as to `drizzle()`.
    // Without it the failure is deferred to the first request that touches a
    // model — `The model "user" was not found in the schema object` — rather
    // than to boot, which is a miserable way to find out.
    database: drizzleAdapter(db, { provider: "sqlite", schema }),

    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
    },

    trustedOrigins: config.trustedOrigins,

    advanced: {
      ...(config.cookieDomain
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: config.cookieDomain,
            },
          }
        : {}),
      // `SameSite=None` is only honoured alongside `Secure`, and `Secure`
      // cookies are dropped over plain http — so the two move together and
      // development falls back to a same-site `Lax` cookie.
      defaultCookieAttributes: config.secureCookies
        ? { sameSite: "none", secure: true, httpOnly: true }
        : { sameSite: "lax", secure: false, httpOnly: true },
      useSecureCookies: config.secureCookies,
    },

    session: {
      expiresIn: SESSION_EXPIRES_IN,
      updateAge: SESSION_UPDATE_AGE,
    },

    plugins: [
      // Lets the CLI authenticate with `Authorization: Bearer <token>`. The
      // token the device grant returns *is* a session token, so this is the
      // only thing that makes it usable.
      bearer(),
      deviceAuthorization({
        verificationUri: config.verificationUri,
        expiresIn: `${config.deviceCodeMinutes}m`,
        interval: `${config.devicePollSeconds}s`,
        // One client, checked explicitly. An unvalidated client id would let
        // anything start a device flow against this deployment.
        validateClient: (clientId) => clientId === CLI_CLIENT_ID,
      }),
      ...plugins,
    ],
  });
}
