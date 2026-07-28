/**
 * The auth instance that `packages/db/src/schema/auth.ts` is generated from.
 *
 * better-auth owns the shape of its own tables — it issues the queries, so a
 * hand-written guess at the column names is a runtime failure waiting for the
 * first sign-in. The schema is therefore generated, not written:
 *
 * ```sh
 * npx auth@latest generate \
 *   --config apps/api/src/accounts/auth.generate.ts \
 *   --output packages/db/src/schema/auth.ts -y
 * pnpm --filter @repo/db generate    # then the SQL migration
 * ```
 *
 * (The CLI package is `auth`. `@better-auth/cli` is abandoned at 1.4.21 and
 * emits a schema several plugin versions out of date.)
 *
 * This file exists only for that command. It mirrors `createAuth` plus the
 * Dodo Payments plugin — which contributes a `dodoCustomerId` column to `user`
 * and so must be present at generation time even though it is optional at
 * runtime. Keep the plugin list in step with `auth.ts` and `billing/index.ts`;
 * if they drift, regenerate rather than editing the output by hand, because
 * the generator overwrites that file wholesale.
 */
import DodoPayments from "dodopayments";
import { dodopayments } from "@dodopayments/better-auth";
import { checkout, portal, webhooks } from "@dodopayments/better-auth";
import { createDb } from "@repo/db";

import { buildAccountsConfig } from "./config.js";
import { createAuth } from "./auth.js";

const config = buildAccountsConfig({
  ...process.env,
  DATABASE_URL: ":memory:",
});

export const auth: unknown = createAuth({
  db: createDb({ url: ":memory:" }),
  config,
  plugins: [
    dodopayments({
      client: new DodoPayments({
        bearerToken: "generate-only",
        environment: "test_mode",
      }),
      createCustomerOnSignUp: true,
      use: [checkout(), portal(), webhooks({ webhookKey: "generate-only" })],
    }),
  ],
});
