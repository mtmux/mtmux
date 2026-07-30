/**
 * `resolvePlan` is the only place a trial can grant Pro, so it is tested as a
 * table rather than through fixtures. It is pure and takes `now`, which is
 * what makes every expiry case reachable without a clock or a database.
 */
import { describe, expect, it } from "vitest";
import { TRIAL_MS } from "@repo/config/plans";

import { resolvePlan, type ResolvableSubscription } from "./subscriptions.js";

const T0 = 1_700_000_000_000;

type Case = {
  name: string;
  row: ResolvableSubscription;
  now: number;
  plan: "free" | "pro";
  source: "free" | "trial" | "paid";
  status: "none" | "active" | "expired";
};

const CASES: Case[] = [
  {
    name: "no row at all — a fresh account",
    row: null,
    now: T0,
    plan: "free",
    source: "free",
    status: "none",
  },
  {
    name: "a row with nothing on it",
    row: { plan: "free" },
    now: T0,
    plan: "free",
    source: "free",
    status: "none",
  },
  {
    name: "an active trial",
    row: { plan: "free", trialStartedAt: T0, trialEndsAt: T0 + TRIAL_MS },
    now: T0 + 1,
    plan: "pro",
    source: "trial",
    status: "active",
  },
  {
    name: "the last millisecond of a trial",
    row: { plan: "free", trialStartedAt: T0, trialEndsAt: T0 + TRIAL_MS },
    now: T0 + TRIAL_MS - 1,
    plan: "pro",
    source: "trial",
    status: "active",
  },
  {
    // The boundary, spelled out: `endsAt` is exclusive. At exactly the end the
    // trial is over. Off-by-one here is a day of free Pro or a day stolen.
    name: "exactly the instant a trial ends",
    row: { plan: "free", trialStartedAt: T0, trialEndsAt: T0 + TRIAL_MS },
    now: T0 + TRIAL_MS,
    plan: "free",
    source: "free",
    status: "expired",
  },
  {
    name: "long after a trial ended",
    row: { plan: "free", trialStartedAt: T0, trialEndsAt: T0 + TRIAL_MS },
    now: T0 + TRIAL_MS * 100,
    plan: "free",
    source: "free",
    status: "expired",
  },
  {
    // Paid wins outright. Someone who upgrades mid-trial is a customer, and
    // should not be shown "3 days left" beside a charge they have paid.
    name: "paid, during a trial",
    row: { plan: "pro", trialStartedAt: T0, trialEndsAt: T0 + TRIAL_MS },
    now: T0 + 1,
    plan: "pro",
    source: "paid",
    status: "active",
  },
  {
    name: "paid, after the trial ended",
    row: { plan: "pro", trialStartedAt: T0, trialEndsAt: T0 + TRIAL_MS },
    now: T0 + TRIAL_MS * 2,
    plan: "pro",
    source: "paid",
    status: "expired",
  },
  {
    // A start with no end is a corrupt row. Treating it as an unbounded trial
    // would be a free Pro account forever, so it reads as spent.
    name: "a start date with no end date",
    row: { plan: "free", trialStartedAt: T0, trialEndsAt: null },
    now: T0 + 1,
    plan: "free",
    source: "free",
    status: "expired",
  },
  {
    // The mirror stores Dates; the API sometimes has millis. Both must resolve
    // identically or the dashboard and the broker disagree.
    name: "Date objects rather than millis",
    row: {
      plan: "free",
      trialStartedAt: new Date(T0),
      trialEndsAt: new Date(T0 + TRIAL_MS),
    },
    now: T0 + 1,
    plan: "pro",
    source: "trial",
    status: "active",
  },
];

describe("resolvePlan", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const result = resolvePlan(c.row, c.now);
      expect(result.plan).toBe(c.plan);
      expect(result.source).toBe(c.source);
      expect(result.trial.status).toBe(c.status);
    });
  }

  it("counts whole days left, rounded up", () => {
    const row = {
      plan: "free",
      trialStartedAt: T0,
      trialEndsAt: T0 + TRIAL_MS,
    };
    // Seven days minus a millisecond still reads as seven days left, because
    // "6 days left" on the day you started would look like a bug.
    expect(resolvePlan(row, T0).trial.daysLeft).toBe(7);
    expect(resolvePlan(row, T0 + TRIAL_MS - 1).trial.daysLeft).toBe(1);
  });

  it("reports zero days left once it is over", () => {
    const row = {
      plan: "free",
      trialStartedAt: T0,
      trialEndsAt: T0 + TRIAL_MS,
    };
    expect(resolvePlan(row, T0 + TRIAL_MS).trial.daysLeft).toBe(0);
  });

  it("keeps the trial's dates visible even when paid", () => {
    // The dashboard wants to say "your trial ended, you're on Pro" rather than
    // forgetting the trial ever happened.
    const result = resolvePlan(
      { plan: "pro", trialStartedAt: T0, trialEndsAt: T0 + TRIAL_MS },
      T0 + TRIAL_MS * 2,
    );
    expect(result.trial.startedAt).toBe(T0);
    expect(result.trial.endsAt).toBe(T0 + TRIAL_MS);
  });
});
