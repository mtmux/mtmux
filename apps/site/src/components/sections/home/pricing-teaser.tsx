import { getTranslations } from "next-intl/server";

import { Section, SectionHeading } from "@/components/primitives/section";
import { PRICING } from "@/config/plans";
import { cn } from "@/lib/utils";
import { Link } from "@/i18n/navigation";

type Tier = {
  name: string;
  note: string;
  features: string[];
  popular: boolean;
};

/**
 * Prices are read from `@/config/plans`, never typed into home.json, so the
 * teaser and /pricing can never quote two different numbers. That file mirrors
 * `packages/config/src/plans.ts`, which is what the broker enforces.
 */
const PRICE: Record<string, { amount: string; suffix: string }> = {
  Free: { amount: "$0", suffix: "" },
  Pro: { amount: `$${PRICING.pro.monthlyUsd}`, suffix: "/mo" },
};

export async function PricingTeaser() {
  const t = await getTranslations("home.pricing");
  const tiers = t.raw("tiers") as Tier[];

  return (
    <Section tone="base">
      <SectionHeading
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        level={2}
        size="sm"
        align="center"
        className="mx-auto mb-10 sm:mb-14"
      />

      <div className="mx-auto grid max-w-3xl grid-cols-[repeat(auto-fit,minmax(min(15.625rem,100%),1fr))] gap-3.5">
        {tiers.map((tier) => {
          const price = PRICE[tier.name] ?? { amount: "", suffix: "" };
          return (
            <div
              key={tier.name}
              className={cn(
                "relative rounded-xl border p-6",
                tier.popular
                  ? "border-line-strong bg-surface-panel"
                  : "border-line bg-surface-raised",
              )}
            >
              {tier.popular ? (
                <span className="absolute top-0 right-4 -translate-y-1/2 rounded-full bg-brand px-2.5 py-0.5 text-[0.71875rem] font-700 text-brand-contrast">
                  {t("popularBadge")}
                </span>
              ) : null}
              <p
                className={cn(
                  "mb-3 text-[0.90625rem]",
                  tier.popular ? "text-brand" : "text-text-subtle",
                )}
              >
                {tier.name}
              </p>
              <p className="font-display text-[1.8125rem] leading-[1.12] tracking-[-0.05em] text-text-strong">
                {price.amount}
                {price.suffix ? (
                  <span className="font-mono text-[1.09375rem] text-text-faint">
                    {price.suffix}
                  </span>
                ) : null}
              </p>
              <p className="mt-1 mb-5 text-[0.8125rem] text-text-faint">
                {tier.note}
              </p>
              <div className="grid gap-2.5 text-[0.875rem] text-text-muted">
                {tier.features.map((feature) => (
                  <span key={feature}>{feature}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6.5 text-center">
        <Link
          href="/pricing"
          className="text-[0.90625rem] text-brand underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand"
        >
          {t("fullComparison")} →
        </Link>
      </div>
    </Section>
  );
}
