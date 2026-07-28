import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  migrate,
  serverDevices,
  servers,
  tunnelUsage,
  user,
  type Db,
} from "@repo/db";
import { PLANS } from "@repo/config/plans";

import { createEntitlements, dayKey, monthKey } from "./entitlements.js";
import { mirrorSubscription } from "./billing/subscriptions.js";

const USER = "usr_test";

async function seed(): Promise<Db> {
  const db = createDb({ url: ":memory:" });
  migrate(db);
  await db.insert(user).values({
    id: USER,
    name: "Test",
    email: "test@example.com",
    updatedAt: new Date(),
  });
  return db;
}

describe("entitlements", () => {
  let db: Db;
  let entitlements: ReturnType<typeof createEntitlements>;

  beforeEach(async () => {
    db = await seed();
    entitlements = createEntitlements(db);
  });

  it("always allows an anonymous tunnel", async () => {
    // The load-bearing case. An unauthenticated or self-hosted install has no
    // account and must never be gated on one.
    expect(await entitlements.checkTunnel(null)).toEqual({ allowed: true });
  });

  it("allows a free account under its monthly allowance", async () => {
    await entitlements.recordUsage(USER, 1024 ** 3, 600);
    expect(await entitlements.checkTunnel(USER)).toEqual({ allowed: true });
  });

  it("refuses once the monthly allowance is spent", async () => {
    await entitlements.recordUsage(USER, PLANS.free.monthlyBytes ?? 0, 60);
    const decision = await entitlements.checkTunnel(USER);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("5 GB");
    // The refusal must not read as "you are cut off" — the local and LAN
    // paths never touch the broker at all.
    expect(decision.reason).toContain("Local and LAN");
  });

  it("lifts the ceiling on Pro", async () => {
    await entitlements.recordUsage(USER, PLANS.free.monthlyBytes ?? 0, 60);
    expect((await entitlements.checkTunnel(USER)).allowed).toBe(false);

    await mirrorSubscription(db, {
      userId: USER,
      status: "active",
      plan: "pro",
    });
    expect(await entitlements.planFor(USER)).toBe("pro");
    expect((await entitlements.checkTunnel(USER)).allowed).toBe(true);
  });

  it("accumulates into one row per day rather than one per session", async () => {
    await entitlements.recordUsage(USER, 100, 10);
    await entitlements.recordUsage(USER, 250, 20);

    const rows = await db
      .select()
      .from(tunnelUsage)
      .where(eq(tunnelUsage.userId, USER));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: dayKey(),
      bytes: 350,
      seconds: 30,
      sessions: 2,
    });
    // Nothing that identifies a peer, a mailbox or an address is stored.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "bytes",
      "day",
      "id",
      "seconds",
      "sessions",
      "updatedAt",
      "userId",
    ]);
  });

  it("reports the month's usage", async () => {
    await entitlements.recordUsage(USER, 42, 7);
    expect(await entitlements.usageThisMonth(USER)).toEqual({
      month: monthKey(),
      bytes: 42,
      seconds: 7,
      sessions: 1,
    });
  });

  it("ignores a zero-byte, zero-second session", async () => {
    await entitlements.recordUsage(USER, 0, 0);
    expect((await entitlements.usageThisMonth(USER)).sessions).toBe(0);
  });

  it("counts servers against the plan", async () => {
    expect((await entitlements.checkServerLimit(USER)).allowed).toBe(true);

    await db.insert(servers).values({
      id: "srv_1",
      userId: USER,
      name: "one",
      slug: "one",
      publicKey: "a".repeat(64),
    });

    const decision = await entitlements.checkServerLimit(USER);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("1 server");

    await mirrorSubscription(db, {
      userId: USER,
      status: "active",
      plan: "pro",
    });
    expect((await entitlements.checkServerLimit(USER)).allowed).toBe(true);
  });

  it("caps trusted browsers per server, ignoring revoked ones", async () => {
    await db.insert(servers).values({
      id: "srv_1",
      userId: USER,
      name: "one",
      slug: "one",
      publicKey: "a".repeat(64),
    });

    const limit = PLANS.free.devicesPerServer ?? 0;
    for (let i = 0; i < limit; i++) {
      await db.insert(serverDevices).values({
        id: `dev_${i}`,
        serverId: "srv_1",
        publicKey: `${i}`.repeat(64),
      });
    }
    expect((await entitlements.checkDevice("srv_1", "free")).allowed).toBe(
      false,
    );

    // Revoking one frees a slot: a lost phone should not permanently consume
    // the allowance, but its row stays so the history is answerable.
    await db
      .update(serverDevices)
      .set({ revokedAt: new Date() })
      .where(eq(serverDevices.id, "dev_0"));
    expect((await entitlements.checkDevice("srv_1", "free")).allowed).toBe(
      true,
    );
    expect((await entitlements.checkDevice("srv_1", "pro")).allowed).toBe(true);
  });

  it("makes renaming a Pro feature", () => {
    expect(entitlements.checkRename("free").allowed).toBe(false);
    expect(entitlements.checkRename("pro").allowed).toBe(true);
  });

  it("reads the session cap from the plan table rather than inventing one", () => {
    expect(entitlements.tunnelMinutesFor("free")).toBe(
      PLANS.free.tunnelMinutes,
    );
    expect(entitlements.tunnelMinutesFor("pro")).toBe(PLANS.pro.tunnelMinutes);
  });
});
