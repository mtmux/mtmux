import { describe, expect, it } from "vitest";
import { servers } from "@repo/db";
import { eq } from "drizzle-orm";

import { createAccounts } from "./index.js";
import { buildAccountsConfig } from "./config.js";
import { slugify } from "./servers.js";
import { matchPath } from "./http.js";
import { mirrorSubscription } from "../billing/subscriptions.js";
import { bearer, startHarness, type Harness } from "./testing.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

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

  it("registers a server, then refuses a second one on the free plan", async () => {
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
      const firstBody = (await first.json()) as { serverId: string };
      expect(firstBody.serverId).toMatch(/^srv_/);

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

  it("gates renaming behind Pro and allows it once subscribed", async () => {
    const h = await start();
    try {
      const { token, id } = await h.signUp("rename@example.com");
      const headers = { "Content-Type": "application/json", ...bearer(token) };

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
