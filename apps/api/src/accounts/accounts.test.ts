import { afterEach, describe, expect, it, vi } from "vitest";
import { servers, subscriptions } from "@repo/db";
import { eq } from "drizzle-orm";
import { TRIAL_MS } from "@repo/config/plans";

import { createAccounts } from "./index.js";
import { buildAccountsConfig } from "./config.js";
import { slugify } from "./servers.js";
import { matchPath } from "./http.js";
import { mirrorSubscription } from "../billing/subscriptions.js";
import { bearer, startHarness, type Harness } from "./testing.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

/**
 * Put an account in the "already had its trial, and it is over" state.
 *
 * The old refusal tests all need this now: without it, the first refusal is
 * not a refusal, it is the trial starting. Testing the refusal path still
 * matters — it is what a returning user hits — so this reaches past the API
 * to set up the one state the API deliberately has no route to create.
 */
async function spendTrial(h: Harness, userId: string): Promise<void> {
  await h.db
    .insert(subscriptions)
    .values({
      id: `sub_${userId}`,
      userId,
      trialStartedAt: new Date(Date.now() - TRIAL_MS * 2),
      trialEndsAt: new Date(Date.now() - TRIAL_MS),
    })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: {
        trialStartedAt: new Date(Date.now() - TRIAL_MS * 2),
        trialEndsAt: new Date(Date.now() - TRIAL_MS),
      },
    });
}

function registerBody(name: string, publicKey: string) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      publicKey,
      hostname: `${name}.local`,
      platform: "linux-x64",
      cliVersion: "1.2.3",
    }),
  };
}

/**
 * The most important test in the file.
 *
 * mtmux is a tool you install on your own server. If a missing database can
 * stop pairing, the self-hosted product is dead — so this asserts the whole
 * degradation contract, not just that nothing throws.
 */
describe("without a database", () => {
  const accounts = createAccounts({
    db: null,
    config: buildAccountsConfig({}),
  });

  it("does not claim paths it does not own", async () => {
    const seen: string[] = [];
    for (const path of ["/health", "/v1/discover", "/v1/pair/new"]) {
      const handled = await accounts.handleRequest(
        { url: path, headers: {}, method: "GET" } as never,
        { writeHead: () => {}, end: () => {} } as never,
      );
      if (handled) seen.push(path);
    }
    expect(seen).toEqual([]);
  });

  it("503s the account routes rather than 404ing them", async () => {
    let status = 0;
    const handled = await accounts.handleRequest(
      { url: "/v1/me", headers: {}, method: "GET" } as never,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: () => {},
        setHeader: () => {},
      } as never,
    );
    expect(handled).toBe(true);
    expect(status).toBe(503);
  });

  /**
   * The unauthenticated pair, which is the easy one to get wrong.
   *
   * `/v1/auth/lookup` and `/v1/auth/config` answer before `authenticate()`, so
   * a route claimed by `owns()` but not covered by the stub would reach a
   * handler holding a null database and throw — a 500 on the sign-in page of a
   * broker that simply has no accounts. 503, not a throw and not a 404.
   */
  it("503s the public auth routes too", async () => {
    for (const [path, method] of [
      ["/v1/auth/lookup", "POST"],
      ["/v1/auth/config", "GET"],
    ] as const) {
      let status = 0;
      const handled = await accounts.handleRequest(
        { url: path, headers: {}, method } as never,
        {
          writeHead: (code: number) => {
            status = code;
          },
          end: () => {},
          setHeader: () => {},
        } as never,
      );
      expect(handled, `${method} ${path} must be handled`).toBe(true);
      expect(status, `${method} ${path} must 503`).toBe(503);
    }
  });

  it("authenticates nobody and allows everybody", async () => {
    expect(await accounts.authenticate({ headers: {} } as never)).toBeNull();
    expect(await accounts.checkTunnel(null)).toEqual({ allowed: true });
    expect(await accounts.checkTunnel("someone")).toEqual({ allowed: true });
    await accounts.recordUsage("someone", 1024, 60);
    expect(accounts.enabled).toBe(false);
  });
});

