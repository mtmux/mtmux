/**
 * The server registry — what turns "one machine, one code" into "all my
 * machines, one dashboard".
 *
 * A row here is created when a logged-in `mtmux start` announces itself. It is
 * deliberately thin: enough to *find* and *name* a machine, and nothing that
 * would let us reach into it. Reaching in still requires the sealed pairing,
 * which is negotiated end-to-end and which this database never sees a key for.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth.js";

const now = sql`(unixepoch() * 1000)`;

export const servers = sqliteTable(
  "servers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** Human label, editable from the dashboard. */
    name: text("name").notNull(),
    /** URL-safe form of `name`, unique per user. */
    slug: text("slug").notNull(),

    /**
     * The machine's long-lived Ed25519 identity, hex-encoded.
     *
     * This is the anchor for everything: it is how a returning `mtmux start`
     * proves it is the same machine rather than a new one, and it is the key a
     * browser verifies against when reconnecting without a pairing code. It is
     * globally unique because two accounts claiming one identity would make
     * "which machine am I talking to" unanswerable.
     */
    publicKey: text("public_key").notNull(),

    hostname: text("hostname"),
    platform: text("platform"),
    cliVersion: text("cli_version"),

    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    uniqueIndex("servers_public_key_idx").on(t.publicKey),
    uniqueIndex("servers_user_slug_idx").on(t.userId, t.slug),
    index("servers_user_idx").on(t.userId),
  ],
);

/**
 * Browsers a server has agreed to trust, so the six-digit code is needed once
 * per device rather than once per connection.
 *
 * Revocation is a timestamp rather than a delete: "this phone was trusted until
 * Tuesday" is a question a user will ask after losing a phone, and a deleted
 * row cannot answer it.
 */
export const serverDevices = sqliteTable(
  "server_devices",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),

    /** The browser's Ed25519 identity, hex-encoded. */
    publicKey: text("public_key").notNull(),
    /** e.g. "iPhone · Safari" — set by the browser, shown in the UI. */
    label: text("label"),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("server_devices_server_key_idx").on(t.serverId, t.publicKey),
    index("server_devices_server_idx").on(t.serverId),
  ],
);
