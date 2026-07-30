"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@repo/ui/components/ui/badge";
import { Button } from "@repo/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/ui/card";
import { Skeleton } from "@repo/ui/components/ui/skeleton";
import { cn } from "@repo/ui/lib/utils";
import {
  PLANS,
  PRICING,
  limitsFor,
  type PlanId,
  type PlanLimits,
} from "@repo/config/plans";
import {
  AlertCircle,
  Check,
  CreditCard,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiFetch } from "@/lib/auth-client";
import { formatBytes, formatDate, toEpochMs } from "./format";

type Interval = "monthly" | "yearly";

type Billing = {
  plan: PlanId;
  /**
   * Why they are on that plan.
   *
   * Needed because `plan` alone stopped being enough to describe the account:
   * a trial resolves to "pro" so that every limit is Pro's, and rendering that
   * as "your subscription is active" would be a lie to someone who has never
   * entered a card.
   */
  planSource: "free" | "trial" | "paid";
  /** Whole days left on an active trial. Zero when there isn't one. */
  trialDaysLeft: number;
  trialEndsAt: number | null;
  /** Free accounts have no subscription at all, hence "none". */
  status: "none" | "active" | "trialing" | "on_hold" | "cancelled" | string;
  renewsAt: number | null;
  usage: { bytes: number; servers: number | null };
};

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; billing: Billing };

