/**
 * Accounts and billing configuration.
 *
 * Kept apart from `src/config.ts` on purpose. That file describes the *broker*,
 * which every mtmux install needs; this one describes the hosted service on top
 * of it, which almost nobody self-hosting will ever configure. Merging them
 * would make a self-hoster read twenty variables to find the four that matter,
 * and — worse — would make a fail-fast parse of an accounts variable able to
 * stop a broker that does not use accounts at all.
 *
 * So every value here has a working default, and the *absence* of a database
 * URL is a supported configuration rather than an error: accounts switch off
 * and pairing carries on.
 */
import { z } from "zod";

import { config as brokerConfig } from "../config.js";

const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    );

/**
 * The sentinel that means "nobody set a signing secret".
 *
 * Sessions signed with a well-known secret are forgeable, so this is refused in
 * production below. It exists at all so `pnpm dev:pairing` boots without
 * ceremony and so sessions survive a dev restart, which a random per-boot
 * secret would not.
 */
const DEV_SECRET = "mtmux-dev-secret-not-for-production";

const AccountsConfigSchema = z.object({
  /**
   * SQLite file for accounts. Empty means accounts are disabled entirely —
   * `createAccounts` returns the stub and the broker keeps pairing anonymously.
   */
  databaseUrl: z.string().default(""),

  /** Public origin of *this* API, and the issuer better-auth signs against. */
  baseUrl: z.string().default(""),
  /** Public origin of the browser app. Different host, hence the CORS dance. */
  appOrigin: z.string().default("http://localhost:14100"),

  secret: z.string().default(DEV_SECRET),

  /**
   * Cookie domain, e.g. `.mtmux.com`, so `app.` and `api.` share a session.
   *
   * Empty by default and *must* stay that way for local development: a cookie
   * scoped to `.mtmux.com` is simply never sent to `127.0.0.1`, which breaks
   * sign-in in a way whose symptom (a 401 on a request that just succeeded at
   * signing in) points nowhere near the cause.
   */
  cookieDomain: z.string().default(""),

  /**
   * better-auth's own CSRF allow-list. Separate from CORS, which is the
   * browser's check — this one is the server's, and both have to pass.
   */
  trustedOrigins: list(""),

  /** How recently a server must have beaten to count as online. */
  onlineWindowSeconds: z.coerce.number().int().positive().default(90),

  /**
   * The device grant's polling interval and code lifetime.
   *
   * The interval is advertised to the CLI *and* enforced by the server, which
   * answers `slow_down` to anything faster. Fifteen minutes to type a
   * six-character code is generous; it exists because the person doing the
   * typing may be walking to another room to find a browser.
   */
  devicePollSeconds: z.coerce.number().int().positive().default(5),
  deviceCodeMinutes: z.coerce.number().int().positive().default(15),

  /** Per-user sliding windows for the account API. */
  requestsPerMinute: z.coerce.number().int().positive().default(120),
  writesPerMinute: z.coerce.number().int().positive().default(30),
  /**
   * Its own bucket for `POST /v1/auth/lookup`, and much tighter than the write
   * one.
   *
   * That route is an account-enumeration oracle by design — it has to say
   * *which* sign-in methods an address has, or the UI shows a password box to
   * a Google-only account. The leak is accepted; scraping it is not. At the
   * write bucket's 30/min one IP could probe 43,000 addresses a day. Ten a
   * minute is invisible to a person signing in and useless to a list.
   */
  lookupsPerMinute: z.coerce.number().int().positive().default(10),

  /**
   * Transactional email, via Resend. Empty means no mail at all: no
   * verification, no password reset, and the magic-link plugin is never
   * mounted. Self-hosted mtmux sends nothing and needs an account with nobody.
   */
  resendApiKey: z.string().default(""),
  /** `From` header, e.g. `mtmux <hello@mtmux.com>`. Required for mail to send. */
  emailFrom: z.string().default(""),
  emailReplyTo: z.string().default(""),

  /**
   * Social sign-in. Each provider appears only when both halves are present,
   * so a half-configured provider is off rather than broken at the callback.
   *
   * The redirect URIs live under *this* origin, not the app's:
   *   https://api.mtmux.com/api/auth/callback/google
   *   https://api.mtmux.com/api/auth/callback/github
   * with `https://app.mtmux.com` as an authorized JS origin for Google.
   * GitHub allows exactly one callback per OAuth App, so production and
   * development need two separate apps.
   */
  googleClientId: z.string().default(""),
  googleClientSecret: z.string().default(""),
  githubClientId: z.string().default(""),
  githubClientSecret: z.string().default(""),

  /**
   * The WebAuthn Relying Party ID. **Read the note in `config.passkeyRpId`
   * below before changing this.** Empty means "derive it from APP_ORIGIN".
   */
  passkeyRpId: z.string().default(""),
  /** What the browser's passkey prompt calls us. */
  passkeyRpName: z.string().default("mtmux"),

  dodoApiKey: z.string().default(""),
  /**
   * ⚠︎ The Dodo SDK defaults to `live_mode`. Defaulting to test here means a
   * missing variable bills nobody, which is the correct direction to fail in.
   */
  dodoEnvironment: z.enum(["test_mode", "live_mode"]).default("test_mode"),
  dodoWebhookKey: z.string().default(""),
  /**
   * Create a Dodo customer during sign-up.
   *
   * Off by default, and that is a deliberate departure from the plugin's
   * suggested setup. Its sign-up hook throws a 500 when the Dodo API call
   * fails, which means enabling this makes *registration* unavailable
   * whenever the payment provider is — an outage in the thing that takes
   * money becoming an outage in the thing that makes accounts.
   *
   * Nothing needs it. A customer is created by the first checkout, and the
   * resulting webhook links the id back to the account, so the only thing
   * this buys is a customer record for people who never pay.
   */
  dodoCreateCustomerOnSignUp: z
    .string()
    .default("false")
    .transform((s) => s.toLowerCase() === "true"),
  dodoProductProMonthly: z.string().default(""),
  dodoProductProYearly: z.string().default(""),
});

