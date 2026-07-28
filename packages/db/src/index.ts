/**
 * The broker's database handle.
 *
 * SQLite, deliberately. The broker runs as a single fork-mode process because
 * it holds mailboxes, claims and live tunnel sockets in memory — a second
 * worker would route a browser to a process that has never heard of its
 * pairing. Given one process, an embedded file database removes a network hop,
 * a daemon to supervise, and a class of connection-pool failures, and it is not
 * close to being the bottleneck: the hot path here is one indexed read per
 * tunnel open.
 *
 * If the broker ever needs to be more than one process, this is the seam that
 * has to change, and Drizzle's dialect split makes that a mechanical port.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate as runMigrations } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as schema from "./schema/index.js";

export * from "./schema/index.js";
export { schema };

export type Db = ReturnType<typeof createDb>;

export type CreateDbOptions = {
  /** Path to the SQLite file. `:memory:` is honoured, and is what tests use. */
  url: string;
};

export function createDb({ url }: CreateDbOptions) {
  if (url !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(url)), { recursive: true });
  }

  const sqlite = new Database(url);

  // WAL lets readers proceed during a write, which matters here because the
  // webhook handler and an entitlement check can genuinely overlap.
  sqlite.pragma("journal_mode = WAL");
  // Without this, a concurrent write fails instantly with SQLITE_BUSY rather
  // than waiting the few milliseconds the other transaction needs.
  sqlite.pragma("busy_timeout = 5000");
  // Drizzle emits foreign keys, but SQLite ignores them unless asked — and a
  // silently-unenforced `onDelete: "cascade"` would leave orphaned servers
  // behind every deleted account.
  sqlite.pragma("foreign_keys = ON");

  return drizzle(sqlite, { schema });
}

/**
 * Bring a database up to date, then hand it back.
 *
 * Migrations run at boot rather than as a deploy step because the broker ships
 * as one process that owns its own file: there is no window in which a new
 * binary and an old schema are both live, so the usual argument for separating
 * them does not apply. A failure here should stop the boot — serving with a
 * half-migrated schema is worse than not serving.
 */
export function migrate(db: Db, migrationsFolder = findMigrations()): void {
  runMigrations(db, { migrationsFolder });
}

/**
 * Locate `drizzle/`, which is harder than it looks.
 *
 * Running from source — tsx, vitest, `pnpm dev` — this module sits in
 * `packages/db/src`, so the folder is one level up. But `apps/api` ships as an
 * esbuild bundle that *inlines* workspace packages (they are published as raw
 * TypeScript, which Node cannot execute), and in that build `import.meta.url`
 * is `apps/api/dist/index.js` — where `../drizzle` does not exist and never
 * will. So the bundled case is resolved separately, through the package's own
 * `package.json`, which the module graph still points at even after inlining.
 *
 * Failing loudly matters more than usual here: a missing migrations folder
 * would otherwise surface as `no such table: user` on the first sign-in.
 */
function findMigrations(): string {
  const candidates: string[] = [];

  if (process.env.MTMUX_MIGRATIONS_DIR) {
    candidates.push(path.resolve(process.env.MTMUX_MIGRATIONS_DIR));
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(path.resolve(here, "../drizzle"));

  try {
    const pkg = createRequire(import.meta.url).resolve("@repo/db/package.json");
    candidates.push(path.resolve(path.dirname(pkg), "drizzle"));
  } catch {
    // Not resolvable from here — the source-relative candidate is the answer.
  }

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find the drizzle migrations folder. Looked in:\n` +
      candidates.map((c) => `  - ${c}`).join("\n") +
      `\nRun \`pnpm --filter @repo/db generate\`, or set MTMUX_MIGRATIONS_DIR.`,
  );
}