function pick(source: unknown, ...keys: string[]): unknown {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read the broker's billing payload defensively.
 *
 * The keys are accepted in a few spellings on purpose: this page must not go
 * blank because the API renamed `renewsAt` to `currentPeriodEnd`. The plan id
 * is the one field that is pinned, because everything downstream indexes
 * `PLANS` with it.
 */
function normalize(body: unknown): Billing {
  const subscription = pick(body, "subscription");
  const rawPlan = pick(body, "plan") ?? pick(subscription, "plan");
  const plan: PlanId = rawPlan === "pro" ? "pro" : "free";
  const status = String(
    pick(body, "status", "subscriptionStatus") ??
      pick(subscription, "status") ??
      (plan === "free" ? "none" : "active"),
  );
  const usage = pick(body, "usage");
  const trial = pick(body, "trial");
  const trialActive = pick(trial, "status") === "active";
  // Defaults to "paid" for a pro plan from an older broker that does not send
  // `planSource` yet, which is what the panel assumed before trials existed.
  const rawSource = pick(body, "planSource");
  const planSource: Billing["planSource"] =
    rawSource === "trial" || (rawSource === undefined && trialActive)
      ? "trial"
      : rawSource === "paid" || (rawSource === undefined && plan === "pro")
        ? "paid"
        : "free";

  return {
    plan,
    planSource,
    trialDaysLeft: num(pick(trial, "daysLeft")) ?? 0,
    trialEndsAt: toEpochMs(pick(trial, "endsAt")),
    status,
    renewsAt: toEpochMs(
      pick(body, "renewsAt", "renewalDate", "currentPeriodEnd", "renewsOn") ??
        pick(subscription, "renewsAt", "renewalDate", "currentPeriodEnd"),
    ),
    usage: {
      bytes:
        num(pick(usage, "bytes", "monthlyBytes", "relayedBytes")) ??
        num(pick(body, "usageBytes")) ??
        0,
      servers: num(pick(usage, "servers")) ?? num(pick(body, "servers")),
    },
  };
}

const ON_HOLD = new Set(["on_hold", "past_due", "unpaid"]);
const ENDED = new Set(["cancelled", "canceled", "expired", "none"]);

export function BillingPanel() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // Named `billingInterval` rather than `interval` so the setter does not shadow
  // the global `setInterval`.
  const [billingInterval, setBillingInterval] = useState<Interval>("monthly");
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);

  const refresh = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      setLoad({
        state: "ready",
        billing: normalize(await apiFetch("/v1/billing")),
      });
    } catch (error) {
      setLoad({
        state: "error",
        message:
          error instanceof ApiError
            ? error.message
            : "Could not load your plan.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Both money buttons end the same way: the broker returns a URL owned by the
   * payment provider and we hand the browser over. Nothing here ever touches a
   * card number.
   */
  async function handoff(kind: "checkout" | "portal") {
    setBusy(kind);
    try {
      const body = await apiFetch<{ url?: string }>(`/v1/billing/${kind}`, {
        method: "POST",
        json:
          kind === "checkout" ? { plan: "pro", interval: billingInterval } : {},
      });
      if (!body.url) {
        toast.error(
          "mtmux didn't return a billing link. Try again in a moment.",
        );
        return;
      }
      window.location.assign(body.url);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not open billing. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  if (load.state === "loading") return <BillingSkeleton />;

  if (load.state === "error") {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
        <AlertCircle className="mx-auto h-6 w-6 text-destructive" aria-hidden />
        <h2 className="mt-3 text-base font-medium text-foreground">
          Couldn&apos;t load your plan
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{load.message}</p>
        <Button
          variant="outline"
          className="mt-4 h-11"
          onClick={() => void refresh()}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    );
  }

  const { billing } = load;
  const limits = limitsFor(billing.plan);
  const onHold = ON_HOLD.has(billing.status);
  const trialing = billing.planSource === "trial";
  // A trial has no subscription behind it, so none of the subscription states
  // apply to it — without this guard `status: "none"` would render a trialing
  // account as "Ending".
  const ending =
    !trialing && ENDED.has(billing.status) && billing.plan === "pro";
  const isPro = billing.plan === "pro";
  // What the *buttons* key off. "Pro" is now reachable without ever having
  // paid, and someone on a trial has no Dodo customer to manage and every
  // reason to still be offered the upgrade.
  const paid = billing.planSource === "paid";

  return (
    <div className="space-y-4">
      {onHold && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-4"
        >
          <div className="flex items-start gap-3">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-destructive"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium text-foreground">
                Your last payment didn&apos;t go through
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Pro features are paused until it clears. Updating your payment
                method restores everything immediately — nothing has been
                deleted.
              </p>
              <Button
                className="mt-3 h-11 w-full sm:w-auto"
                onClick={() => void handoff("portal")}
                disabled={busy !== null}
              >
                {busy === "portal" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Opening…
                  </>
                ) : (
                  <>
                    <CreditCard className="h-4 w-4" aria-hidden />
                    Update payment method
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Current plan</CardTitle>
            <Badge variant={isPro ? "default" : "secondary"}>
              {isPro ? "Pro" : "Free"}
            </Badge>
            {trialing && <Badge variant="outline">Trial</Badge>}
            {onHold && <Badge variant="destructive">Payment failed</Badge>}
            {ending && <Badge variant="outline">Ending</Badge>}
          </div>
          <CardDescription>
            {trialing
              ? `${billing.trialDaysLeft} day${billing.trialDaysLeft === 1 ? "" : "s"} left on your free trial${
                  billing.trialEndsAt
                    ? `, until ${formatDate(billing.trialEndsAt)}`
                    : ""
                }. Nothing happens when it ends except that Pro limits go back to free ones — your machines and sessions keep working.`
              : isPro && billing.renewsAt && !ending
                ? `Renews on ${formatDate(billing.renewsAt)}.`
                : ending && billing.renewsAt
                  ? `Pro access continues until ${formatDate(billing.renewsAt)}.`
                  : isPro
                    ? "Your subscription is active."
                    : "You're on the free plan. No card, no expiry."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <UsageMeter
            label="Relayed data this month"
            used={billing.usage.bytes}
            limit={limits.monthlyBytes}
            format={formatBytes}
            hint="Only traffic that goes through mtmux's relay counts. Local and same-network connections are free."
          />
          {billing.usage.servers !== null && (
            <UsageMeter
              label="Registered machines"
              used={billing.usage.servers}
              limit={limits.servers}
              format={(n) => `${n}`}
            />
          )}

          {paid && (
            <Button
              variant="outline"
              className="h-11 w-full sm:w-auto"
              onClick={() => void handoff("portal")}
              disabled={busy !== null}
            >
              {busy === "portal" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Opening…
                </>
              ) : (
                <>
                  <CreditCard className="h-4 w-4" aria-hidden />
                  Manage billing
                </>
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      {!paid && (
        <Card className="border-primary/40">
          <CardHeader>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                <Sparkles className="h-4 w-4 text-primary" aria-hidden />
              </span>
              <CardTitle className="text-base">Upgrade to Pro</CardTitle>
            </div>
            <CardDescription>
              Unlimited machines, room to actually use the relay, and names that
              mean something to you.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5">
            <IntervalPicker
              value={billingInterval}
              onChange={setBillingInterval}
            />

            <p className="text-3xl font-semibold tracking-tight text-foreground">
              $
              {billingInterval === "monthly"
                ? PRICING.pro.monthlyUsd
                : PRICING.pro.yearlyUsd}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                {billingInterval === "monthly" ? "/month" : "/year"}
              </span>
            </p>

            <PlanComparison free={PLANS.free} pro={PLANS.pro} />

            <Button
              className="h-11 w-full"
              onClick={() => void handoff("checkout")}
              disabled={busy !== null}
            >
              {busy === "checkout" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Opening checkout…
                </>
              ) : (
                "Upgrade to Pro"
              )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Payment is handled by our payment provider. Cancel any time.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function IntervalPicker({
  value,
  onChange,
}: {
  value: Interval;
  onChange: (next: Interval) => void;
}) {
  const savings = PRICING.pro.monthlyUsd * 12 - PRICING.pro.yearlyUsd;
  const options: { id: Interval; label: string }[] = [
    { id: "monthly", label: "Monthly" },
    {
      id: "yearly",
      label: savings > 0 ? `Yearly · save $${savings}` : "Yearly",
    },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Billing interval"
      className="flex gap-1 rounded-lg bg-muted p-1"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "h-10 flex-1 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === option.id
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function UsageMeter({
  label,
  used,
  limit,
  format,
  hint,
}: {
  label: string;
  used: number;
  limit: number | null;
  format: (value: number) => string;
  hint?: string;
}) {
  const unlimited = limit === null;
  const ratio = unlimited ? 0 : Math.min(1, limit === 0 ? 1 : used / limit);
  const percent = Math.round(ratio * 100);
  const nearing = !unlimited && ratio >= 0.8;
  const over = !unlimited && ratio >= 1;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="font-mono text-sm text-muted-foreground tabular-nums">
          {format(used)}
          {unlimited ? (
            <span className="font-sans"> used</span>
          ) : (
            <>
              <span aria-hidden> / </span>
              <span className="sr-only"> of </span>
              {format(limit)}
            </>
          )}
        </span>
      </div>
      {!unlimited && (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={label}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              over ? "bg-destructive" : nearing ? "bg-warning" : "bg-primary",
            )}
            style={{ width: `${Math.max(percent, used > 0 ? 2 : 0)}%` }}
          />
        </div>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Free vs Pro, generated from the plan table rather than typed out, so a change
 * to `@repo/config/plans` cannot leave a stale promise on the pricing card.
 */
function PlanComparison({ free, pro }: { free: PlanLimits; pro: PlanLimits }) {
  const rows: { label: string; free: string; pro: string }[] = [
    {
      label: "Machines",
      free: countLabel(free.servers),
      pro: countLabel(pro.servers),
    },
    {
      label: "Relayed data / month",
      free:
        free.monthlyBytes === null
          ? "Unlimited"
          : formatBytes(free.monthlyBytes),
      pro:
        pro.monthlyBytes === null ? "Unlimited" : formatBytes(pro.monthlyBytes),
    },
    {
      label: "Trusted devices / machine",
      free: countLabel(free.devicesPerServer),
      pro: countLabel(pro.devicesPerServer),
    },
    {
      label: "Custom machine names",
      free: free.namedServers ? "Yes" : "No",
      pro: pro.namedServers ? "Yes" : "No",
    },
  ];

  return (
    <ul className="space-y-2 border-t border-border pt-4">
      {rows.map((row) => (
        <li key={row.label} className="flex items-baseline gap-3 text-sm">
          <Check
            className="h-4 w-4 shrink-0 translate-y-0.5 text-primary"
            aria-hidden
          />
          <span className="min-w-0 flex-1 text-muted-foreground">
            {row.label}
          </span>
          <span className="shrink-0 text-right text-muted-foreground/60 line-through">
            {row.free}
          </span>
          <span className="shrink-0 text-right font-medium text-foreground">
            {row.pro}
          </span>
        </li>
      ))}
    </ul>
  );
}

function countLabel(limit: number | null): string {
  return limit === null ? "Unlimited" : String(limit);
}

function BillingSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <Card>
        <CardHeader className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-52" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-11 w-full" />
        </CardContent>
      </Card>
      <span className="sr-only" role="status">
        Loading your plan
      </span>
    </div>
  );
}
