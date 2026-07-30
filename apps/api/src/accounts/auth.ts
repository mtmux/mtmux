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
import { magicLink } from "better-auth/plugins/magic-link";
import { passkey } from "@better-auth/passkey";
import { schema, type Db } from "@repo/db";
import {
  createMailer,
  magicLinkEmail,
  passwordResetEmail,
  verificationEmail,
  type Mailer,
} from "@repo/email";
import { createLogger } from "@repo/logger";

import type { AccountsConfig } from "./config.js";

const logger = createLogger("api:auth");

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

/**
 * Link lifetimes, in seconds, alongside the minutes the mail copy quotes.
 *
 * Kept as pairs so the sentence in the email and the value better-auth
 * enforces cannot drift — a mail that says "expires in an hour" about a
 * five-minute token is a support ticket.
 */
const VERIFY_EXPIRES_IN = 60 * 60;
const RESET_EXPIRES_IN = 60 * 60;
/**
 * Ten minutes rather than better-auth's five. A sign-in link is only useful
 * once it has cleared a mail queue and a spam filter, and the failure mode of
 * "expired before it arrived" is far more common than the one this bound is
 * defending against — the token is single-use and 32 bytes of entropy.
 */
const MAGIC_LINK_EXPIRES_IN = 60 * 10;

const asMinutes = (seconds: number) => Math.round(seconds / 60);

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
  // Null when no Resend key is configured, exactly like `createDodoClient`.
  // Every use below is guarded, and `send` itself never rejects — a mail
  // failure must never become a 500 on sign-up.
  const mailer = createMailer({
    apiKey: config.resendApiKey,
    from: config.emailFrom,
    ...(config.emailReplyTo ? { replyTo: config.emailReplyTo } : {}),
  });

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
      resetPasswordTokenExpiresIn: RESET_EXPIRES_IN,
      // The other half of "Forgot password?", which the product did not have
      // at all until now. Absent when there is no mailer, so better-auth
      // refuses the request outright rather than accepting it and sending
      // nothing.
      ...(mailer
        ? {
            sendResetPassword: async ({ user, url }) => {
              await send(
                mailer,
                user.email,
                passwordResetEmail({
                  name: user.name,
                  url: appCallback(url, config, "/signin"),
                  expiresInMinutes: asMinutes(RESET_EXPIRES_IN),
                }),
              );
            },
          }
        : {}),
    },

    /**
     * Verification is sent, never required.
     *
     * `requireEmailVerification` stays false on purpose: gating sign-in on a
     * mail that may be delayed, filtered or simply never configured turns an
     * optional dependency into a hard one. What verification *is* for here is
     * finding #6 — a verified address is what later lets a Google or GitHub
     * identity link to an account that started as a password sign-up, so
     * sending it eagerly at sign-up quietly removes that friction for almost
     * everybody before they ever hit it.
     */
    emailVerification: {
      expiresIn: VERIFY_EXPIRES_IN,
      sendOnSignUp: mailer !== null,
      autoSignInAfterVerification: true,
      ...(mailer
        ? {
            sendVerificationEmail: async ({ user, url }) => {
              await send(
                mailer,
                user.email,
                verificationEmail({
                  name: user.name,
                  url: appCallback(url, config, "/dashboard"),
                  expiresInMinutes: asMinutes(VERIFY_EXPIRES_IN),
                }),
              );
            },
          }
        : {}),
    },

    /**
     * Social sign-in, present only when both halves of a provider's
     * credentials are set. Missing credentials mean the provider simply does
     * not exist — no button, no route, no half-working callback.
     *
     * Deliberately *not* set: `trustedProviders` and `requireLocalEmailVerified`
     * (finding #6). `trustedProviders` short-circuits only the provider-verified
     * clause of the account-linking gate, not the local-verification one, so it
     * does not do what its name suggests; and `requireLocalEmailVerified` is
     * marked deprecated for removal next minor. The production database has
     * zero users, so there is no legacy cohort to rescue and no reason to take
     * anything but the secure default.
     */
    socialProviders: {
      ...(config.socialProviderIds.includes("google")
        ? {
            google: {
              clientId: config.googleClientId,
              clientSecret: config.googleClientSecret,
            },
          }
        : {}),
      ...(config.socialProviderIds.includes("github")
        ? {
            github: {
              clientId: config.githubClientId,
              clientSecret: config.githubClientSecret,
              // Not optional. GitHub users can hide their primary address, and
              // without this scope the userinfo call comes back with no email
              // at all — which fails sign-up with an error that says nothing
              // about scopes.
              scope: ["user:email"],
            },
          }
        : {}),
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

      /**
       * Passkeys.
       *
       * `rpID` is passed explicitly and must never be left to the default —
       * see the long note on `AccountsConfig.passkeyRpId`. In one line: the
       * default derives from this API's `baseURL`, the ceremony runs at the
       * *app's* origin, and the two are sibling subdomains, so every
       * registration would fail with `SecurityError`.
       *
       * `origin` is the app, for the same reason. There is nothing to do for
       * the CLI: `mtmux login` never authenticates — it prints a code and a
       * human approves it in a browser — so passkeys already work there.
       */
      passkey({
        rpID: config.passkeyRpId,
        rpName: config.passkeyRpName,
        origin: config.appOrigin,
      }),

      // Mounted only when mail can actually be sent. A magic-link plugin with
      // no mailer would give the UI a "email me a sign-in link" button that
      // succeeds and delivers nothing, which is worse than not offering it.
      ...(mailer
        ? [
            magicLink({
              expiresIn: MAGIC_LINK_EXPIRES_IN,
              sendMagicLink: async ({ email, url }) => {
                await send(
                  mailer,
                  email,
                  magicLinkEmail({
                    url: appCallback(url, config, "/dashboard"),
                    expiresInMinutes: asMinutes(MAGIC_LINK_EXPIRES_IN),
                  }),
                );
              },
            }),
          ]
        : []),

      ...plugins,
    ],
  });
}

/**
 * Send, and swallow.
 *
 * better-auth awaits these hooks inside the request it is serving, so a
 * rejection here is a 500 on sign-up or on a password-reset request. The
 * mailer already resolves rather than throwing; this is the belt to that
 * braces, and the one place a failure is turned into a log line.
 */
async function send(
  mailer: Mailer,
  to: string,
  content: { subject: string; html: string; text: string },
): Promise<void> {
  const result = await mailer.send(to, content);
  if (!result.ok) {
    // The subject, never the recipient. Which mail failed is operationally
    // useful; who it was addressed to is not something this service logs.
    logger.warn({ subject: content.subject }, "Transactional email not sent");
  }
}

/**
 * Force a link's `callbackURL` onto the *app's* origin.
 *
 * Every one of these links points at this API — better-auth consumes the token
 * here and then redirects to `callbackURL`. A relative or missing one resolves
 * against `api.mtmux.com`, landing the user on a host that serves no pages at
 * all. An absolute one supplied by the client has already been checked against
 * `trustedOrigins` by better-auth, so it is left alone.
 */
function appCallback(
  url: string,
  config: AccountsConfig,
  fallbackPath: string,
): string {
  try {
    const parsed = new URL(url);
    const callback = parsed.searchParams.get("callbackURL");
    if (!callback || !/^https?:\/\//i.test(callback)) {
      parsed.searchParams.set(
        "callbackURL",
        `${config.appOrigin}${fallbackPath}`,
      );
    }
    return parsed.toString();
  } catch {
    // Not a URL we can reason about; send it as better-auth built it rather
    // than dropping the mail.
    return url;
  }
}
