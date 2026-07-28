import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";

import { createDb, migrate, servers, subscriptions, user } from "./index.js";

/**
 * These tests exist for one reason: a migration that does not apply is
 * indistinguishable from a working build until the first sign-in fails with
 * `no such table: user`, in production, at boot. Applying them to a fresh
 * in-memory database on every run turns that into a red test.
 */
function fresh() {
  const db = createDb({ url: ":memory:" });
  migrate(db);
  return db;
}

async function makeUser(db: ReturnType<typeof fresh>, id = "u1") {
  await db.insert(user).values({
    id,
    name: "Test",
    email: `${id}@example.com`,
    emailVerified: false,
  });
  return id;
}

describe("migrations", () => {
  it("apply cleanly to an empty database", () => {
    expect(() => fresh()).not.toThrow();
  });

  it("are idempotent — a second run is a no-op", () => {
    const db = createDb({ url: ":memory:" });
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it("creates every table the broker reads on the hot path", async () => {
    const db = fresh();
    const names = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const tables = new Set(names.map((row) => row.name));

    for (const table of [
      "user",
      "session",
      "account",
      "verification",
      "device_code",
      "servers",
      "server_devices",
      "subscriptions",
      "tunnel_usage",
      "webhook_events",
    ]) {
      expect(tables).toContain(table);
    }
  });
});

describe("schema behaviour", () => {
  it("round-trips a server", async () => {
    const db = fresh();
    const userId = await makeUser(db);

    await db.insert(servers).values({
      id: "srv1",
      userId,
      name: "laptop",
      slug: "laptop",
      publicKey: "ab".repeat(32),
    });

    const [row] = await db.select().from(servers).where(eq(servers.id, "srv1"));
    expect(row?.name).toBe("laptop");
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  /**
   * A server is identified by its machine key, not its name. Two rows sharing
   * one key would make "which machine am I talking to" unanswerable, and would
   * let a reinstall silently fork into a second registry entry.
   */
  it("refuses two servers with the same public key", async () => {
    const db = fresh();
    const userId = await makeUser(db);
    const key = "cd".repeat(32);

    await db.insert(servers).values({
      id: "srv1",
      userId,
      name: "a",
      slug: "a",
      publicKey: key,
    });

    await expect(
      db.insert(servers).values({
        id: "srv2",
        userId,
        name: "b",
        slug: "b",
        publicKey: key,
      }),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("refuses two servers with the same slug for one user", async () => {
    const db = fresh();
    const userId = await makeUser(db);

    await db.insert(servers).values({
      id: "srv1",
      userId,
      name: "box",
      slug: "box",
      publicKey: "11".repeat(32),
    });

    await expect(
      db.insert(servers).values({
        id: "srv2",
        userId,
        name: "box",
        slug: "box",
        publicKey: "22".repeat(32),
      }),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("allows two users to name a server the same thing", async () => {
    const db = fresh();
    await makeUser(db, "u1");
    await makeUser(db, "u2");

    await db.insert(servers).values({
      id: "s1",
      userId: "u1",
      name: "box",
      slug: "box",
      publicKey: "33".repeat(32),
    });
    await expect(
      db.insert(servers).values({
        id: "s2",
        userId: "u2",
        name: "box",
        slug: "box",
        publicKey: "44".repeat(32),
      }),
    ).resolves.toBeDefined();
  });

  /**
   * SQLite ignores foreign keys unless `foreign_keys = ON`, which makes every
   * `onDelete: "cascade"` a silent no-op. This is the test that catches the
   * pragma going missing.
   */
  it("cascades a deleted user to their servers and subscription", async () => {
    const db = fresh();
    const userId = await makeUser(db);

    await db.insert(servers).values({
      id: "srv1",
      userId,
      name: "laptop",
      slug: "laptop",
      publicKey: "55".repeat(32),
    });
    await db.insert(subscriptions).values({ id: "sub1", userId, plan: "pro" });

    await db.delete(user).where(eq(user.id, userId));

    expect(await db.select().from(servers)).toHaveLength(0);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it("defaults a new subscription to the free plan", async () => {
    const db = fresh();
    const userId = await makeUser(db);
    await db.insert(subscriptions).values({ id: "sub1", userId });

    const [row] = await db.select().from(subscriptions);
    expect(row?.plan).toBe("free");
    expect(row?.status).toBe("none");
    expect(row?.cancelAtPeriodEnd).toBe(false);
  });
});
