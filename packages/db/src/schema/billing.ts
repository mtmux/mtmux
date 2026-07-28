/**
 * Billing state and the usage counters that entitlements are checked against.
 *
 * Dodo is the source of truth for *money*; this table is a local mirror so that
 * an entitlement check is a single indexed read rather than a network call on
 * the hot path of opening a tunnel. Webhooks keep it fresh, and a reconcile can
 * always rebuild it from Dodo.
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

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    dodoCustomerId: text("dodo_customer_id"),
    dodoSubscriptionId: text("dodo_subscription_id"),
    productId: text("product_id"),

    /** Dodo's own status string, stored verbatim for support questions. */
    status: text("status").notNull().default("none"),
    /** The entitlement we actually branch on: "free" | "pro". */
    plan: text("plan").notNull().default("free"),

    currentPeriodEnd: integer("current_period_end", { mode: "timestamp_ms" }),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    uniqueIndex("subscriptions_user_idx").on(t.userId),
    index("subscriptions_dodo_sub_idx").on(t.dodoSubscriptionId),
  ],
);

/**
 * Daily rollups of tunnel usage.
 *
 * Deliberately aggregate. There is no row per connection, no IP, no mailbox id,
 * no peer — a breach or a subpoena here yields "this account moved 40 MB on
 * Tuesday" and nothing about who they talked to or what was said. That is the
 * most granular thing we are willing to know.
 */
export const tunnelUsage = sqliteTable(
  "tunnel_usage",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** UTC `YYYY-MM-DD`. Text, so a day is comparable without date maths. */
    day: text("day").notNull(),

    bytes: integer("bytes").notNull().default(0),
    seconds: integer("seconds").notNull().default(0),
    sessions: integer("sessions").notNull().default(0),

    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    uniqueIndex("tunnel_usage_user_day_idx").on(t.userId, t.day),
    index("tunnel_usage_day_idx").on(t.day),
  ],
);

/**
 * Seen webhook ids, for idempotency.
 *
 * Dodo retries on any non-2xx, and a retried "subscription.active" that we
 * process twice is harmless — but a retried cancellation racing a re-subscribe
 * is not. Recording the id and ignoring repeats makes delivery order the only
 * thing we have to reason about.
 */
export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: integer("received_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});
