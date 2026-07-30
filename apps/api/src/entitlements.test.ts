import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  migrate,
  serverDevices,
  servers,
  subscriptions,
  tunnelUsage,
  user,
  type Db,
} from "@repo/db";
import { PLANS, TRIAL_MS } from "@repo/config/plans";

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

/**
 * Put the account in the "already had its trial, and it is over" state.
 *
 * Most of the refusal tests below need this now: without it the first refusal
 * is not a refusal at all, it is the moment the trial starts. That is the
 * product working, so the tests say so explicitly rather than being weakened.
 */
async function spendTrial(db: Db, userId = USER): Promise<void> {
  const started = new Date(Date.now() - TRIAL_MS * 2);
  const ended = new Date(Date.now() - TRIAL_MS);
  await db
    .insert(subscriptions)
    .values({
      id: `sub_${userId}`,
      userId,
      trialStartedAt: started,
      trialEndsAt: ended,
    })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: { trialStartedAt: started, trialEndsAt: ended },
    });
}

async function trialRow(db: Db, userId = USER) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  return rows[0] ?? null;
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

  it("refuses once the monthly allowance is spent and the trial is over", async () => {
    await spendTrial(db);
    await entitlements.recordUsage(USER, PLANS.free.monthlyBytes ?? 0, 60);
    const decision = await entitlements.checkTunnel(USER);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("5 GB");
    // The refusal must not read as "you are cut off" — the local and LAN
    // paths never touch the broker at all.
    expect(decision.reason).toContain("Local and LAN");
  });

  it("lifts the ceiling on Pro", async () => {
    await spendTrial(db);
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
    await spendTrial(db);
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
    await spendTrial(db);
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
    expect(
      (await entitlements.checkDevice(USER, "srv_1", "free")).allowed,
    ).toBe(false);

    // Revoking one frees a slot: a lost phone should not permanently consume
    // the allowance, but its row stays so the history is answerable.
    await db
      .update(serverDevices)
      .set({ revokedAt: new Date() })
      .where(eq(serverDevices.id, "dev_0"));
    expect(
      (await entitlements.checkDevice(USER, "srv_1", "free")).allowed,
    ).toBe(true);
    expect((await entitlements.checkDevice(USER, "srv_1", "pro")).allowed).toBe(
      true,
    );
  });

  it("makes renaming a Pro feature", async () => {
    await spendTrial(db);
    expect((await entitlements.checkRename(USER, "free")).allowed).toBe(false);
    expect((await entitlements.checkRename(USER, "pro")).allowed).toBe(true);
  });

  it("reads the session cap from the plan table rather than inventing one", () => {
    expect(entitlements.tunnelMinutesFor("free")).toBe(
      PLANS.free.tunnelMinutes,
    );
    expect(entitlements.tunnelMinutesFor("pro")).toBe(PLANS.pro.tunnelMinutes);
  });

  describe("the free trial", () => {
    async function addServer(id: string): Promise<void> {
      await db.insert(servers).values({
        id,
        userId: USER,
        name: id,
        slug: id,
        publicKey: id.padEnd(64, "0"),
      });
    }

    it("does not start on the first server, because free allows one", async () => {
      // The whole point of starting the trial at the moment of refusal: a
      // single-server user should never silently burn theirs.
      expect((await entitlements.checkServerLimit(USER)).allowed).toBe(true);
      expect(await trialRow(db)).toBeNull();
    });

    it("starts on the second server and allows it", async () => {
      await addServer("srv_1");

      const decision = await entitlements.checkServerLimit(USER);
      expect(decision.allowed).toBe(true);
      expect(decision.trialStarted).toBe(true);

      const row = await trialRow(db);
      expect(row?.trialStartedAt).toBeInstanceOf(Date);
      expect(await entitlements.planFor(USER)).toBe("pro");
    });

    it("leaves trial_started_at untouched when called twice", async () => {
      // Pins the `setWhere` clause on the upsert. Without it, every later
      // refusal would silently hand out another seven days.
      const started = await entitlements.startTrial(USER, 1_000);
      expect(started).toBe(true);
      const first = await trialRow(db);

      const again = await entitlements.startTrial(USER, 9_999_999);
      expect(again).toBe(false);

      const second = await trialRow(db);
      expect(second?.trialStartedAt?.getTime()).toBe(
        first?.trialStartedAt?.getTime(),
      );
      expect(second?.trialEndsAt?.getTime()).toBe(
        first?.trialEndsAt?.getTime(),
      );
    });

    it("never starts for an anonymous tunnel", async () => {
      // Invariant #5. A null user must not reach the database at all, let
      // alone acquire a trial — there is no account to attach one to.
      expect(await entitlements.checkTunnel(null)).toEqual({ allowed: true });
      expect(await trialRow(db)).toBeNull();
    });

    it("never restarts after it has expired", async () => {
      await spendTrial(db);
      await addServer("srv_1");

      const decision = await entitlements.checkServerLimit(USER);
      expect(decision.allowed).toBe(false);
      expect(decision.trialStarted).toBeUndefined();
      expect(await entitlements.planFor(USER)).toBe("free");
    });

    it("does not start when the trial plan would refuse anyway", async () => {
      // Over even Pro's byte cap. A trial cannot fix this refusal, so
      // consuming one to discover that would spend the benefit for nothing.
      // The account has never trialled here — that is the point.
      await entitlements.recordUsage(
        USER,
        (PLANS.pro.monthlyBytes ?? 0) + 1,
        1,
      );

      const decision = await entitlements.checkTunnel(USER);
      expect(decision.allowed).toBe(false);
      expect(await trialRow(db)).toBeNull();
    });

    it("expires at exactly its end, and downgrades softly", async () => {
      // The product decision, encoded: existing things keep working after a
      // trial ends, only *new* ones refuse. Every gate is on the add path, so
      // this is what happens with no expiry code written at all.
      await entitlements.startTrial(USER, 0);
      await addServer("srv_1");
      await addServer("srv_2");

      const during = await entitlements.resolveFor(USER, TRIAL_MS - 1);
      expect(during.plan).toBe("pro");
      expect(during.source).toBe("trial");

      const after = await entitlements.resolveFor(USER, TRIAL_MS);
      expect(after.plan).toBe("free");
      expect(after.trial.status).toBe("expired");

      // Over cap now, so a third server refuses...
      expect((await entitlements.checkServerLimit(USER)).allowed).toBe(false);
      // ...while the two they already have are untouched.
      const rows = await db
        .select()
        .from(servers)
        .where(eq(servers.userId, USER));
      expect(rows).toHaveLength(2);
    });

    it("survives a subscription mirror write", async () => {
      // `mirrorSubscription` omits the trial columns from its `set` clause,
      // which is correct but fragile — a webhook must never be able to reset
      // or extend somebody's trial. Pinned here so adding a column to that
      // upsert without thinking is a failing test.
      await entitlements.startTrial(USER, 5_000);
      const before = await trialRow(db);

      await mirrorSubscription(db, {
        userId: USER,
        status: "active",
        plan: "pro",
      });

      const after = await trialRow(db);
      expect(after?.trialStartedAt?.getTime()).toBe(
        before?.trialStartedAt?.getTime(),
      );
      expect(after?.trialEndsAt?.getTime()).toBe(
        before?.trialEndsAt?.getTime(),
      );
      expect(after?.plan).toBe("pro");
    });
  });
});
