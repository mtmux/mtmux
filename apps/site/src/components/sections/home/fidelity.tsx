import {
  Command,
  Palette,
  RotateCcw,
  Search,
  SquareStack,
  Zap,
} from "lucide-react";
import { getTranslations } from "next-intl/server";

import { FeatureCard } from "@/components/primitives/cards";
import { SectionHeading, Section } from "@/components/primitives/section";
import { Link } from "@/i18n/navigation";

const ICONS = [Command, SquareStack, Palette, Search, RotateCcw, Zap];

export async function Fidelity() {
  const t = await getTranslations("home.fidelity");
  const features = t.raw("features") as Array<{
    title: string;
    description: string;
  }>;

  return (
    <Section tone="raised">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-5 sm:mb-12">
        <SectionHeading
          eyebrow={t("eyebrow")}
          title={t("title")}
          description={t("description")}
          level={2}
          size="md"
          className="mb-0"
        />
        <Link
          href="/features"
          className="text-[0.90625rem] text-brand underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand"
        >
          {t("allFeatures")} →
        </Link>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(15.9375rem,100%),1fr))] gap-3.5">
        {features.map((feature, index) => {
          const Icon = ICONS[index % ICONS.length];
          return (
            <FeatureCard
              key={feature.title}
              icon={<Icon aria-hidden="true" />}
              title={feature.title}
              className="bg-surface-base"
            >
              {feature.description}
            </FeatureCard>
          );
        })}
      </div>
    </Section>
  );
}
