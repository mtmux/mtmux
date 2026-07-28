/**
 * A real broker, in a test.
 *
 * The interesting failures in this subsystem are not in the functions — they
 * are in the wiring: a cookie that is never sent back, a bearer token the
 * session lookup does not recognise, a webhook body consumed twice. None of
 * those are visible to a test that calls the handlers directly, so the tests
 * boot an actual `node:http` server on an ephemeral port and speak to it over
 * HTTP, exactly as the CLI does.
 *
 * Test-only. Nothing in `src/index.ts` imports this, so it is typechecked but
 * never bundled.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, migrate, type Db } from "@repo/db";

import { buildAccountsConfig, type AccountsConfig } from "./config.js";
import { createAccounts } from "./index.js";
import type { Accounts } from "./types.js";

export type Harness = {
  db: Db;
  accounts: Accounts;
  config: AccountsConfig;
  origin: string;
  /** Fetch against the harness, with paths relative to its origin. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Create a signed-in user and return its bearer token. */
  signUp(email: string, name?: string): Promise<{ token: string; id: string }>;
  close(): Promise<void>;
};

export async function startHarness(
  env: NodeJS.ProcessEnv = {},
): Promise<Harness> {
  const db = createDb({ url: ":memory:" });
  migrate(db);

  // The port is only known after listen, and better-auth needs it in its base
  // URL — so the server starts with a placeholder handler and is given the
  // real one once the address is known.
  let handle: http.RequestListener = (_req, res) => {
    res.writeHead(503);
    res.end();
  };
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const config = buildAccountsConfig({
    DATABASE_URL: ":memory:",
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "test-secret-not-used-anywhere-real",
    APP_ORIGIN: "http://localhost:14100",
    ...env,
  });

  const accounts = createAccounts({ db, config });

  handle = (req, res) => {
    void accounts
      .handleRequest(req, res)
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      })
      .catch((err: unknown) => {
        // Surfaced rather than swallowed: a 500 in a test should say why.
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
  };

  const request = (path: string, init?: RequestInit) =>
    fetch(`${origin}${path}`, init);

  return {
    db,
    accounts,
    config,
    origin,
    request,

    async signUp(email, name = "Test Person") {
      const res = await request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, password: "correct horse 12" }),
      });
      if (!res.ok) {
        throw new Error(`sign-up failed (${res.status}): ${await res.text()}`);
      }
      // `bearer()` mirrors the session cookie into this header precisely so a
      // non-browser client has something to send back.
      const token = res.headers.get("set-auth-token");
      if (!token) throw new Error("sign-up returned no set-auth-token header");
      const body = (await res.json()) as { user?: { id?: string } };
      return { token, id: body.user?.id ?? "" };
    },

    async close() {
      await accounts.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `Authorization: Bearer` headers, since every authenticated call needs them. */
export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