export type AccountsConfig = z.infer<typeof AccountsConfigSchema> & {
  /**
   * Origins allowed to make credentialed requests.
   *
   * Separate from `trustedOrigins`: this one is the header the browser
   * enforces, that one is better-auth's own CSRF check. Both must list an
   * origin for a cross-site sign-in to work, and only one of them failing
   * produces a different, equally confusing error.
   */
  corsOrigins: string[];
  /** Whether cookies should be `Secure; SameSite=None` — https deployments. */
  secureCookies: boolean;
  /**
   * Where to send someone who has hit a plan limit, and where Dodo returns
   * them after a checkout or a portal visit.
   */
  upgradeUrl: string;
  /** The page that shows a device code prompt. */
  verificationUri: string;
  /** Whether billing is configured well enough to sell anything. */
  billingEnabled: boolean;
  /**
   * Whether mail can actually be sent.
   *
   * Gates three things that must move together: verification on sign-up,
   * password reset, and whether the magic-link plugin is mounted at all. A
   * mounted plugin with no mailer is worse than no plugin — the UI would offer
   * "email me a sign-in link" and the button would silently do nothing.
   */
  emailEnabled: boolean;
  /** Social providers configured well enough to offer. Order is UI order. */
  socialProviderIds: Array<"google" | "github">;
  /**
   * The WebAuthn Relying Party ID — **a one-way door.**
   *
   * Every passkey a browser stores is bound to the rpID it was created under.
   * Changing this later does not migrate anything; it silently invalidates
   * every passkey that has ever been created, with no way to recover them.
   *
   * It must be a registrable-domain suffix of the origin the ceremony runs on.
   * The ceremony runs in the browser, at `app.mtmux.com` — *not* at this API's
   * `api.mtmux.com`, which is what better-auth would otherwise default to from
   * `baseURL`. `app.mtmux.com` is not a suffix of `api.mtmux.com`, so that
   * default makes every single registration fail with `SecurityError`.
   *
   * So: the hostname of `APP_ORIGIN` by default, which is right for `pnpm dev`
   * (`localhost`) and right for every self-hoster, who serves one origin. The
   * hosted deployment sets `PASSKEY_RP_ID=mtmux.com` in `ecosystem.config.cjs`,
   * because that is deployment topology rather than a code default — the apex
   * covers `app.` and anything else we later put under it.
   *
   * Consciously accepted cost of choosing the apex: any page on any
   * `*.mtmux.com` subdomain can invoke these credentials. Never host untrusted
   * user content on one.
   */
  passkeyRpId: string;
};

