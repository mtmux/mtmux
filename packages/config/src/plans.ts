/**
 * What each plan is allowed to do.
 *
 * Every limit in the product lives here, in one table, for one reason: pricing
 * changes. "Is the tunnel free?" is a business decision that should be a diff
 * to this file and nothing else — not a hunt through the broker for a hard-coded
 * number. The enforcement code reads these; it never encodes a threshold itself.
 *
 * `null` means unlimited. That is deliberate rather than a sentinel like
 * `Infinity`, because these values are serialised to the client and JSON has no
 * `Infinity`.
 */

export type PlanId = "free" | "pro";

export type PlanLimits = {
  /** Registered servers the account may keep. */
  servers: number | null;
  /**
   * How long one tunnel session may stay open before the broker closes it.
   *
   * A cap here is survivable — the client reconnects and gets a fresh session —
   * so this is the dial to turn if the tunnel ever needs to become a paid
   * feature "based on duration" rather than a free one.
   */
  tunnelMinutes: number | null;
  /** Relayed traffic per calendar month, in bytes. */
  monthlyBytes: number | null;
  /** Trusted browsers per server. */
  devicesPerServer: number | null;
  /** Rename a server to something other than its hostname. */
  namedServers: boolean;
};

const GIB = 1024 ** 3;

export const PLANS: Record<PlanId, PlanLimits> = {
  /**
   * Free is generous on purpose.
   *
   * The thing that costs us money is relayed bytes, so that is what is metered.
   * Everything else is free because a limit there would only teach people the
   * tool is crippled — and the local and LAN paths never touch our
   * infrastructure at all, so they are unmetered by construction.
   */
  free: {
    servers: 1,
    tunnelMinutes: null,
    monthlyBytes: 5 * GIB,
    devicesPerServer: 3,
    namedServers: false,
  },
  pro: {
    servers: null,
    tunnelMinutes: null,
    monthlyBytes: 200 * GIB,
    devicesPerServer: null,
    namedServers: true,
  },
};

export const DEFAULT_PLAN: PlanId = "free";

/**
 * The free trial.
 *
 * Note what is *not* here: a `"trial"` entry in `PlanId`. A trial is a reason
 * an account resolves to a plan, not a tier of its own — which is exactly what
 * keeps `limitsFor`, `exceeds`, the billing panel and the site's pricing table
 * from needing to know it exists. Everything downstream sees "pro" and behaves
 * accordingly; only the resolution step knows why.
 */
export const TRIAL_DAYS = 7;
export const TRIAL_PLAN: PlanId = "pro";
export const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

export function limitsFor(plan: string | null | undefined): PlanLimits {
  return PLANS[(plan as PlanId) in PLANS ? (plan as PlanId) : DEFAULT_PLAN];
}

/**
 * True when a limit is exceeded. `null` limits are never exceeded.
 *
 * Written as a helper rather than inlined `<=` comparisons because the `null`
 * case is exactly the one a hand-written comparison gets wrong: `5 > null` is
 * `true` in JavaScript, so a naive check would report every unlimited plan as
 * over quota.
 */
export function exceeds(used: number, limit: number | null): boolean {
  return limit !== null && used >= limit;
}

/**
 * What the paid plan costs, for display only.
 *
 * The authoritative prices live in Dodo; these exist so the pricing page and
 * the CLI's upgrade prompt can render without a network call. If they drift
 * from Dodo, Dodo wins — and the checkout the user actually sees is Dodo's.
 */
export const PRICING = {
  pro: {
    monthlyUsd: 10,
    yearlyUsd: 100,
  },
} as const;