describe("the account API", () => {
  let harness: Harness;

  const start = async () => {
    harness = await startHarness();
    return harness;
  };

  it("signs a user up and reads them back", async () => {
    const h = await start();
    try {
      const { token, id } = await h.signUp("me@example.com");
      const res = await h.request("/v1/me", { headers: bearer(token) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        userId: id,
        email: "me@example.com",
        plan: "free",
        planSource: "free",
        trial: {
          status: "none",
          startedAt: null,
          endsAt: null,
          daysLeft: 0,
        },
      });
    } finally {
      await h.close();
    }
  });

  it("refuses an unauthenticated request", async () => {
    const h = await start();
    try {
      expect((await h.request("/v1/me")).status).toBe(401);
      expect(
        (await h.request("/v1/me", { headers: bearer("nonsense") })).status,
      ).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("starts the trial on the second server instead of refusing it", async () => {
    const h = await start();
    try {
      const { token } = await h.signUp("one@example.com");

      const first = await h.request("/v1/servers/register", {
        ...registerBody("laptop", KEY_A),
        headers: {
          ...registerBody("laptop", KEY_A).headers,
          ...bearer(token),
        },
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as {
        serverId: string;
        trial: { justStarted: boolean };
      };
      expect(firstBody.serverId).toMatch(/^srv_/);
      // Free covers one server, so the first must not burn the trial.
      expect(firstBody.trial.justStarted).toBe(false);

      const second = await h.request("/v1/servers/register", {
        ...registerBody("desktop", KEY_B),
        headers: {
          ...registerBody("desktop", KEY_B).headers,
          ...bearer(token),
        },
      });
      // 201, not 402. This is the whole point: the moment free actually says
      // no is the moment the trial starts, and the user is never blocked.
      expect(second.status).toBe(201);
      const body = (await second.json()) as {
        plan: string;
        planSource: string;
        trial: { justStarted: boolean; daysLeft: number };
      };
      expect(body.plan).toBe("pro");
      expect(body.planSource).toBe("trial");
      expect(body.trial.justStarted).toBe(true);
      expect(body.trial.daysLeft).toBe(7);
    } finally {
      await h.close();
    }
  });

  it("refuses a second server once the trial is spent", async () => {
    const h = await start();
    try {
      const { token, id } = await h.signUp("spent@example.com");
      await spendTrial(h, id);

      await h.request("/v1/servers/register", {
        ...registerBody("laptop", KEY_A),
        headers: {
          ...registerBody("laptop", KEY_A).headers,
          ...bearer(token),
        },
      });

      const second = await h.request("/v1/servers/register", {
        ...registerBody("desktop", KEY_B),
        headers: {
          ...registerBody("desktop", KEY_B).headers,
          ...bearer(token),
        },
      });
      // 402, not 403: the limit is one that costs money to lift.
      expect(second.status).toBe(402);
      const body = (await second.json()) as {
        error: string;
        upgradeUrl: string;
      };
      expect(body.error).toContain("1 server");
      // Must be a route apps/web actually serves — a 402 linking to a 404 is
      // worse than a 402 with no link.
      expect(body.upgradeUrl).toBe("http://localhost:14100/settings/billing");
    } finally {
      await h.close();
    }
  });

  it("reattaches by public key instead of burning a second slot", async () => {
    const h = await start();
    try {
      const { token } = await h.signUp("again@example.com");
      const headers = { "Content-Type": "application/json", ...bearer(token) };

      const first = await h.request("/v1/servers/register", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "laptop", publicKey: KEY_A }),
      });
      const { serverId } = (await first.json()) as { serverId: string };

      // Same machine, renamed and upgraded. It must be the same row, and it
      // must not be counted against the one-server limit a second time.
      const again = await h.request("/v1/servers/register", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "laptop-renamed",
          publicKey: KEY_A,
          cliVersion: "9.9.9",
        }),
      });
      expect(again.status).toBe(200);
      expect((await again.json()) as { serverId: string }).toMatchObject({
        serverId,
      });

      const rows = await h.db
        .select()
        .from(servers)
        .where(eq(servers.publicKey, KEY_A));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.cliVersion).toBe("9.9.9");
    } finally {
      await h.close();
    }
  });

  it("refuses a machine already registered to someone else", async () => {
    const h = await start();
    try {
      const mine = await h.signUp("mine@example.com");
      const theirs = await h.signUp("theirs@example.com");

      await h.request("/v1/servers/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(mine.token) },
        body: JSON.stringify({ name: "shared", publicKey: KEY_A }),
      });

      const res = await h.request("/v1/servers/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...bearer(theirs.token),
        },
        body: JSON.stringify({ name: "shared", publicKey: KEY_A }),
      });
      expect(res.status).toBe(409);
    } finally {
      await h.close();
    }
  });

  it("treats a recent heartbeat as online and a stale one as not", async () => {
    const h = await start();
    try {
      const { token } = await h.signUp("beat@example.com");
      const headers = { "Content-Type": "application/json", ...bearer(token) };

      const created = await h.request("/v1/servers/register", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "beater", publicKey: KEY_A }),
      });
      const { serverId } = (await created.json()) as { serverId: string };

      const beat = await h.request(`/v1/servers/${serverId}/heartbeat`, {
        method: "POST",
        headers: bearer(token),
      });
      expect(beat.status).toBe(204);

      const online = (await (
        await h.request("/v1/servers", { headers: bearer(token) })
      ).json()) as { servers: Array<{ online: boolean; name: string }> };
      expect(online.servers).toHaveLength(1);
      expect(online.servers[0]).toMatchObject({ name: "beater", online: true });

      // Push the last beat outside the 90-second window.
      await h.db
        .update(servers)
        .set({ lastSeenAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(servers.id, serverId));

      const stale = (await (
        await h.request("/v1/servers", { headers: bearer(token) })
      ).json()) as { servers: Array<{ online: boolean }> };
      expect(stale.servers[0]?.online).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("will not heartbeat someone else's server", async () => {
    const h = await start();
    try {
      const mine = await h.signUp("a@example.com");
      const theirs = await h.signUp("b@example.com");

      const created = await h.request("/v1/servers/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(mine.token) },
        body: JSON.stringify({ name: "mine", publicKey: KEY_A }),
      });
      const { serverId } = (await created.json()) as { serverId: string };

      const res = await h.request(`/v1/servers/${serverId}/heartbeat`, {
        method: "POST",
        headers: bearer(theirs.token),
      });
      expect(res.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("starts the trial on the first rename rather than refusing it", async () => {
    const h = await start();
    try {
      const { token } = await h.signUp("firstrename@example.com");
      const headers = { "Content-Type": "application/json", ...bearer(token) };

      const created = await h.request("/v1/servers/register", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "box", publicKey: KEY_A }),
      });
      const { serverId } = (await created.json()) as { serverId: string };

      // Renaming is a Pro feature and this account is on free — so this is a
      // refusal the trial can fix, and it does.
      const renamed = await h.request(`/v1/servers/${serverId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "the good one" }),
      });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toEqual({ ok: true, trialStarted: true });
    } finally {
      await h.close();
    }
  });

  it("gates renaming behind Pro and allows it once subscribed", async () => {
    const h = await start();
    try {
      const { token, id } = await h.signUp("rename@example.com");
      const headers = { "Content-Type": "application/json", ...bearer(token) };
      await spendTrial(h, id);

      const created = await h.request("/v1/servers/register", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "box", publicKey: KEY_A }),
      });
      const { serverId } = (await created.json()) as { serverId: string };

      const refused = await h.request(`/v1/servers/${serverId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "the good one" }),
      });
      expect(refused.status).toBe(402);

      await mirrorSubscription(h.db, {
        userId: id,
        status: "active",
        plan: "pro",
      });

      const allowed = await h.request(`/v1/servers/${serverId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "the good one" }),
      });
      expect(allowed.status).toBe(200);

      const list = (await (
        await h.request("/v1/servers", { headers: bearer(token) })
      ).json()) as { servers: Array<{ name: string; slug: string }> };
      expect(list.servers[0]).toMatchObject({
        name: "the good one",
        slug: "the-good-one",
      });
    } finally {
      await h.close();
    }
  });

  it("deletes a server", async () => {
    const h = await start();
    try {
      const { token } = await h.signUp("bye@example.com");
      const created = await h.request("/v1/servers/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(token) },
        body: JSON.stringify({ name: "temp", publicKey: KEY_A }),
      });
      const { serverId } = (await created.json()) as { serverId: string };

      const res = await h.request(`/v1/servers/${serverId}`, {
        method: "DELETE",
        headers: bearer(token),
      });
      expect(res.status).toBe(204);
      expect(
        (
          (await (
            await h.request("/v1/servers", { headers: bearer(token) })
          ).json()) as { servers: unknown[] }
        ).servers,
      ).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("rejects a malformed public key before it reaches the database", async () => {
    const h = await start();
    try {
      const { token } = await h.signUp("bad@example.com");
      const res = await h.request("/v1/servers/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(token) },
        body: JSON.stringify({ name: "nope", publicKey: "not-a-key" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("publicKey"),
      });
    } finally {
      await h.close();
    }
  });

  it("answers a credentialed preflight with the exact origin", async () => {
    const h = await start();
    try {
      const res = await h.request("/v1/me", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:14100" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:14100",
      );
      // A wildcard here would be rejected outright by the browser, and a
      // missing credentials header silently drops the session cookie.
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("vary")).toContain("Origin");
    } finally {
      await h.close();
    }
  });

  it("does not offer CORS to an origin that is not allow-listed", async () => {
    const h = await start();
    try {
      const res = await h.request("/v1/me", {
        method: "OPTIONS",
        headers: { Origin: "https://attacker.example" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await h.close();
    }
  });
});

describe("GET /v1/auth/config", () => {
  it("offers only what is configured, and never needs a session", async () => {
    const h = await startHarness();
    try {
      const res = await h.request("/v1/auth/config");
      expect(res.status).toBe(200);
      // Password and passkeys need no third party, so they are always on. A
      // bare deployment offers exactly those and nothing else.
      expect(await res.json()).toEqual({
        emailPassword: true,
        passkeys: true,
        magicLink: false,
        passwordReset: false,
        providers: [],
      });
    } finally {
      await h.close();
    }
  });

  it("lights up as credentials appear", async () => {
    const h = await startHarness({
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "mtmux <hello@mtmux.test>",
      GOOGLE_CLIENT_ID: "g",
      GOOGLE_CLIENT_SECRET: "gs",
      GITHUB_CLIENT_ID: "h",
      GITHUB_CLIENT_SECRET: "hs",
    });
    try {
      expect(await (await h.request("/v1/auth/config")).json()).toEqual({
        emailPassword: true,
        passkeys: true,
        magicLink: true,
        passwordReset: true,
        providers: ["google", "github"],
      });
    } finally {
      await h.close();
    }
  });

  it("keeps a half-configured provider off rather than broken", async () => {
    // A client id with no secret would otherwise mount a provider whose
    // callback fails, which is a worse experience than no button.
    const h = await startHarness({ GOOGLE_CLIENT_ID: "g" });
    try {
      const body = (await (await h.request("/v1/auth/config")).json()) as {
        providers: string[];
      };
      expect(body.providers).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe("POST /v1/auth/lookup", () => {
  const lookup = (h: Harness, email: string) =>
    h.request("/v1/auth/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

  it("says which methods an account has, and nothing about one that has none", async () => {
    const h = await startHarness();
    try {
      await h.signUp("known@example.com");

      expect(await (await lookup(h, "KNOWN@example.com")).json()).toEqual({
        exists: true,
        hasPassword: true,
        hasPasskey: false,
        providers: [],
      });

      // A miss is the same shape with everything off — the client renders the
      // sign-up branch from `exists` alone.
      expect(await (await lookup(h, "nobody@example.com")).json()).toEqual({
        exists: false,
        hasPassword: false,
        hasPasskey: false,
        providers: [],
      });
    } finally {
      await h.close();
    }
  });

  /**
   * The timing mitigation, which is half of what makes the accepted
   * enumeration leak merely a leak rather than a scraping API. A hit reads
   * three tables and a miss short-circuits after one; without the floor that
   * difference is measurable from a browser.
   */
  it("takes the same time whether or not the account exists", async () => {
    const h = await startHarness();
    try {
      await h.signUp("timed@example.com");

      const hitAt = Date.now();
      await lookup(h, "timed@example.com");
      const hit = Date.now() - hitAt;

      const missAt = Date.now();
      await lookup(h, "absent@example.com");
      const miss = Date.now() - missAt;

      expect(hit).toBeGreaterThanOrEqual(100);
      expect(miss).toBeGreaterThanOrEqual(100);
    } finally {
      await h.close();
    }
  });

  it("has its own bucket, an order of magnitude tighter than writes", async () => {
    const h = await startHarness({ ACCOUNT_LOOKUPS_PER_MINUTE: "3" });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        codes.push((await lookup(h, `probe${i}@example.com`)).status);
      }
      // Three through, the fourth refused — and the write bucket's 30/min is
      // untouched, which is the point of it being a separate limiter.
      expect(codes).toEqual([200, 200, 200, 429]);
    } finally {
      await h.close();
    }
  });

  it("rejects something that is not an address before touching the database", async () => {
    const h = await startHarness();
    try {
      const res = await lookup(h, "not-an-email");
      expect(res.status).toBe(400);
    } finally {
      await h.close();
    }
  });
});

describe("email, when it is configured and when it is not", () => {
  const EMAIL_ENV = {
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "mtmux <hello@mtmux.test>",
  };

  /**
   * Intercept only Resend. The harness itself speaks HTTP to the server under
   * test, so a blanket `fetch` stub would break the thing being tested.
   */
  function stubResend(respond: () => Promise<Response>) {
    const real = globalThis.fetch;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("https://api.resend.com")) {
          calls.push(url);
          return respond();
        }
        return real(input as never, init);
      },
    );
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a verification mail on sign-up", async () => {
    const calls = stubResend(async () => new Response("{}", { status: 200 }));
    const h = await startHarness(EMAIL_ENV);
    try {
      await h.signUp("verify@example.com");
      expect(calls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  /**
   * The reason `@repo/email`'s mailer resolves rather than throws.
   *
   * better-auth awaits `sendVerificationEmail` inside the sign-up request, so a
   * rejection there turns a bad API key or a provider outage into a 500 on
   * registration. This service already refused that trade once — see
   * `dodoCreateCustomerOnSignUp` — and refuses it again here.
   */
  it("still creates the account when the mail provider is down", async () => {
    stubResend(() => Promise.reject(new Error("ECONNREFUSED")));
    const h = await startHarness(EMAIL_ENV);
    try {
      const { id } = await h.signUp("resilient@example.com");
      expect(id).not.toBe("");
    } finally {
      await h.close();
    }
  });

  it("mounts the magic-link route only when mail can be sent", async () => {
    const off = await startHarness();
    try {
      // Not 400, not 500 — the endpoint does not exist, so the UI's
      // `/v1/auth/config` says `magicLink: false` and never offers the button.
      const res = await off.request("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "someone@example.com" }),
      });
      expect(res.status).toBe(404);
    } finally {
      await off.close();
    }

    stubResend(async () => new Response("{}", { status: 200 }));
    const on = await startHarness(EMAIL_ENV);
    try {
      const res = await on.request("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "someone@example.com",
          callbackURL: "http://localhost:14100/dashboard",
        }),
      });
      expect(res.status).not.toBe(404);
    } finally {
      await on.close();
    }
  });
});

describe("passkey configuration", () => {
  /**
   * A one-way door, pinned by a test.
   *
   * Every passkey a browser stores is bound to the rpID it was created under.
   * If this ever silently becomes `api.mtmux.com` — which is what better-auth
   * derives from `baseURL` when it is not told otherwise — registrations fail
   * outright at `app.mtmux.com`; if it changes after launch, every passkey
   * ever created is invalidated with no recovery. So both the default and the
   * override are asserted rather than trusted.
   */
  it("derives the RP ID from the app origin, never from this API's", () => {
    expect(
      buildAccountsConfig({
        BETTER_AUTH_URL: "https://api.mtmux.com",
        APP_ORIGIN: "https://app.mtmux.com",
      }).passkeyRpId,
    ).toBe("app.mtmux.com");

    // What ecosystem.config.cjs actually sets in production: the apex, so one
    // credential covers `app.` and anything later put beside it.
    expect(
      buildAccountsConfig({
        BETTER_AUTH_URL: "https://api.mtmux.com",
        APP_ORIGIN: "https://app.mtmux.com",
        PASSKEY_RP_ID: "mtmux.com",
      }).passkeyRpId,
    ).toBe("mtmux.com");

    // Development, and every self-hoster serving a single origin.
    expect(buildAccountsConfig({}).passkeyRpId).toBe("localhost");
  });

  it("degrades a malformed APP_ORIGIN to localhost instead of throwing", () => {
    expect(buildAccountsConfig({ APP_ORIGIN: "not a url" }).passkeyRpId).toBe(
      "localhost",
    );
  });
});

describe("helpers", () => {
  it("slugifies names into addressable segments", () => {
    expect(slugify("My Laptop")).toBe("my-laptop");
    expect(slugify("  ---  ")).toBe("server");
    expect(slugify("Zoë's Laptop")).toBe("zoe-s-laptop");
  });

  it("matches only exact path shapes", () => {
    expect(matchPath("/v1/servers/:id", "/v1/servers/srv_1")).toEqual({
      id: "srv_1",
    });
    expect(matchPath("/v1/servers/:id", "/v1/servers/srv_1/heartbeat")).toBe(
      null,
    );
    expect(matchPath("/v1/servers/:id", "/v1/servers/")).toBe(null);
  });
});
