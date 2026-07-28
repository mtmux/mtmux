/**
 * The `mtmux login` flow, end to end.
 *
 * These assertions are a contract with `apps/cli/src/account.ts`, which is why
 * they check exact field names and error strings rather than "it worked". Two
 * of them encode deviations from stock RFC 8628 that cost real time to find:
 * `/device/token` refuses a form-encoded body, and `/device/approve` will not
 * approve a code the browser has not first claimed with `GET /device`.
 */
import { describe, expect, it } from "vitest";

import { bearer, startHarness } from "./testing.js";

const CLIENT = { client_id: "mtmux-cli", scope: "servers" };
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("device authorization", () => {
  it("signs a headless CLI in once a browser approves", async () => {
    // A one-second interval so the test does not have to wait out the real
    // `slow_down` window between polls.
    const h = await startHarness({ DEVICE_POLL_SECONDS: "1" });
    try {
      const { token: browserToken, id: userId } =
        await h.signUp("cli@example.com");

      const codeRes = await h.request("/api/auth/device/code", json(CLIENT));
      expect(codeRes.status).toBe(200);
      const grant = (await codeRes.json()) as Record<string, unknown>;

      // Exactly the fields apps/cli/src/account.ts reads.
      expect(grant).toMatchObject({
        device_code: expect.any(String),
        user_code: expect.any(String),
        verification_uri: "http://localhost:14100/device",
        verification_uri_complete: expect.stringContaining(
          "http://localhost:14100/device",
        ),
        expires_in: expect.any(Number),
        interval: 1,
      });

      const poll = () =>
        h.request(
          "/api/auth/device/token",
          json({
            grant_type: GRANT,
            device_code: grant.device_code,
            client_id: "mtmux-cli",
          }),
        );

      const pending = await poll();
      expect(pending.status).toBe(400);
      expect((await pending.json()) as { error: string }).toMatchObject({
        error: "authorization_pending",
      });

      // The browser half. `/device/approve` on its own is refused — the code
      // has to be claimed by an authenticated `GET /device` first.
      const premature = await h.request(
        "/api/auth/device/approve",
        json({ userCode: grant.user_code }),
      );
      expect(premature.ok).toBe(false);

      const claim = await h.request(
        `/api/auth/device?user_code=${String(grant.user_code)}`,
        { headers: bearer(browserToken) },
      );
      expect(claim.status).toBe(200);

      const approve = await h.request("/api/auth/device/approve", {
        ...json({ userCode: grant.user_code }),
        headers: {
          ...json({}).headers,
          ...bearer(browserToken),
        },
      });
      expect(approve.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const granted = await poll();
      expect(granted.status).toBe(200);
      const session = (await granted.json()) as { access_token?: string };
      // The token comes back in the body only — no cookie, no set-auth-token.
      expect(session.access_token).toEqual(expect.any(String));
      expect(granted.headers.get("set-auth-token")).toBeNull();

      // And it is a real session token that `bearer()` accepts.
      const me = await h.request("/v1/me", {
        headers: bearer(session.access_token as string),
      });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        userId,
        email: "cli@example.com",
        plan: "free",
      });
    } finally {
      await h.close();
    }
  });

  it("refuses a client id that is not the mtmux CLI", async () => {
    const h = await startHarness();
    try {
      const res = await h.request(
        "/api/auth/device/code",
        json({ client_id: "somebody-elses-cli" }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: "invalid_client",
      });
    } finally {
      await h.close();
    }
  });

  it("refuses a form-encoded token request", async () => {
    // Stock RFC 8628 says form encoding; better-auth wants JSON, and the
    // resulting UNSUPPORTED_MEDIA_TYPE looks nothing like an OAuth error.
    const h = await startHarness();
    try {
      const grant = (await (
        await h.request("/api/auth/device/code", json(CLIENT))
      ).json()) as { device_code: string };

      const res = await h.request("/api/auth/device/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: GRANT,
          device_code: grant.device_code,
          client_id: "mtmux-cli",
        }).toString(),
      });
      expect(res.status).toBe(415);
    } finally {
      await h.close();
    }
  });

  it("tells a CLI polling too fast to slow down", async () => {
    const h = await startHarness();
    try {
      const grant = (await (
        await h.request("/api/auth/device/code", json(CLIENT))
      ).json()) as { device_code: string };

      const body = json({
        grant_type: GRANT,
        device_code: grant.device_code,
        client_id: "mtmux-cli",
      });
      await h.request("/api/auth/device/token", body);
      const second = await h.request("/api/auth/device/token", body);

      expect((await second.json()) as { error: string }).toMatchObject({
        error: "slow_down",
      });
    } finally {
      await h.close();
    }
  });
});