/**
 * The Dodo mode, resolved before the rest of the config, because three other
 * values are selected by it.
 *
 * Duplicating the schema's default here is deliberate: the schema cannot see
 * the raw environment, and the key selection has to happen *before* the parse
 * that would otherwise tell us the mode. Both default to `test_mode`, and the
 * `routes.test.ts` cases pin them together.
 */
function dodoModeOf(env: NodeJS.ProcessEnv): "test_mode" | "live_mode" {
  return env.DODO_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode";
}

/**
 * Pick the value for the active Dodo mode.
 *
 * The unsuffixed variable wins when it is set, so every deployment that
 * configured Dodo before the split keeps working untouched. Otherwise the mode
 * chooses — which is the whole point: one `DODO_ENVIRONMENT=live_mode` flips
 * the key *and* both product ids together, and there is no state in which a
 * live key is used with test product ids.
 */
function byMode(
  mode: "test_mode" | "live_mode",
  override: string | undefined,
  test: string | undefined,
  live: string | undefined,
): string | undefined {
  if (override) return override;
  return (mode === "live_mode" ? live : test) || undefined;
}

function build(env: NodeJS.ProcessEnv): AccountsConfig {
  const dodoMode = dodoModeOf(env);
  const parsed = AccountsConfigSchema.parse({
    databaseUrl: env.DATABASE_URL,
    baseUrl: env.BETTER_AUTH_URL,
    appOrigin: env.APP_ORIGIN,
    secret: env.BETTER_AUTH_SECRET,
    cookieDomain: env.AUTH_COOKIE_DOMAIN,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    onlineWindowSeconds: env.SERVER_ONLINE_WINDOW_SECONDS,
    devicePollSeconds: env.DEVICE_POLL_SECONDS,
    deviceCodeMinutes: env.DEVICE_CODE_MINUTES,
    requestsPerMinute: env.ACCOUNT_REQUESTS_PER_MINUTE,
    writesPerMinute: env.ACCOUNT_WRITES_PER_MINUTE,
    lookupsPerMinute: env.ACCOUNT_LOOKUPS_PER_MINUTE,
    resendApiKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM,
    emailReplyTo: env.EMAIL_REPLY_TO,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    githubClientId: env.GITHUB_CLIENT_ID,
    githubClientSecret: env.GITHUB_CLIENT_SECRET,
    passkeyRpId: env.PASSKEY_RP_ID,
    passkeyRpName: env.PASSKEY_RP_NAME,
    dodoApiKey: byMode(
      dodoMode,
      env.DODO_PAYMENTS_API_KEY,
      env.DODO_PAYMENTS_TEST_API_KEY,
      env.DODO_PAYMENTS_LIVE_API_KEY,
    ),
    dodoEnvironment: env.DODO_ENVIRONMENT,
    dodoWebhookKey: byMode(
      dodoMode,
      env.DODO_WEBHOOK_KEY,
      env.DODO_WEBHOOK_KEY_TEST,
      env.DODO_WEBHOOK_KEY_LIVE,
    ),
    dodoCreateCustomerOnSignUp: env.DODO_CREATE_CUSTOMER_ON_SIGNUP,
    dodoProductProMonthly: byMode(
      dodoMode,
      env.DODO_PRODUCT_PRO_MONTHLY,
      env.DODO_PRODUCT_PRO_MONTHLY_TEST,
      env.DODO_PRODUCT_PRO_MONTHLY_LIVE,
    ),
    dodoProductProYearly: byMode(
      dodoMode,
      env.DODO_PRODUCT_PRO_YEARLY,
      env.DODO_PRODUCT_PRO_YEARLY_TEST,
      env.DODO_PRODUCT_PRO_YEARLY_LIVE,
    ),
  });

  const baseUrl =
    parsed.baseUrl ||
    `http://${brokerConfig.host === "0.0.0.0" ? "127.0.0.1" : brokerConfig.host}:${brokerConfig.port}`;

  // The browser only sends `SameSite=None` cookies over TLS, and only accepts
  // them cross-site, so this follows the scheme rather than being its own flag:
  // an https deployment is by definition the cross-origin one.
  const secureCookies = baseUrl.startsWith("https://");

  // Default the CSRF allow-list to everything already trusted elsewhere, so a
  // working CORS configuration does not additionally need a second variable
  // set to the same value.
  const trustedOrigins =
    parsed.trustedOrigins.length > 0
      ? parsed.trustedOrigins
      : [...new Set([parsed.appOrigin, ...brokerConfig.corsOrigins])];

  if (env.NODE_ENV === "production" && parsed.databaseUrl !== "") {
    if (parsed.secret === DEV_SECRET) {
      throw new Error(
        "BETTER_AUTH_SECRET must be set when DATABASE_URL is set in " +
          "production. Sessions signed with the development secret are " +
          "forgeable by anyone who has read this file.",
      );
    }
    if (!secureCookies) {
      throw new Error(
        "BETTER_AUTH_URL must be an https:// origin in production — session " +
          "cookies are issued Secure and would never be sent back over http.",
      );
    }
  }

  const socialProviderIds: Array<"google" | "github"> = [];
  if (parsed.googleClientId && parsed.googleClientSecret) {
    socialProviderIds.push("google");
  }
  if (parsed.githubClientId && parsed.githubClientSecret) {
    socialProviderIds.push("github");
  }

  return {
    ...parsed,
    baseUrl,
    trustedOrigins,
    corsOrigins: [...new Set([parsed.appOrigin, ...brokerConfig.corsOrigins])],
    secureCookies,
    emailEnabled: parsed.resendApiKey !== "" && parsed.emailFrom !== "",
    socialProviderIds,
    // Note the deliberate absence of a production fail-fast here, unlike the
    // secret and the https origin above. A missing Resend key or OAuth client
    // is a *feature that is off*, not a misconfiguration — invariant #5 in
    // spirit — and refusing to boot over one would make the optional
    // mandatory.
    passkeyRpId: parsed.passkeyRpId || hostnameOf(parsed.appOrigin),
    // Must match the route apps/web actually serves; a 402 that links to a 404
    // is worse than no link at all.
    upgradeUrl: `${parsed.appOrigin}/settings/billing`,
    verificationUri: `${parsed.appOrigin}/device`,
    billingEnabled:
      parsed.dodoApiKey !== "" && parsed.dodoProductProMonthly !== "",
  };
}

/**
 * The host part of an origin, with a safe fallback.
 *
 * `localhost` rather than a throw, because this feeds `passkeyRpId` and a
 * malformed `APP_ORIGIN` should degrade to a passkey that only works locally,
 * not stop the broker from brokering.
 */
function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return "localhost";
  }
}

/** Exported for tests, which need a config that is not the process's. */
export const buildAccountsConfig = build;

export const accountsConfig: AccountsConfig = build(process.env);
